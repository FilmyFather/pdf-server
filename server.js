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

app.get('/', (req, res) => {
  res.json({ status: 'PDF Compressor Running', ghostscript: checkGS() });
});

// ─────────────────────────────────────────────
//  GHOSTSCRIPT — using spawnSync (no shell issues)
// ─────────────────────────────────────────────
function runGS(inputPath, outputPath, opts) {
  const { dpi, jpegQ, preset } = opts;

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
    // Color
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${dpi}`,
    '-dColorImageFilter=/DCTEncode',
    // Gray
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${dpi}`,
    '-dGrayImageFilter=/DCTEncode',
    // Mono
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Bicubic',
    `-dMonoImageResolution=${Math.min(dpi * 2, 300)}`,
    // JPEG quality
    `-dJPEGQ=${jpegQ}`,
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];

  const result = spawnSync('gs', args, {
    timeout: 60000,
    maxBuffer: 250 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const errMsg = (result.stderr || Buffer.alloc(0)).toString().slice(0, 500);
    throw new Error(`GS failed (${result.status}): ${errMsg}`);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('GS output file not created');
  }

  const sz = fs.statSync(outputPath).size;

  // For scanned PDFs, minimum valid size is 50KB
  if (sz < 50 * 1024) {
    const stderr = (result.stderr || Buffer.alloc(0)).toString();
    throw new Error(`GS output too small (${fmtKB(sz)}) — likely corrupt. stderr: ${stderr.slice(0,200)}`);
  }

  return sz;
}

