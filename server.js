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

// Multer for file uploads — store in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'PDF Compressor Server Running', ghostscript: checkGS() });
});

function checkGS() {
  try {
    execSync('gs --version', { timeout: 5000 });
    return 'available';
  } catch (e) {
    return 'not found';
  }
}

// ── COMPRESS ENDPOINT ──
app.post('/compress', upload.single('pdf'), async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-' + uuidv4().slice(0, 8) + '-'));
  const inputPath  = path.join(tmpDir, 'input.pdf');
  const outputPath = path.join(tmpDir, 'output.pdf');

  try {
    // Get PDF buffer — either from file upload or base64
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

    const TOLERANCE = 5 * 1024; // 5KB

    fs.writeFileSync(inputPath, pdfBuf);
    const originalSize = pdfBuf.length;

    // ── GHOSTSCRIPT BINARY SEARCH ──
    // We binary search on ImageResolution (DPI) to hit exact target
    // Higher DPI = better quality = bigger file
    // Lower DPI  = lower quality = smaller file

    let bestOutput = null;
    let bestDiff   = Infinity;

    // First try: strip metadata only (lossless)
    try {
      const gsCmd = buildGsCmd(inputPath, outputPath, '/prepress', 300);
      execSync(gsCmd, { timeout: 20000 });
      const sz = fs.statSync(outputPath).size;
      if (sz <= targetBytes) {
        const diff = targetBytes - sz;
        if (diff < bestDiff) {
          bestDiff = diff;
          bestOutput = fs.readFileSync(outputPath);
        }
        if (diff <= TOLERANCE) {
          return sendResult(res, bestOutput, originalSize);
        }
      }
    } catch (e) { /* continue */ }

    // Binary search on DPI: range 20–200
    let dpiLo = 20, dpiHi = 200;

    for (let iter = 0; iter < 16; iter++) {
      const dpiMid = Math.round((dpiLo + dpiHi) / 2);
      const setting = dpiMid > 150 ? '/ebook' : dpiMid > 100 ? '/screen' : '/screen';

      try {
        const tmpOut = path.join(tmpDir, `out_${dpiMid}.pdf`);
        const gsCmd  = buildGsCmd(inputPath, tmpOut, setting, dpiMid);
        execSync(gsCmd, { timeout: 25000 });

        const sz   = fs.statSync(tmpOut).size;
        const diff = targetBytes - sz;

        if (diff >= 0) {
          // Under or equal target — valid
          if (diff < bestDiff) {
            bestDiff   = diff;
            bestOutput = fs.readFileSync(tmpOut);
          }
          if (diff <= TOLERANCE) break; // Within 5KB — perfect!
          dpiLo = dpiMid + 1; // Try higher DPI (bigger file, closer to target)
        } else {
          // Over target — reduce DPI
          dpiHi = dpiMid - 1;
        }
      } catch (e) {
        console.error(`GS failed at DPI ${dpiMid}:`, e.message);
        dpiHi = dpiMid - 1;
      }

      if (dpiLo > dpiHi) break;
    }

    // Emergency: very low DPI
    if (!bestOutput) {
      for (const dpi of [15, 10, 8]) {
        try {
          const tmpOut = path.join(tmpDir, `emergency_${dpi}.pdf`);
          execSync(buildGsCmd(inputPath, tmpOut, '/screen', dpi), { timeout: 20000 });
          const sz = fs.statSync(tmpOut).size;
          if (sz <= targetBytes) {
            bestOutput = fs.readFileSync(tmpOut);
            break;
          }
        } catch (e) { /* continue */ }
      }
    }

    if (!bestOutput) {
      return res.status(422).json({ error: 'Cannot compress to target — PDF may already be very small' });
    }

    return sendResult(res, bestOutput, originalSize);

  } catch (err) {
    console.error('Compress error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

function buildGsCmd(input, output, setting, dpi) {
  return [
    'gs',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=${setting}`,
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dDownsampleColorImages=true',
    `-dColorImageResolution=${dpi}`,
    '-dDownsampleGrayImages=true',
    `-dGrayImageResolution=${dpi}`,
    '-dDownsampleMonoImages=true',
    `-dMonoImageResolution=${dpi}`,
    '-dColorImageDownsampleType=/Bicubic',
    '-dGrayImageDownsampleType=/Bicubic',
    `-sOutputFile=${output}`,
    input,
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
  console.log(`✅ PDF Compressor Server running on port ${PORT}`);
  console.log(`Ghostscript: ${checkGS()}`);
});
