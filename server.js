const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawnSync } = require('child_process');
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

function checkGS() {
  try {
    const r = spawnSync('gs', ['--version']);
    return r.status === 0 ? 'available v' + r.stdout.toString().trim() : 'error';
  } catch (e) { return 'not found'; }
}

// Find a writable temp directory
function getWritableDir() {
  const candidates = [
    path.join(process.cwd(), 'tmp'),
    '/tmp',
    os.tmpdir(),
    '/var/tmp',
  ];
  for (const d of candidates) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const testFile = path.join(d, `.write_test_${Date.now()}`);
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return d;
    } catch (e) { /* try next */ }
  }
  throw new Error('No writable directory found');
}

app.get('/', (req, res) => {
  const gsVer = checkGS();
  let writableDir = 'unknown';
  try { writableDir = getWritableDir(); } catch (e) { writableDir = e.message; }
  res.json({ status: 'PDF Compressor Running', ghostscript: gsVer, writableDir });
});

// Diagnostic endpoint — test GS with a real PDF operation
app.get('/test-gs', (req, res) => {
  try {
    const baseDir = getWritableDir();
    const testInput  = path.join(baseDir, 'test_input.pdf');
    const testOutput = path.join(baseDir, 'test_output.pdf');

    // Create minimal valid PDF as test input
    const minPDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF`;

    fs.writeFileSync(testInput, minPDF);

    const result = spawnSync('gs', [
      '-dNOSAFER', '-dNOPAUSE', '-dBATCH', '-dQUIET',
      '-sDEVICE=pdfwrite',
      `-sOutputFile=${testOutput}`,
      testInput,
    ], { timeout: 15000 });

    const inputExists  = fs.existsSync(testInput);
    const outputExists = fs.existsSync(testOutput);
    const outputSize   = outputExists ? fs.statSync(testOutput).size : 0;
    const stderr = (result.stderr || Buffer.alloc(0)).toString();
    const stdout = (result.stdout || Buffer.alloc(0)).toString();

    try { fs.unlinkSync(testInput); } catch(_) {}
    try { fs.unlinkSync(testOutput); } catch(_) {}

    res.json({
      status: result.status,
      inputWritten: inputExists,
      outputCreated: outputExists,
      outputSize,
      stderr: stderr.slice(0, 500),
      stdout: stdout.slice(0, 200),
      baseDir,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
//  RUN GHOSTSCRIPT
// ─────────────────────────────────────────────
function runGS(inputPath, outputPath, dpi, jpegQ, preset) {
  const args = [
    '-dNOSAFER',
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=${preset}`,
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${dpi}`,
    '-dColorImageFilter=/DCTEncode',
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${dpi}`,
    '-dGrayImageFilter=/DCTEncode',
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Bicubic',
    `-dMonoImageResolution=${Math.min(dpi * 2, 300)}`,
    `-dJPEGQ=${jpegQ}`,
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];

  const result = spawnSync('gs', args, {
    timeout: 60000,
    maxBuffer: 250 * 1024 * 1024,
  });

  const stderr = (result.stderr || Buffer.alloc(0)).toString();
  const stdout = (result.stdout || Buffer.alloc(0)).toString();

  if (result.status !== 0) {
    throw new Error(`GS exit ${result.status}: ${stderr.slice(0, 300)}`);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`GS ran but no output file. stderr: ${stderr.slice(0,200)}`);
  }

  const sz = fs.statSync(outputPath).size;
  if (sz < 50 * 1024) {
    throw new Error(`GS output only ${(sz/1024).toFixed(1)}KB — corrupt. stderr: ${stderr.slice(0,200)}`);
  }

  return sz;
}

