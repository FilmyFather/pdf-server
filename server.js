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
res.json({ status: 'PDF Compressor Running' });
});

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

```
const targetBytes = parseInt(req.body.targetBytes || req.query.targetBytes);
if (!targetBytes || isNaN(targetBytes)) {
  return res.status(400).json({ error: 'No targetBytes provided' });
}

fs.writeFileSync(inputPath, pdfBuf);
const originalSize = pdfBuf.length;

const TOLERANCE = 10 * 1024;
let bestOutput = null;
let bestDiff = Infinity;

console.log(`[${id}] START original=${originalSize}, target=${targetBytes}`);

// STEP 1: Lossless try
try {
  const losslessOut = path.join(tmpDir, 'lossless.pdf');

  execSync([
    'gs',
    '-dNOSAFER',
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dPDFSETTINGS=/prepress',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    `-sOutputFile=${losslessOut}`,
    inputPath
  ].join(' '), { timeout: 30000 });

  const sz = fs.statSync(losslessOut).size;
  const diff = targetBytes - sz;

  if (diff >= 0) {
    bestOutput = fs.readFileSync(losslessOut);
    bestDiff = diff;

    if (diff <= TOLERANCE) {
      return sendResult(res, bestOutput, originalSize);
    }
  }
} catch {}

// STEP 2: Smart compression
let qLo = 30, qHi = 95;
let dpi = 180;

for (let i = 0; i < 12; i++) {
  const qMid = Math.round((qLo + qHi) / 2);
  const out = path.join(tmpDir, `iter_${i}.pdf`);

  try {
    execSync([
      'gs',
      '-dNOSAFER',
      '-dNOPAUSE',
      '-dBATCH',
      '-dQUIET',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dPDFSETTINGS=/ebook',
      '-dColorConversionStrategy=/sRGB',

      '-dDownsampleColorImages=true',
      `-dColorImageResolution=${dpi}`,
      '-dColorImageFilter=/DCTEncode',

      '-dDownsampleGrayImages=true',
      `-dGrayImageResolution=${dpi}`,
      '-dGrayImageFilter=/DCTEncode',

      '-dDownsampleMonoImages=true',
      `-dMonoImageResolution=${dpi}`,

      `-dJPEGQ=${qMid}`,

      `-sOutputFile=${out}`,
      inputPath
    ].join(' '), { timeout: 30000 });

    const sz = fs.statSync(out).size;
    const diff = targetBytes - sz;

    console.log(`[${id}] iter=${i} dpi=${dpi} q=${qMid} size=${sz} diff=${diff}`);

    if (sz < targetBytes * 0.7) {
      dpi += 40;
      continue;
    }

    if (diff >= 0 && diff < bestDiff) {
      bestDiff = diff;
      bestOutput = fs.readFileSync(out);

      if (diff <= TOLERANCE) break;
    }

    if (diff > 200 * 1024) {
      dpi += 30;
      qLo = qMid + 1;
    } else if (diff < -200 * 1024) {
      dpi -= 25;
      qHi = qMid - 1;
    } else {
      if (diff >= 0) qLo = qMid + 1;
      else qHi = qMid - 1;
    }

    dpi = Math.max(72, Math.min(300, dpi));

  } catch {
    qHi = qMid - 1;
  }

  if (qLo > qHi) break;
}

// STEP 3: Final validation
if (!bestOutput) {
  return res.status(422).json({ error: 'Could not reach target size' });
}

if (bestOutput.length < targetBytes * 0.85) {
  return res.status(422).json({ error: 'Over-compressed, retry' });
}

console.log(`[${id}] FINAL size=${bestOutput.length}`);
return sendResult(res, bestOutput, originalSize);
```

} catch (err) {
console.error(`[${id}] ERROR`, err);
res.status(500).json({ error: err.message });
} finally {
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
});

// RESULT RESPONSE
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
