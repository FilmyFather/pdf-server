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
    return r.status === 0 ? 'v' + r.stdout.toString().trim() : 'error';
  } catch (e) { return 'not found'; }
}

function getWritableDir() {
  const candidates = ['/app/tmp', path.join(process.cwd(), 'tmp'), '/tmp', os.tmpdir()];
  for (const d of candidates) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const t = path.join(d, `.test_${Date.now()}`);
      fs.writeFileSync(t, 'x');
      fs.unlinkSync(t);
      return d;
    } catch (e) {}
  }
  throw new Error('No writable dir');
}

app.get('/', (req, res) => {
  res.json({ status: 'PDF Compressor Running', ghostscript: checkGS() });
});

app.get('/test-gs', (req, res) => {
  try {
    const baseDir = getWritableDir();
    const inp = path.join(baseDir, 'test_in.pdf');
    const out = path.join(baseDir, 'test_out.pdf');

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

    fs.writeFileSync(inp, minPDF);

    const result = spawnSync('gs', [
      '-dNOSAFER', '-dNOPAUSE', '-dBATCH', '-dQUIET',
      '-sDEVICE=pdfwrite',
      `-sOutputFile=${out}`,
      inp,
    ], { timeout: 15000 });

    const outputSize = fs.existsSync(out) ? fs.statSync(out).size : 0;
    try { fs.unlinkSync(inp); fs.unlinkSync(out); } catch(_) {}

    res.json({
      status: result.status,
      inputWritten: fs.existsSync(inp) || true,
      outputCreated: outputSize > 0,
      outputSize,
      stderr: (result.stderr||Buffer.alloc(0)).toString().slice(0,500),
      baseDir,
      gsVersion: checkGS(),
    });
  } catch(e) { res.json({ error: e.message }); }
});

