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
  for (const d of ['/app/tmp', path.join(process.cwd(), 'tmp'), '/tmp', os.tmpdir()]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const t = path.join(d, `.t${Date.now()}`);
      fs.writeFileSync(t, 'x'); fs.unlinkSync(t);
      return d;
    } catch (e) {}
  }
  throw new Error('No writable dir');
}

app.get('/', (req, res) => {
  res.json({ status: 'PDF Compressor Running', gs: checkGS() });
});

// ── STEP 1: Repair PDF first using GS ──
function repairPDF(inputPath, outputPath) {
  // GS can repair corrupt PDFs by reading with error recovery
  // Key flags: -dPDFRECOVER and no -dQUIET so errors are handled
  const args = [
    '-dNOSAFER',
    '-dNOPAUSE', 
    '-dBATCH',
    '-dPDFRECOVER',        // Recover from PDF errors
    '-dNOINTERPOLATE',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dPDFSETTINGS=/prepress',  // Lossless repair
    '-o', outputPath,
    inputPath,
  ];

  const result = spawnSync('gs', args, { timeout: 60000, maxBuffer: 250*1024*1024 });
  const stdout = (result.stdout||Buffer.alloc(0)).toString();
  const stderr = (result.stderr||Buffer.alloc(0)).toString();

  if (!fs.existsSync(outputPath)) throw new Error(`Repair failed: ${stderr.slice(0,200)}`);
  const sz = fs.statSync(outputPath).size;
  if (sz < 1024) throw new Error(`Repair output too small: ${sz} bytes`);
  return sz;
}

// ── STEP 2: Compress repaired PDF ──
function runGS(inputPath, outputPath, dpi, preset) {
  const args = [
    '-dNOSAFER',
    '-dNOPAUSE',
    '-dBATCH',
    '-dPDFRECOVER',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=${preset}`,
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${dpi}`,
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${dpi}`,
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Bicubic',
    `-dMonoImageResolution=${Math.min(dpi * 2, 300)}`,
    '-o', outputPath,
    inputPath,
  ];

  const result = spawnSync('gs', args, { timeout: 60000, maxBuffer: 250*1024*1024 });
  const stdout = (result.stdout||Buffer.alloc(0)).toString();
  const stderr = (result.stderr||Buffer.alloc(0)).toString();

  if (result.status !== 0) throw new Error(`GS exit ${result.status}: ${stderr.slice(0,200)}`);
  if (!fs.existsSync(outputPath)) throw new Error(`No output created`);

  const sz = fs.statSync(outputPath).size;
  if (sz < 50*1024) throw new Error(`Too small: ${(sz/1024).toFixed(1)}KB`);
  return sz;
}

// ── DEBUG ──
app.get('/debug', (req, res) => {
  res.send(`<html><body style="font-family:monospace;padding:20px">
    <h2>GS Debug</h2>
    <form method="POST" action="/debug-test" enctype="multipart/form-data">
      <input type="file" name="pdf" accept="application/pdf" required/><br/><br/>
      Target KB: <input type="number" name="targetKB" value="999"/><br/><br/>
      <button type="submit">Test</button>
    </form></body></html>`);
});

app.post('/debug-test', upload.single('pdf'), (req, res) => {
  const id = uuidv4().slice(0,8);
  let tmpDir = null;
  try {
    const pdfBuf = req.file.buffer;
    const baseDir = getWritableDir();
    tmpDir = path.join(baseDir, `pdf-${id}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath  = path.join(tmpDir, 'input.pdf');
    const repairedPath = path.join(tmpDir, 'repaired.pdf');
    const outPath    = path.join(tmpDir, 'out.pdf');
    fs.writeFileSync(inputPath, pdfBuf);

    const logs = [`Original: ${(pdfBuf.length/1024).toFixed(1)}KB`, `GS: ${checkGS()}`];

    // Step 1: Repair
    try {
      const repSz = repairPDF(inputPath, repairedPath);
      logs.push(`Repaired: ${(repSz/1024).toFixed(1)}KB ✅`);
    } catch(e) {
      logs.push(`Repair failed: ${e.message}`);
    }

    // Step 2: Compress repaired
    const workInput = fs.existsSync(repairedPath) ? repairedPath : inputPath;
    const args = [
      '-dNOSAFER', '-dNOPAUSE', '-dBATCH', '-dPDFRECOVER',
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
      '-dPDFSETTINGS=/ebook',
      '-dDownsampleColorImages=true', '-dColorImageDownsampleType=/Bicubic',
      '-dColorImageResolution=150',
      '-dDownsampleGrayImages=true', '-dGrayImageDownsampleType=/Bicubic',
      '-dGrayImageResolution=150',
      '-dDownsampleMonoImages=true', '-dMonoImageResolution=300',
      '-o', outPath, workInput,
    ];

    const result = spawnSync('gs', args, { timeout: 60000, maxBuffer: 250*1024*1024 });
    const stderr = (result.stderr||Buffer.alloc(0)).toString();
    const stdout = (result.stdout||Buffer.alloc(0)).toString();
    logs.push(`Compress exit: ${result.status}`);
    logs.push(`stdout: "${stdout.slice(0,300)}"`);
    logs.push(`stderr: "${stderr.slice(0,300)}"`);
    if (fs.existsSync(outPath)) logs.push(`✅ Output: ${(fs.statSync(outPath).size/1024).toFixed(1)}KB`);
    else logs.push(`❌ No output`);

    res.send(`<pre>${logs.join('\n')}</pre>`);
  } catch(e) {
    res.send(`<pre>ERROR: ${e.message}</pre>`);
  } finally {
    if(tmpDir) try { fs.rmSync(tmpDir,{recursive:true,force:true}); } catch(_) {}
  }
});