// ─────────────────────────────────────────────
//  COMPRESS ROUTE
// ─────────────────────────────────────────────
app.post('/compress', upload.single('pdf'), async (req, res) => {
  const id = uuidv4().slice(0, 8);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pdf-${id}-`));
  const inputPath = path.join(tmpDir, 'input.pdf');

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

    // Write & verify input
    fs.writeFileSync(inputPath, pdfBuf);
    const writtenSz = fs.statSync(inputPath).size;
    if (writtenSz !== pdfBuf.length) {
      throw new Error(`Write mismatch: expected ${pdfBuf.length}, got ${writtenSz}`);
    }

    const originalSize = pdfBuf.length;
    const TOLERANCE   = 10 * 1024; // 10KB — acceptable gap
    const MIN_VALID   = targetBytes * 0.85; // reject if < 85% of target

    console.log(`[${id}] original=${fmtKB(originalSize)} target=${fmtKB(targetBytes)}`);

    // Already small enough
    if (originalSize <= targetBytes) {
      return sendResult(res, pdfBuf, originalSize);
    }

    let bestOutput = null;
    let bestDiff   = Infinity;

    // ── PHASE 1: Probe at 5 DPI/Quality points ──
    // For scanned PDFs, DPI is the primary lever
    const probes = [
      { dpi: 200, jpegQ: 85, preset: '/ebook'  },
      { dpi: 150, jpegQ: 75, preset: '/ebook'  },
      { dpi: 120, jpegQ: 65, preset: '/screen' },
      { dpi:  96, jpegQ: 55, preset: '/screen' },
      { dpi:  72, jpegQ: 45, preset: '/screen' },
    ];

    const goodProbes = []; // probes under target

    for (const [pi, cfg] of probes.entries()) {
      const out = path.join(tmpDir, `probe_${pi}.pdf`);
      try {
        const sz   = runGS(inputPath, out, cfg);
        const diff = targetBytes - sz;
        console.log(`[${id}] probe${pi} dpi=${cfg.dpi} q=${cfg.jpegQ} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

        if (diff >= 0) {
          goodProbes.push({ ...cfg, sz, out });
          if (diff < bestDiff) {
            bestDiff   = diff;
            bestOutput = fs.readFileSync(out);
          }
          if (diff <= TOLERANCE) {
            console.log(`[${id}] ✓ Probe hit!`);
            return sendResult(res, bestOutput, originalSize);
          }
        }
      } catch (e) {
        console.log(`[${id}] probe${pi} failed: ${e.message}`);
      }
    }

    // ── PHASE 2: Binary search between best probes ──
    // Find the two probes that bracket the target
    let pLo = null, pHi = null;

    for (const [pi, cfg] of probes.entries()) {
      const out = path.join(tmpDir, `probe_${pi}.pdf`);
      if (!fs.existsSync(out)) continue;
      const sz = fs.statSync(out).size;
      if (sz > targetBytes && (!pHi || sz < pHi.sz)) pHi = { ...cfg, sz };
      if (sz <= targetBytes && (!pLo || sz > pLo.sz)) pLo = { ...cfg, sz };
    }

    // Set binary search bounds
    let dpiLo, dpiHi, qLo, qHi;
    if (pLo && pHi) {
      dpiLo = pLo.dpi; dpiHi = pHi.dpi;
      qLo   = pLo.jpegQ; qHi = pHi.jpegQ;
    } else if (pLo) {
      dpiLo = pLo.dpi; dpiHi = Math.min(pLo.dpi + 60, 250);
      qLo   = pLo.jpegQ; qHi = Math.min(pLo.jpegQ + 20, 92);
    } else if (pHi) {
      dpiLo = Math.max(pHi.dpi - 60, 50); dpiHi = pHi.dpi;
      qLo   = Math.max(pHi.jpegQ - 20, 20); qHi = pHi.jpegQ;
    } else {
      dpiLo = 50; dpiHi = 200;
      qLo   = 30; qHi   = 85;
    }

    console.log(`[${id}] Binary search: dpi=[${dpiLo}-${dpiHi}] q=[${qLo}-${qHi}]`);

    // Binary search on DPI (primary) with fixed Q mid
    let lo = dpiLo, hi = dpiHi;

    for (let iter = 0; iter < 14; iter++) {
      if (lo > hi) break;
      const dpiMid = Math.round((lo + hi) / 2);
      const qMid   = Math.round((qLo + qHi) / 2);
      const preset = dpiMid >= 150 ? '/ebook' : '/screen';
      const out    = path.join(tmpDir, `bs_${iter}.pdf`);

      let sz;
      try {
        sz = runGS(inputPath, out, { dpi: dpiMid, jpegQ: qMid, preset });
      } catch (e) {
        console.log(`[${id}] bs iter=${iter} failed: ${e.message}`);
        hi = dpiMid - 1;
        continue;
      }

      const diff = targetBytes - sz;
      console.log(`[${id}] bs iter=${iter} dpi=${dpiMid} q=${qMid} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

      if (diff >= 0) {
        // Under target — valid
        if (diff < bestDiff) {
          bestDiff   = diff;
          bestOutput = fs.readFileSync(out);
        }
        if (diff <= TOLERANCE) break; // Perfect!
        lo = dpiMid + 1; // Too small, raise DPI
        // Also raise Q slightly
        qLo = Math.min(qMid + 2, qHi);
      } else {
        hi = dpiMid - 1; // Too big, lower DPI
        qHi = Math.max(qMid - 2, qLo);
      }
    }

    // ── PHASE 3: Fine Q-only tuning at best DPI ──
    if (bestOutput && bestDiff > TOLERANCE) {
      const bestDPI = lo;
      let qfLo = Math.max(20, qLo - 5);
      let qfHi = Math.min(92, qHi + 5);

      console.log(`[${id}] Fine Q tuning at dpi=${bestDPI} q=[${qfLo}-${qfHi}]`);

      for (let iter = 0; iter < 8; iter++) {
        if (qfLo > qfHi) break;
        const qMid  = Math.round((qfLo + qfHi) / 2);
        const preset = bestDPI >= 150 ? '/ebook' : '/screen';
        const out   = path.join(tmpDir, `fq_${iter}.pdf`);

        let sz;
        try {
          sz = runGS(inputPath, out, { dpi: bestDPI, jpegQ: qMid, preset });
        } catch (e) {
          qfHi = qMid - 1;
          continue;
        }

        const diff = targetBytes - sz;
        console.log(`[${id}] fq iter=${iter} q=${qMid} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

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

    // ── FINAL VALIDATION ──
    if (!bestOutput) {
      return res.status(422).json({
        error: 'Could not compress to target size',
        originalSize, targetBytes,
      });
    }

    const finalSz = bestOutput.length;
    if (finalSz < MIN_VALID) {
      console.log(`[${id}] REJECTED: ${fmtKB(finalSz)} < minValid ${fmtKB(MIN_VALID)}`);
      return res.status(422).json({
        error: `Over-compressed: got ${fmtKB(finalSz)}, expected ~${fmtKB(targetBytes)}`,
      });
    }

    console.log(`[${id}] ✅ FINAL=${fmtKB(finalSz)} target=${fmtKB(targetBytes)} diff=${fmtKB(targetBytes - finalSz)}`);
    return sendResult(res, bestOutput, originalSize);

  } catch (err) {
    console.error(`[${id}] FATAL:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmtKB(b) { return (b / 1024).toFixed(1) + 'KB'; }

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`Ghostscript: ${checkGS()}`);
});
