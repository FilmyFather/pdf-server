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

function checkGS() {
  try { execSync('gs --version', { timeout: 5000 }); return 'available'; }
  catch (e) { return 'not found: ' + e.message; }
}

app.get('/', (req, res) => {
  res.json({ status: 'PDF Compressor Running', ghostscript: checkGS() });
});

// ─────────────────────────────────────────────
//  GHOSTSCRIPT RUNNER
// ─────────────────────────────────────────────
function runGS(inputPath, outputPath, opts = {}) {
  const {
    dpi        = 150,
    jpegQ      = 75,
    preset     = '/ebook',
    grayscale  = false,
  } = opts;

  const args = [
    'gs',
    '-dNOSAFER',
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=${preset}`,

    // Color images
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${dpi}`,
    '-dColorImageFilter=/DCTEncode',
    `-/ColorACSImageDict << /QFactor ${(100 - jpegQ) / 100 * 0.9 + 0.05} /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1] >> def`,

    // Gray images
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${dpi}`,
    '-dGrayImageFilter=/DCTEncode',

    // Mono images
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Bicubic',
    `-dMonoImageResolution=${Math.min(dpi * 2, 300)}`,

    // Font
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dDetectDuplicateImages=true',

    // JPEG quality via GS dict
    `-dJPEGQ=${jpegQ}`,

    grayscale ? '-sColorConversionStrategy=Gray -dProcessColorModel=/DeviceGray' : '',

    `-sOutputFile=${outputPath}`,
    inputPath,
  ].filter(Boolean).join(' ');

  execSync(args, { timeout: 55000 });
  return fs.statSync(outputPath).size;
}

// ─────────────────────────────────────────────
//  MAIN COMPRESS ROUTE
// ─────────────────────────────────────────────
app.post('/compress', upload.single('pdf'), async (req, res) => {
  const id = uuidv4().slice(0, 8);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pdf-${id}-`));
  const inputPath = path.join(tmpDir, 'input.pdf');

  try {
    // ── Get PDF buffer ──
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

    fs.writeFileSync(inputPath, pdfBuf);
    const originalSize = pdfBuf.length;
    const TOLERANCE    = 8 * 1024; // 8KB — acceptable gap below target
    const MIN_VALID    = targetBytes * 0.80; // reject if < 80% of target

    console.log(`[${id}] original=${fmtKB(originalSize)} target=${fmtKB(targetBytes)}`);

    // If original is already under target — return as-is (lossless strip only)
    if (originalSize <= targetBytes) {
      const out = path.join(tmpDir, 'stripped.pdf');
      try {
        runGS(inputPath, out, { dpi: 300, jpegQ: 95, preset: '/prepress' });
        const sz = fs.statSync(out).size;
        if (sz <= targetBytes) {
          console.log(`[${id}] Already small, stripped to ${fmtKB(sz)}`);
          return sendResult(res, fs.readFileSync(out), originalSize);
        }
      } catch (_) {}
      return sendResult(res, pdfBuf, originalSize);
    }

    // ─────────────────────────────────────────
    //  PHASE 1: Probe — find size at 3 anchor points
    //  to understand this PDF's compression curve
    // ─────────────────────────────────────────
    const probes = [
      { dpi: 250, jpegQ: 90, preset: '/printer'  },
      { dpi: 150, jpegQ: 65, preset: '/ebook'    },
      { dpi:  96, jpegQ: 40, preset: '/screen'   },
    ];

    const probeResults = [];
    for (const [pi, p] of probes.entries()) {
      const out = path.join(tmpDir, `probe_${pi}.pdf`);
      try {
        const sz = runGS(inputPath, out, p);
        probeResults.push({ ...p, sz, out });
        console.log(`[${id}] probe${pi} dpi=${p.dpi} q=${p.jpegQ} → ${fmtKB(sz)}`);
      } catch (e) {
        console.log(`[${id}] probe${pi} failed: ${e.message}`);
      }
    }

    // If best probe (highest quality) is already under target — use it
    const bestProbe = probeResults.find(p => p.sz <= targetBytes);
    if (bestProbe && targetBytes - bestProbe.sz <= TOLERANCE) {
      console.log(`[${id}] Probe hit! ${fmtKB(bestProbe.sz)}`);
      return sendResult(res, fs.readFileSync(bestProbe.out), originalSize);
    }

    // ─────────────────────────────────────────
    //  PHASE 2: Interpolate starting point
    //  Use probe data to estimate good starting DPI/Q
    // ─────────────────────────────────────────

    // Find two probes that bracket the target
    let pLo = null, pHi = null;
    for (let i = 0; i < probeResults.length - 1; i++) {
      const a = probeResults[i], b = probeResults[i + 1];
      if (a.sz >= targetBytes && b.sz <= targetBytes) {
        pHi = a; pLo = b;
        break;
      }
    }

    // Derive starting DPI and Q from bracketing probes
    let startDPI, startQ;
    if (pLo && pHi) {
      const ratio = (targetBytes - pLo.sz) / (pHi.sz - pLo.sz);
      startDPI = Math.round(pLo.dpi + ratio * (pHi.dpi - pLo.dpi));
      startQ   = Math.round(pLo.jpegQ + ratio * (pHi.jpegQ - pLo.jpegQ));
    } else if (probeResults.length > 0) {
      // All probes above or below target — use closest
      const closest = [...probeResults].sort((a, b) =>
        Math.abs(a.sz - targetBytes) - Math.abs(b.sz - targetBytes)
      )[0];
      startDPI = closest.dpi;
      startQ   = closest.jpegQ;
    } else {
      startDPI = 150;
      startQ   = 65;
    }

    startDPI = clamp(startDPI, 72, 300);
    startQ   = clamp(startQ,   20, 95);

    console.log(`[${id}] Interpolated start: dpi=${startDPI} q=${startQ}`);

    // ─────────────────────────────────────────
    //  PHASE 3: Fine binary search around start
    // ─────────────────────────────────────────
    let bestOutput = null;
    let bestDiff   = Infinity;

    // Check if any probe is valid already
    for (const p of probeResults) {
      const diff = targetBytes - p.sz;
      if (diff >= 0 && diff < bestDiff) {
        bestDiff   = diff;
        bestOutput = fs.readFileSync(p.out);
      }
    }

    // Binary search on quality (primary axis)
    let qLo = Math.max(20, startQ - 25);
    let qHi = Math.min(95, startQ + 25);
    let dpi  = startDPI;

    for (let iter = 0; iter < 16; iter++) {
      if (qLo > qHi) break;
      const qMid = Math.round((qLo + qHi) / 2);
      const out  = path.join(tmpDir, `search_${iter}.pdf`);

      let sz;
      try {
        sz = runGS(inputPath, out, {
          dpi,
          jpegQ:  qMid,
          preset: dpi >= 200 ? '/printer' : dpi >= 130 ? '/ebook' : '/screen',
        });
      } catch (e) {
        console.log(`[${id}] search iter=${iter} failed: ${e.message}`);
        qHi = qMid - 1;
        continue;
      }

      const diff = targetBytes - sz;
      console.log(`[${id}] search iter=${iter} dpi=${dpi} q=${qMid} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

      // Reject absurd outputs (< 50KB or < 10% of target)
      if (sz < 50 * 1024 || sz < targetBytes * 0.10) {
        console.log(`[${id}] Rejected absurd output ${fmtKB(sz)}`);
        qLo = qMid + 1;
        continue;
      }

      if (diff >= 0) {
        // Valid: under or equal target
        if (diff < bestDiff) {
          bestDiff   = diff;
          bestOutput = fs.readFileSync(out);
        }
        if (diff <= TOLERANCE) {
          console.log(`[${id}] ✓ Within tolerance at iter=${iter}`);
          break;
        }
        // Too small — raise quality
        qLo = qMid + 1;
        // Also nudge DPI up if quality is already high
        if (qMid >= 85 && dpi < 250) dpi = Math.min(250, dpi + 20);
      } else {
        // Over target — lower quality
        qHi = qMid - 1;
        // Also nudge DPI down if still over by a lot
        if (diff < -300 * 1024 && dpi > 96) dpi = Math.max(96, dpi - 20);
      }
    }

    // ─────────────────────────────────────────
    //  PHASE 4: DPI sweep if Q search not enough
    // ─────────────────────────────────────────
    if (!bestOutput || bestDiff > TOLERANCE * 3) {
      console.log(`[${id}] Q search insufficient, doing DPI sweep...`);
      const dpiSteps = [200, 160, 130, 110, 96, 85, 75, 65, 55, 48];

      for (const d of dpiSteps) {
        const out = path.join(tmpDir, `dpisweep_${d}.pdf`);
        try {
          const sz   = runGS(inputPath, out, {
            dpi: d, jpegQ: 70,
            preset: d >= 150 ? '/ebook' : '/screen',
          });
          const diff = targetBytes - sz;
          console.log(`[${id}] dpisweep dpi=${d} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

          if (sz < 50 * 1024) continue; // skip absurd

          if (diff >= 0 && diff < bestDiff) {
            bestDiff   = diff;
            bestOutput = fs.readFileSync(out);
            if (diff <= TOLERANCE) break;
          }

          if (diff >= 0) break; // found valid, stop going lower
        } catch (e) {
          console.log(`[${id}] dpisweep ${d} failed: ${e.message}`);
        }
      }
    }

    // ─────────────────────────────────────────
    //  FINAL VALIDATION
    // ─────────────────────────────────────────
    if (!bestOutput) {
      return res.status(422).json({
        error: 'Could not compress to target size',
        originalSize,
        targetBytes,
      });
    }

    const finalSize = bestOutput.length;

    // Reject if absurdly small
    if (finalSize < MIN_VALID) {
      console.log(`[${id}] REJECTED final ${fmtKB(finalSize)} < minValid ${fmtKB(MIN_VALID)}`);
      return res.status(422).json({
        error: `Over-compressed: got ${fmtKB(finalSize)}, expected ~${fmtKB(targetBytes)}`,
        originalSize,
        targetBytes,
      });
    }

    console.log(`[${id}] ✅ FINAL size=${fmtKB(finalSize)} target=${fmtKB(targetBytes)} diff=${fmtKB(targetBytes - finalSize)}`);
    return sendResult(res, bestOutput, originalSize);

  } catch (err) {
    console.error(`[${id}] FATAL:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function sendResult(res, buf, originalSize) {
  res.json({
    success:        true,
    pdfBase64:      buf.toString('base64'),
    originalSize,
    compressedSize: buf.length,
  });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmtKB(b) { return (b / 1024).toFixed(1) + 'KB'; }

// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`Ghostscript: ${checkGS()}`);
});
