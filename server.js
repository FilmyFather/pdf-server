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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-' + uuidv4().slice(0,8) + '-'));
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

    console.log(`Compressing: original=${originalSize}, target=${targetBytes}`);

    // Binary search on DPI: 150 to 600
    // Higher DPI = better quality = bigger file
    // We want the HIGHEST DPI that still fits under targetBytes
    let dpiLo = 150, dpiHi = 600;
    let bestOutput = null;
    let bestDiff = Infinity;

    for (let iter = 0; iter < 16; iter++) {
      const dpiMid = Math.round((dpiLo + dpiHi) / 2);
      const tmpOut = path.join(tmpDir, `out_${iter}.pdf`);

      try {
        const gsCmd = buildGsCmd(inputPath, tmpOut, dpiMid);
        execSync(gsCmd, { timeout: 30000 });

        const sz = fs.statSync(tmpOut).size;
        const diff = targetBytes - sz;

        console.log(`  iter=${iter} dpi=${dpiMid} size=${sz} diff=${diff}`);

        if (diff >= 0) {
          // Under target — valid
          if (diff < bestDiff) {
            bestDiff = diff;
            bestOutput = fs.readFileSync(tmpOut);
          }
          if (diff <= TOLERANCE) {
            console.log(`  Perfect at DPI=${dpiMid}, size=${sz}`);
            break;
          }
          // Too small — try higher DPI
          dpiLo = dpiMid + 1;
        } else {
          // Over target — try lower DPI
          dpiHi = dpiMid - 1;
        }
      } catch (e) {
        console.error(`  GS failed at DPI ${dpiMid}:`, e.message);
        dpiHi = dpiMid - 1;
      }

      if (dpiLo > dpiHi) break;
    }

    // If nothing found under target at DPI 150, go lower
    if (!bestOutput) {
      console.log('Going below 150 DPI...');
      for (const dpi of [120, 96, 72, 60, 48, 36]) {
        const tmpOut = path.join(tmpDir, `out_low_${dpi}.pdf`);
        try {
          execSync(buildGsCmd(inputPath, tmpOut, dpi), { timeout: 30000 });
          const sz = fs.statSync(tmpOut).size;
          const diff = targetBytes - sz;
          console.log(`  low dpi=${dpi} size=${sz}`);
          if (diff >= 0 && diff < bestDiff) {
            bestDiff = diff;
            bestOutput = fs.readFileSync(tmpOut);
            if (diff <= TOLERANCE) break;
          }
        } catch (e) { console.error(`low DPI ${dpi} failed:`, e.message); }
      }
    }

    if (!bestOutput) {
      return res.status(422).json({ error: 'Cannot compress to target size' });
    }

    console.log(`Final size: ${bestOutput.length} (target: ${targetBytes}, diff: ${targetBytes - bestOutput.length})`);

    res.json({
      success: true,
      pdfBase64: bestOutput.toString('base64'),
      originalSize,
      compressedSize: bestOutput.length,
    });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

function buildGsCmd(input, output, dpi) {
  // Choose quality setting based on DPI
  let setting;
  if (dpi >= 300) setting = '/printer';
  else if (dpi >= 150) setting = '/ebook';
  else setting = '/screen';

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
    '-dColorImageDownsampleType=/Bicubic',
    '-dDownsampleGrayImages=true',
    `-dGrayImageResolution=${dpi}`,
    '-dGrayImageDownsampleType=/Bicubic',
    '-dDownsampleMonoImages=true',
    `-dMonoImageResolution=${dpi}`,
    `-sOutputFile=${output}`,
    input,
  ].join(' ');
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Ghostscript: ${checkGS()}`);
});
