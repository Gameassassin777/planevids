'use strict';

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory job store ──────────────────────────────────────────────────────
const jobs = new Map();
// job shape: { id, proc, status, percent, speed, eta, phase, downloadCount,
//              title, thumbnail, filename, fileSize, error, clients }

// ── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function buildFormat(quality) {
  const h = { '720': 720, '1080': 1080, '1440': 1440, '2160': 2160 }[quality] || 720;
  // Prefer pre-muxed H.264+AAC (single stream, no ffmpeg merge, half the disk space)
  // format 22 = YouTube 720p pre-muxed H.264+AAC MP4 — ideal for iPhone
  if (h <= 720) {
    return (
      `bestvideo[height<=${h}][vcodec^=avc1][acodec!='none'][ext=mp4]` +
      `/22/best[height<=${h}][vcodec^=avc1][ext=mp4]` +
      `/bestvideo[height<=${h}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]` +
      `/best[height<=${h}][ext=mp4]/best[height<=${h}]`
    );
  }
  // For 1080p+ must use DASH streams
  return (
    `bestvideo[height<=${h}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]` +
    `/bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]` +
    `/best[height<=${h}][ext=mp4]/best[height<=${h}]`
  );
}

function broadcast(job, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  job.clients = job.clients.filter(c => {
    try { c.write(msg); return true; } catch { return false; }
  });
}

// ── POST /api/start ──────────────────────────────────────────────────────────
// Kicks off yt-dlp on the Mac server. Returns immediately with { id }.
app.post('/api/start', (req, res) => {
  const { url, quality = '1080' } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const id = crypto.randomBytes(6).toString('hex');
  const outputPath = path.join(DOWNLOADS_DIR, `${id}.mp4`);
  const metaPath = path.join(DOWNLOADS_DIR, `${id}.json`);

  const job = {
    id, status: 'fetching-info', percent: 0, speed: '', eta: '',
    phase: 'info', downloadCount: 0, title: '', thumbnail: '',
    filename: `${id}.mp4`, fileSize: 0, error: null, clients: [],
  };
  jobs.set(id, job);
  res.json({ id });

  // Step 1: Fetch metadata
  const infoProc = spawn('yt-dlp', [
    '--dump-json', '--no-playlist', '--no-update', url,
  ]);
  let infoData = '';
  infoProc.stdout.on('data', d => { infoData += d; });

  infoProc.on('close', infoCode => {
    let meta = { title: 'Unknown Video', thumbnail: '', duration: 0, uploader: '' };
    if (infoCode === 0) {
      try {
        const info = JSON.parse(infoData);
        meta = { title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader || '' };
      } catch {}
    }
    Object.assign(job, meta);
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, url, quality }));

    broadcast(job, { status: 'info-ready', title: job.title, thumbnail: job.thumbnail });

    // Step 2: Start actual download
    job.status = 'downloading';
    job.phase = 'video';

    const dlArgs = [
      '--no-playlist',
      '--no-update',
      '-f', buildFormat(quality),
      '--merge-output-format', 'mp4',
      '--progress', '--newline',
      '-o', outputPath,
      url,
    ];

    const proc = spawn('yt-dlp', dlArgs);
    job.proc = proc;

    let stdoutBuf = '';
    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      // Process only complete lines — chunks may split mid-line
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep incomplete last line buffered

      for (const line of lines) {
        process.stdout.write(line + '\n');

        // Progress: [download]   0.0% of    4.45GiB at   14.30MiB/s ETA 04:12
        const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/);
        if (m) {
          job.percent = parseFloat(m[1]);
          job.size = m[2];
          job.speed = m[3];
          job.eta = m[4];
          broadcast(job, { status: 'downloading', percent: job.percent, speed: job.speed, eta: job.eta, size: job.size, phase: job.phase });
          continue;
        }
        if (line.includes('[download] Destination:')) {
          job.downloadCount++;
          job.phase = job.downloadCount >= 2 ? 'audio' : 'video';
          broadcast(job, { status: 'downloading', percent: 0, phase: job.phase });
        }
        if (line.includes('[Merger]') || line.toLowerCase().includes('merging')) {
          job.phase = 'merging';
          broadcast(job, { status: 'merging' });
        }
      }
    });

    // stderr is only for errors
    proc.stderr.on('data', d => process.stderr.write(d));

    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        job.status = 'complete';
        job.phase = 'complete';
        job.fileSize = fs.statSync(outputPath).size;
        broadcast(job, { status: 'complete', id, title: job.title, thumbnail: job.thumbnail, fileSize: job.fileSize });
      } else {
        job.status = 'error';
        job.error = 'Download failed — check server terminal for details.';
        broadcast(job, { status: 'error', message: job.error });
      }
    });
  });

  infoProc.on('error', () => {
    job.status = 'error';
    job.error = 'yt-dlp not found. Is it installed?';
    broadcast(job, { status: 'error', message: job.error });
  });
});