// ── GS runner — NO -dJPEGQ (deprecated in GS 10) ──
function runGS(inputPath, outputPath, dpi, preset) {
  // GS 10.x uses -dColorImageResolution etc — no -dJPEGQ needed
  // Quality is controlled via preset + DPI only
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
    // Gray
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${dpi}`,
    // Mono
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Bicubic',
    `-dMonoImageResolution=${Math.min(dpi * 2, 300)}`,
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];

  const result = spawnSync('gs', args, {
    timeout: 60000,
    maxBuffer: 250 * 1024 * 1024,
  });

  const stderr = (result.stderr || Buffer.alloc(0)).toString();

  if (result.status !== 0) {
    throw new Error(`GS exit ${result.status}: ${stderr.slice(0,300)}`);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(`No output file. stderr: ${stderr.slice(0,200)}`);
  }

  const sz = fs.statSync(outputPath).size;
  if (sz < 50 * 1024) {
    throw new Error(`Output too small: ${(sz/1024).toFixed(1)}KB. stderr: ${stderr.slice(0,200)}`);
  }
  return sz;
}

// ── COMPRESS ROUTE ──
app.post('/compress', upload.single('pdf'), async (req, res) => {
  const id = uuidv4().slice(0, 8);
  let tmpDir = null;

  try {
    let pdfBuf;
    if (req.file) {
      pdfBuf = req.file.buffer;
    } else if (req.body?.pdfBase64) {
      pdfBuf = Buffer.from(req.body.pdfBase64, 'base64');
    } else {
      return res.status(400).json({ error: 'No PDF provided' });
    }

    const targetBytes = parseInt(req.body?.targetBytes || req.query?.targetBytes);
    if (!targetBytes || isNaN(targetBytes)) {
      return res.status(400).json({ error: 'Invalid targetBytes' });
    }

    const baseDir = getWritableDir();
    tmpDir = path.join(baseDir, `pdf-${id}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath = path.join(tmpDir, 'input.pdf');

    fs.writeFileSync(inputPath, pdfBuf);
    const originalSize = pdfBuf.length;
    const TOLERANCE = 10 * 1024;
    const MIN_VALID = targetBytes * 0.85;

    console.log(`[${id}] original=${fmtKB(originalSize)} target=${fmtKB(targetBytes)} dir=${tmpDir}`);

    if (originalSize <= targetBytes) return sendResult(res, pdfBuf, originalSize);

    let bestOutput = null;
    let bestDiff = Infinity;

    // Presets mapped to DPI ranges
    // Higher DPI = better quality = bigger file
    const configs = [
      { dpi: 250, preset: '/printer' },
      { dpi: 200, preset: '/ebook'   },
      { dpi: 150, preset: '/ebook'   },
      { dpi: 120, preset: '/screen'  },
      { dpi:  96, preset: '/screen'  },
      { dpi:  72, preset: '/screen'  },
      { dpi:  55, preset: '/screen'  },
    ];

    // PHASE 1: Find two configs that bracket the target
    let loConfig = null, hiConfig = null;

    for (const [ci, cfg] of configs.entries()) {
      const out = path.join(tmpDir, `probe_${ci}.pdf`);
      try {
        const sz = runGS(inputPath, out, cfg.dpi, cfg.preset);
        const diff = targetBytes - sz;
        console.log(`[${id}] probe dpi=${cfg.dpi} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

        if (diff >= 0) {
          // Under target — valid
          if (!loConfig) loConfig = { ...cfg, sz };
          if (diff < bestDiff) {
            bestDiff = diff;
            bestOutput = fs.readFileSync(out);
          }
          if (diff <= TOLERANCE) {
            console.log(`[${id}] ✓ Perfect probe!`);
            return sendResult(res, bestOutput, originalSize);
          }
          break; // Found first valid — stop probing lower
        } else {
          hiConfig = { ...cfg, sz }; // Over target — keep as upper bound
        }
      } catch(e) {
        console.log(`[${id}] probe dpi=${cfg.dpi} failed: ${e.message}`);
      }
    }

    // PHASE 2: Binary search on DPI between hiConfig and loConfig
    const dpiLo = loConfig ? loConfig.dpi : 55;
    const dpiHi = hiConfig ? hiConfig.dpi : 250;
    let lo = dpiLo, hi = dpiHi;

    console.log(`[${id}] Binary search dpi=[${lo}-${hi}]`);

    for (let iter = 0; iter < 16; iter++) {
      if (lo > hi) break;
      const dpiMid = Math.round((lo + hi) / 2);
      const preset = dpiMid >= 200 ? '/printer' : dpiMid >= 120 ? '/ebook' : '/screen';
      const out = path.join(tmpDir, `bs_${iter}.pdf`);

      let sz;
      try {
        sz = runGS(inputPath, out, dpiMid, preset);
      } catch(e) {
        console.log(`[${id}] bs${iter} dpi=${dpiMid} failed: ${e.message}`);
        hi = dpiMid - 1;
        continue;
      }

      const diff = targetBytes - sz;
      console.log(`[${id}] bs${iter} dpi=${dpiMid} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);

      if (diff >= 0) {
        if (diff < bestDiff) {
          bestDiff = diff;
          bestOutput = fs.readFileSync(out);
        }
        if (diff <= TOLERANCE) break;
        lo = dpiMid + 1;
      } else {
        hi = dpiMid - 1;
      }
    }

    // FINAL
    if (!bestOutput) {
      return res.status(422).json({ error: 'Could not reach target size', originalSize, targetBytes });
    }

    const finalSz = bestOutput.length;
    if (finalSz < MIN_VALID) {
      return res.status(422).json({ error: `Over-compressed: ${fmtKB(finalSz)} vs ${fmtKB(targetBytes)}` });
    }

    console.log(`[${id}] ✅ FINAL=${fmtKB(finalSz)} target=${fmtKB(targetBytes)} diff=${fmtKB(targetBytes - finalSz)}`);
    return sendResult(res, bestOutput, originalSize);

  } catch(err) {
    console.error(`[${id}] FATAL:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
  }
});

function sendResult(res, buf, originalSize) {
  res.json({ success: true, pdfBase64: buf.toString('base64'), originalSize, compressedSize: buf.length });
}
function fmtKB(b) { return (b/1024).toFixed(1)+'KB'; }

// Pre-create writable dir
try { fs.mkdirSync('/app/tmp', { recursive: true }); } catch(_) {}

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`GS: ${checkGS()}`);
  try { console.log(`Writable: ${getWritableDir()}`); } catch(e) { console.log('No writable dir!'); }
});