// ── COMPRESS ROUTE ──
app.post('/compress', upload.single('pdf'), async (req, res) => {
  const id = uuidv4().slice(0,8);
  let tmpDir = null;

  try {
    let pdfBuf;
    if (req.file) pdfBuf = req.file.buffer;
    else if (req.body?.pdfBase64) pdfBuf = Buffer.from(req.body.pdfBase64,'base64');
    else return res.status(400).json({ error: 'No PDF' });

    const targetBytes = parseInt(req.body?.targetBytes||req.query?.targetBytes);
    if (!targetBytes||isNaN(targetBytes)) return res.status(400).json({ error: 'No targetBytes' });

    const baseDir = getWritableDir();
    tmpDir = path.join(baseDir, `pdf-${id}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath    = path.join(tmpDir, 'input.pdf');
    const repairedPath = path.join(tmpDir, 'repaired.pdf');
    fs.writeFileSync(inputPath, pdfBuf);

    const originalSize = pdfBuf.length;
    const TOLERANCE    = 10*1024;
    const MIN_VALID    = targetBytes*0.85;

    console.log(`[${id}] original=${fmtKB(originalSize)} target=${fmtKB(targetBytes)}`);
    if (originalSize <= targetBytes) return sendResult(res, pdfBuf, originalSize);

    // STEP 1: Repair PDF
    let workInput = inputPath;
    try {
      const repSz = repairPDF(inputPath, repairedPath);
      console.log(`[${id}] Repaired: ${fmtKB(repSz)}`);
      workInput = repairedPath;
      // If repaired is already under target
      if (repSz <= targetBytes) {
        return sendResult(res, fs.readFileSync(repairedPath), originalSize);
      }
    } catch(e) {
      console.log(`[${id}] Repair failed (using original): ${e.message}`);
    }

    // STEP 2: Compress with binary search on DPI
    let bestOutput = null, bestDiff = Infinity;

    const probes = [
      { dpi:250, preset:'/printer' },
      { dpi:200, preset:'/ebook'   },
      { dpi:150, preset:'/ebook'   },
      { dpi:120, preset:'/screen'  },
      { dpi: 96, preset:'/screen'  },
      { dpi: 72, preset:'/screen'  },
      { dpi: 55, preset:'/screen'  },
    ];

    let hiDPI = 250, loDPI = 55;

    for (const [pi, cfg] of probes.entries()) {
      const out = path.join(tmpDir, `p${pi}.pdf`);
      try {
        const sz   = runGS(workInput, out, cfg.dpi, cfg.preset);
        const diff = targetBytes - sz;
        console.log(`[${id}] probe dpi=${cfg.dpi} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);
        if (diff >= 0) {
          loDPI = cfg.dpi;
          if (diff < bestDiff) { bestDiff=diff; bestOutput=fs.readFileSync(out); }
          if (diff <= TOLERANCE) return sendResult(res, bestOutput, originalSize);
          break;
        } else {
          hiDPI = cfg.dpi;
        }
      } catch(e) {
        console.log(`[${id}] probe${pi} failed: ${e.message}`);
      }
    }

    // Binary search
    let lo = loDPI, hi = hiDPI;
    console.log(`[${id}] BinSearch dpi=[${lo}-${hi}]`);

    for (let iter=0; iter<16; iter++) {
      if (lo > hi) break;
      const mid    = Math.round((lo+hi)/2);
      const preset = mid>=200?'/printer':mid>=120?'/ebook':'/screen';
      const out    = path.join(tmpDir, `bs${iter}.pdf`);
      let sz;
      try { sz = runGS(workInput, out, mid, preset); }
      catch(e) { console.log(`[${id}] bs${iter} err: ${e.message}`); hi=mid-1; continue; }
      const diff = targetBytes - sz;
      console.log(`[${id}] bs${iter} dpi=${mid} sz=${fmtKB(sz)} diff=${fmtKB(diff)}`);
      if (diff >= 0) {
        if (diff < bestDiff) { bestDiff=diff; bestOutput=fs.readFileSync(out); }
        if (diff <= TOLERANCE) break;
        lo = mid+1;
      } else {
        hi = mid-1;
      }
    }

    if (!bestOutput) return res.status(422).json({ error:'Could not reach target', originalSize, targetBytes });
    if (bestOutput.length < MIN_VALID) return res.status(422).json({ error:`Over-compressed: ${fmtKB(bestOutput.length)}` });

    console.log(`[${id}] ✅ FINAL=${fmtKB(bestOutput.length)} diff=${fmtKB(targetBytes-bestOutput.length)}`);
    return sendResult(res, bestOutput, originalSize);

  } catch(err) {
    console.error(`[${id}] FATAL:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpDir) try { fs.rmSync(tmpDir,{recursive:true,force:true}); } catch(_) {}
  }
});

function sendResult(res, buf, originalSize) {
  res.json({ success:true, pdfBase64:buf.toString('base64'), originalSize, compressedSize:buf.length });
}
function fmtKB(b) { return (b/1024).toFixed(1)+'KB'; }

try { fs.mkdirSync('/app/tmp',{recursive:true}); } catch(_) {}

app.listen(PORT, () => {
  console.log(`✅ Port ${PORT} | GS: ${checkGS()} | Dir: ${getWritableDir()}`);
});