// ── GET /api/progress/:id (SSE) ──────────────────────────────────────────────
app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately on reconnect
  if (job.status === 'complete') {
    res.write(`data: ${JSON.stringify({ status: 'complete', id: job.id, title: job.title, thumbnail: job.thumbnail, fileSize: job.fileSize })}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'error') {
    res.write(`data: ${JSON.stringify({ status: 'error', message: job.error })}\n\n`);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify({ status: job.status, percent: job.percent, speed: job.speed, eta: job.eta, phase: job.phase, title: job.title })}\n\n`);
  job.clients.push(res);

  // Keepalive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    job.clients = job.clients.filter(c => c !== res);
  });
});


// ── GET /api/status/:id (reliable polling fallback) ──────────────────────────
app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: 'not-found' });
  res.json({
    status: job.status, percent: job.percent || 0,
    speed: job.speed || '', eta: job.eta || '',
    size: job.size || '', phase: job.phase || '',
    title: job.title || '', thumbnail: job.thumbnail || '',
    fileSize: job.fileSize || 0, error: job.error || null, id: job.id,
  });
});

// ── GET /api/server-library ──────────────────────────────────────────────────
app.get('/api/server-library', async (req, res) => {
  try {
    const files = await fs.promises.readdir(DOWNLOADS_DIR);
    const videos = [];
    for (const file of files) {
      if (!file.endsWith('.mp4')) continue;
      const id = file.replace('.mp4', '');
      const stat = await fs.promises.stat(path.join(DOWNLOADS_DIR, file));
      let meta = {};
      try { meta = JSON.parse(await fs.promises.readFile(path.join(DOWNLOADS_DIR, `${id}.json`), 'utf8')); } catch {}
      videos.push({ id, fileSize: stat.size, ...meta });
    }
    res.json(videos);
  } catch { res.json([]); }
});

// ── GET /api/file/:id — Range-request aware file serving ────────────────────
app.get('/api/file/:id', (req, res) => {
  if (!/^[\w-]+$/.test(req.params.id)) return res.status(400).end();
  const filePath = path.join(DOWNLOADS_DIR, `${req.params.id}.mp4`);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const total = fs.statSync(filePath).size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : total - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── GET /api/download/:id — triggered download with the real video title ─────
// "Save to Files App" hits this. iOS Safari saves it to Files → Downloads
// as a properly-named MP4 that any app can open.
app.get('/api/download/:id', (req, res) => {
  if (!/^[\w-]+$/.test(req.params.id)) return res.status(400).end();
  const id = req.params.id;
  const filePath = path.join(DOWNLOADS_DIR, `${id}.mp4`);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  let title = id;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DOWNLOADS_DIR, `${id}.json`), 'utf8'));
    if (meta.title) title = meta.title.replace(/[^\w\s-]/g, '').trim().substring(0, 80);
  } catch {}

  const total = fs.statSync(filePath).size;
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': total,
    'Content-Disposition': `attachment; filename="${title}.mp4"`,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
});


// ── DELETE /api/file/:id ─────────────────────────────────────────────────────
app.delete('/api/file/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).end();
  try { await fs.promises.unlink(path.join(DOWNLOADS_DIR, `${id}.mp4`)); } catch {}
  try { await fs.promises.unlink(path.join(DOWNLOADS_DIR, `${id}.json`)); } catch {}
  jobs.delete(id);
  res.json({ ok: true });
});

// ── POST /api/cancel/:id ─────────────────────────────────────────────────────
app.post('/api/cancel/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.proc) job.proc.kill('SIGTERM');
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n✈️  PlaneVids Server Running!\n');
  console.log(`   Mac:    http://localhost:${PORT}`);
  console.log(`   iPhone: http://${ip}:${PORT}  ← open in Safari on same WiFi\n`);
  console.log('   Workflow:');
  console.log('   1. Paste YouTube URL → Mac downloads (you can lock Mac screen)');
  console.log('   2. When done, tap "Save to iPhone" → 2-min LAN transfer');
  console.log('   3. Enjoy offline on the plane!\n');
});