// ─────────────────────────────────────────────
//  COMPRESS ROUTE
// ─────────────────────────────────────────────
app.post('/compress', upload.single('pdf'), async (req, res) => {
  const id = uuidv4().slice(0, 8);
  let tmpDir = null;

  try {
    // Get PDF
    let pdfBuf;
    if (req.file) {
      pdfBuf = req.file.buffer;
    } else if (req.body?.pdfBase64) {
      pdfBuf = Buffer.from(req.body.pdfBase64, 'base64');
    } else {
      return res.status(400).json({ error: 'No PDF provided' });
    }

    const targetBytes = parseInt(req.body?.targetBytes || req.query?.targetBytes);
    if (!targetBytes || isNaN(targetBytes) || targetBytes < 1024) {
      return res.status(400).json({ error: 'Invalid targetBytes' });
    }

    // Get writable dir and create tmp folder
    const baseDir = getWritableDir();
    tmpDir = path.join(baseDir, `pdf-${id}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath = path.join(tmpDir, 'input.pdf');

    // Write input and verify
    fs.writeFileSync(inputPath, pdfBuf);
    const writtenSz = fs.statSync(inputPath).size;
    if (writtenSz !== pdfBuf.length) {
      throw new Error(`File write mismatch: ${pdfBuf.length} vs ${writtenSz}`);
    }

    const originalSize = pdfBuf.length;
    const TOLERANCE    = 10 * 1024;
    const MIN_VALID    = targetBytes * 0.85;

    console.log(`[${id}] original=${fmtKB(originalSize)} target=${fmtKB(targetBytes)} tmpDir=${tmpDir}`);

    if (originalSize <= targetBytes) {
      return sendResult(res, pdfBuf, originalSize);
    }

    let bestOutput = null;
    let bestDiff   = Infinity;

    // ── PHASE 1: Probe ──
    const probes = [
      { dpi: 200, jpegQ: 85, preset: '/ebook'  },
      { dpi: 150, jpegQ: 75, preset: '/ebook'  },
      { dpi: 120, jpegQ: 65, preset: '/screen' },
      { dpi:  96, jpegQ: 55, preset: '/screen' },
      { dpi:  72, jpegQ: 45, preset: '/screen' },
    ];

    let pHi = null, pLo = null; // bracket probes

    for (const [pi, cfg] of probes.entries()) {
      const out = path.join(tmpDir, `probe_${pi}.pdf`);
      try {
        const sz   = runGS(inputPath, out, cfg.dpi, cfg.jpegQ, cfg.preset);
        const diff = targetBytes - sz;
        console.log(`[${id}] probe${pi} dpi=${cfg.dpi} q=${cfg.jpegQ} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

        if (diff >= 0) {
          if (!pLo || sz > pLo.sz) pLo = { ...cfg, sz, out };
          if (diff < bestDiff) {
            bestDiff   = diff;
            bestOutput = fs.readFileSync(out);
          }
          if (diff <= TOLERANCE) {
            console.log(`[${id}] ✓ Probe perfect!`);
            return sendResult(res, bestOutput, originalSize);
          }
        } else {
          if (!pHi || sz < pHi.sz) pHi = { ...cfg, sz, out };
        }
      } catch (e) {
        console.log(`[${id}] probe${pi} failed: ${e.message}`);
      }
    }

    // ── PHASE 2: Binary search on DPI ──
    const dpiLo = pLo ? pLo.dpi : 72;
    const dpiHi = pHi ? pHi.dpi : 200;
    const qBase = pLo ? Math.round((pLo.jpegQ + (pHi?.jpegQ || pLo.jpegQ)) / 2) : 65;

    let lo = dpiLo, hi = dpiHi;
    console.log(`[${id}] Binary search dpi=[${lo}-${hi}] qBase=${qBase}`);

    for (let iter = 0; iter < 14; iter++) {
      if (lo > hi) break;
      const dpiMid = Math.round((lo + hi) / 2);
      const preset = dpiMid >= 150 ? '/ebook' : '/screen';
      const out    = path.join(tmpDir, `bs_${iter}.pdf`);

      let sz;
      try {
        sz = runGS(inputPath, out, dpiMid, qBase, preset);
      } catch (e) {
        console.log(`[${id}] bs${iter} failed: ${e.message}`);
        hi = dpiMid - 1;
        continue;
      }

      const diff = targetBytes - sz;
      console.log(`[${id}] bs${iter} dpi=${dpiMid} q=${qBase} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

      if (diff >= 0) {
        if (diff < bestDiff) {
          bestDiff   = diff;
          bestOutput = fs.readFileSync(out);
        }
        if (diff <= TOLERANCE) break;
        lo = dpiMid + 1;
      } else {
        hi = dpiMid - 1;
      }
    }

    // ── PHASE 3: Fine Q tuning at best DPI ──
    if (bestOutput && bestDiff > TOLERANCE) {
      const bestDPI = lo > hi ? lo - 1 : Math.round((lo + hi) / 2);
      let qfLo = Math.max(20, qBase - 15);
      let qfHi = Math.min(92, qBase + 15);
      const preset = bestDPI >= 150 ? '/ebook' : '/screen';

      console.log(`[${id}] Fine Q tune dpi=${bestDPI} q=[${qfLo}-${qfHi}]`);

      for (let iter = 0; iter < 8; iter++) {
        if (qfLo > qfHi) break;
        const qMid = Math.round((qfLo + qfHi) / 2);
        const out  = path.join(tmpDir, `fq_${iter}.pdf`);
        let sz;
        try {
          sz = runGS(inputPath, out, bestDPI, qMid, preset);
        } catch (e) { qfHi = qMid - 1; continue; }

        const diff = targetBytes - sz;
        console.log(`[${id}] fq${iter} q=${qMid} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

        if (diff >= 0 && diff < bestDiff) {
          bestDiff   = diff;
          bestOutput = fs.readFileSync(out);
          if (diff <= TOLERANCE) break;
          qfLo = qMid + 1;
        } else {
          qfHi = qMid - 1;
        }
      }
    }

    // ── FINAL ──
    if (!bestOutput) {
      return res.status(422).json({ error: 'Could not compress to target', originalSize, targetBytes });
    }

    const finalSz = bestOutput.length;
    if (finalSz < MIN_VALID) {
      return res.status(422).json({ error: `Over-compressed: ${fmtKB(finalSz)} vs target ${fmtKB(targetBytes)}` });
    }

    console.log(`[${id}] ✅ FINAL=${fmtKB(finalSz)} diff=${fmtKB(targetBytes - finalSz)}`);
    return sendResult(res, bestOutput, originalSize);

  } catch (err) {
    console.error(`[${id}] FATAL:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

function sendResult(res, buf, originalSize) {
  res.json({
    success: true,
    pdfBase64: buf.toString('base64'),
    originalSize,
    compressedSize: buf.length,
  });
}

function fmtKB(b) { return (b / 1024).toFixed(1) + 'KB'; }

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`Ghostscript: ${checkGS()}`);
  try { console.log(`Writable dir: ${getWritableDir()}`); }
  catch (e) { console.log(`No writable dir: ${e.message}`); }
});
