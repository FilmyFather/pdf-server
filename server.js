const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.get('/', (req, res) => {
  res.json({ status: 'PDF Compressor Running', ghostscript: checkGS() });
});

function checkGS() {
  try { execSync('gs --version', { timeout: 5000 }); return 'available'; }
  catch (e) { return 'not found: ' + e.message; }
}

app.post('/compress', upload.single('pdf'), async (req, res) => {
  const id = uuidv4().slice(0, 8);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-' + id + '-'));
  const inputPath = path.join(tmpDir, 'input.pdf');

  try {
    let pdfBuf;
    if (req.file) {
      pdfBuf = req.file.buffer;
    } else if (req.body && req.body.pdfBase64) {
      pdfBuf = Buffer.from(req.body.pdfBase64, 'base64');
    } else {
      return res.status(400).json({ error: 'No PDF provided' });
    }

    const targetBytes = parseInt(req.body.targetBytes || req.query.targetBytes);
    if (!targetBytes || isNaN(targetBytes)) {
      return res.status(400).json({ error: 'No targetBytes provided' });
    }

    fs.writeFileSync(inputPath, pdfBuf);
    const originalSize = pdfBuf.length;
    const TOLERANCE = 5 * 1024; // 5KB

    console.log(`[${id}] original=${originalSize}, target=${targetBytes}`);

    // Step 1: Try lossless compression first
    const losslessOut = path.join(tmpDir, 'lossless.pdf');
    let bestOutput = null;
    let bestDiff = Infinity;

    try {
      execSync(gsLossless(inputPath, losslessOut), { timeout: 30000 });
      const sz = fs.statSync(losslessOut).size;
      const diff = targetBytes - sz;
      console.log(`[${id}] lossless size=${sz}, diff=${diff}`);
      if (diff >= 0) {
        bestOutput = fs.readFileSync(losslessOut);
        bestDiff = diff;
        if (diff <= TOLERANCE) {
          console.log(`[${id}] Perfect lossless!`);
          return sendResult(res, bestOutput, originalSize);
        }
      }
    } catch (e) {
      console.log(`[${id}] lossless failed:`, e.message);
    }

    // Step 2: PDF is text-based (size same at all DPIs)
    // Use ps2pdf with different compression levels via page rendering at fixed sizes
    // Strategy: render PDF as images at target size using GS raster output, then rebuild

    // Calculate what DPI we need to hit the target
    // target_size ≈ (width_px * height_px * pages * bytes_per_px_jpeg)
    // For A4 at 72dpi: 595*842 = ~500k pixels per page
    // JPEG at quality q: ~0.1-0.5 bytes/pixel

    // Get page count
    let pageCount = 1;
    try {
      const info = execSync(`gs -dNODISPLAY -dNOSAFER -q -c "(${inputPath}) (r) file runpdfbegin pdfpagecount = quit"`, { timeout: 10000 }).toString().trim();
      pageCount = parseInt(info) || 1;
    } catch (e) {
      console.log(`[${id}] Could not get page count, assuming 1`);
    }

    console.log(`[${id}] pages=${pageCount}`);

    // Binary search on JPEG quality for raster conversion
    // We render each page as JPEG and rebuild PDF
    let qLo = 1, qHi = 95;

    for (let iter = 0; iter < 14; iter++) {
      const qMid = Math.round((qLo + qHi) / 2);
      const rasterOut = path.join(tmpDir, `raster_${iter}.pdf`);

      try {
        // Render PDF pages as JPEG images and rebuild PDF
        // Use GS to convert to JPEG then back to PDF
        const dpi = 150; // Fixed DPI for text clarity
        const cmd = [
          'gs', '-dNOSAFER',
          '-dNOPAUSE', '-dBATCH', '-dQUIET',
          '-sDEVICE=pdfwrite',
          '-dCompatibilityLevel=1.4',
          `-dPDFSETTINGS=/screen`,
          '-dColorConversionStrategy=/sRGB',
          '-dDownsampleColorImages=true',
          `-dColorImageResolution=${dpi}`,
          '-dDownsampleGrayImages=true',
          `-dGrayImageResolution=${dpi}`,
          '-dDownsampleMonoImages=true',
          `-dMonoImageResolution=${dpi}`,
          `-dJPEGQ=${qMid}`,
          '-dColorImageFilter=/DCTEncode',
          '-dGrayImageFilter=/DCTEncode',
          `-sOutputFile=${rasterOut}`,
          inputPath,
        ].join(' ');

        execSync(cmd, { timeout: 30000 });
        const sz = fs.statSync(rasterOut).size;
        const diff = targetBytes - sz;
        console.log(`[${id}] iter=${iter} q=${qMid} size=${sz} diff=${diff}`);

        if (diff >= 0) {
          if (diff < bestDiff) {
            bestDiff = diff;
            bestOutput = fs.readFileSync(rasterOut);
          }
          if (diff <= TOLERANCE) break;
          qLo = qMid + 1; // Too small, raise quality
        } else {
          qHi = qMid - 1; // Too big, lower quality
        }
      } catch (e) {
        console.error(`[${id}] iter ${iter} failed:`, e.message);
        qHi = qMid - 1;
      }

      if (qLo > qHi) break;
    }

    // Step 3: If still nothing, force very low quality
    if (!bestOutput || bestDiff > TOLERANCE) {
      for (const q of [5, 3, 1]) {
        const out = path.join(tmpDir, `force_${q}.pdf`);
        try {
          const cmd = [
            'gs', '-dNOPAUSE', '-dBATCH', '-dQUIET',
            '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
            '-dPDFSETTINGS=/screen',
            `-dColorImageResolution=72`,
            `-dGrayImageResolution=72`,
            `-dJPEGQ=${q}`,
            `-sOutputFile=${out}`, inputPath,
          ].join(' ');
          execSync(cmd, { timeout: 30000 });
          const sz = fs.statSync(out).size;
          const diff = targetBytes - sz;
          console.log(`[${id}] force q=${q} size=${sz} diff=${diff}`);
          if (diff >= 0 && diff < bestDiff) {
            bestDiff = diff;
            bestOutput = fs.readFileSync(out);
            if (diff <= TOLERANCE) break;
          }
        } catch (e) { console.error(e.message); }
      }
    }

    if (!bestOutput) {
      return res.status(422).json({ error: 'Cannot compress to target size — PDF may be too small already' });
    }

    console.log(`[${id}] FINAL size=${bestOutput.length} target=${targetBytes} diff=${targetBytes - bestOutput.length}`);
    return sendResult(res, bestOutput, originalSize);

  } catch (err) {
    console.error(`[${id}] Error:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

function gsLossless(input, output) {
  return [
    'gs', '-dNOSAFER', '-dNOPAUSE', '-dBATCH', '-dQUIET',
    '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
    '-dPDFSETTINGS=/prepress',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true', '-dSubsetFonts=true',
    `-sOutputFile=${output}`, input,
  ].join(' ');
}

function sendResult(res, buf, originalSize) {
  res.json({
    success: true,
    pdfBase64: buf.toString('base64'),
    originalSize,
    compressedSize: buf.length,
  });
}

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  console.log(`Ghostscript: ${checkGS()}`);
});
