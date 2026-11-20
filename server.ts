import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const MEDIA_DIR = '/tmp/clipforge_media';

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Periodic cleanup of temporary captured clips older than 2 hours
setInterval(() => {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(MEDIA_DIR)) {
      const fullPath = path.join(MEDIA_DIR, file);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {
    // ignore cleanup errors
  }
}, 15 * 60 * 1000);

const KICK_HEADERS = {
  Accept: 'application/json, text/plain, */*',
};

function parseKickUrl(rawUrl: string):
  | { type: 'clip'; clipId: string }
  | { type: 'vod'; uuid: string }
  | { type: 'channel'; slug: string }
  | null {
  try {
    const u = new URL(rawUrl.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'kick.com') return null;

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    // /clips/<clipId> or /<channel>/clips/<clipId>
    const clipIdx = parts.indexOf('clips');
    if (clipIdx !== -1 && parts[clipIdx + 1]) {
      return { type: 'clip', clipId: parts[clipIdx + 1] };
    }

    // /video/<uuid> or /<channel>/videos/<uuid>
    const videoIdx = parts.findIndex((p) => p === 'videos' || p === 'video');
    if (videoIdx !== -1 && parts[videoIdx + 1]) {
      return { type: 'vod', uuid: parts[videoIdx + 1] };
    }

    // /<channel>
    if (parts.length >= 1 && !['categories', 'browse', 'following'].includes(parts[0])) {
      return { type: 'channel', slug: parts[0] };
    }

    return null;
  } catch {
    return null;
  }
}

function runFfmpegCapture(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg capture failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Serve captured MP4s with Range request support for instant seeking
  app.use(
    '/api/media',
    express.static(MEDIA_DIR, {
      acceptRanges: true,
      setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
      },
    })
  );

  // YouTube public oEmbed metadata (no API key required)
  app.post('/api/youtube/info', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Missing YouTube URL' });
      return;
    }
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
      const resp = await fetch(oembedUrl);
      if (!resp.ok) {
        res.status(404).json({ error: 'Could not read YouTube video metadata' });
        return;
      }
      const data = (await resp.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      res.json({
        title: data.title || '',
        author: data.author_name || '',
        thumbnailUrl: data.thumbnail_url || '',
      });
    } catch {
      res.status(500).json({ error: 'Failed to fetch YouTube info' });
    }
  });

  // Resolve Kick Clip, VOD, or Live Channel URL into real HLS/MP4 stream metadata
  app.post('/api/kick/resolve', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const parsed = parseKickUrl(rawUrl);
    if (!parsed) {
      res.status(400).json({ error: 'Invalid Kick URL. Paste a kick.com channel, VOD, or clip link.' });
      return;
    }

    try {
      if (parsed.type === 'clip') {
        const resp = await fetch(
          `https://kick.com/api/v2/clips/${encodeURIComponent(parsed.clipId)}`,
          { headers: KICK_HEADERS }
        );
        if (!resp.ok) {
          res.status(404).json({ error: 'Kick clip not found or unavailable.' });
          return;
        }
        const json = (await resp.json()) as {
          clip?: {
            title?: string;
            clip_url?: string;
            video_url?: string;
            duration?: number;
            channel?: { slug?: string; username?: string };
          };
        };
        const clip = json.clip;
        const streamUrl = clip?.clip_url || clip?.video_url;
        if (!streamUrl) {
          res.status(404).json({ error: 'No playable stream found for this Kick clip.' });
          return;
        }
        res.json({
          kind: 'clip',
          title: clip?.title || `Kick Clip (${parsed.clipId})`,
          channel: clip?.channel?.username || clip?.channel?.slug || 'Kick',
          duration: typeof clip?.duration === 'number' ? clip.duration : 0,
          isLive: false,
          streamUrl,
        });
        return;
      }

      if (parsed.type === 'vod') {
        const resp = await fetch(
          `https://kick.com/api/v1/video/${encodeURIComponent(parsed.uuid)}`,
          { headers: KICK_HEADERS }
        );
        if (!resp.ok) {
          res.status(404).json({ error: 'Kick VOD not found or unavailable.' });
          return;
        }
        const data = (await resp.json()) as {
          source?: string;
          livestream?: {
            session_title?: string;
            duration?: number;
            channel?: { slug?: string; user?: { username?: string } };
          };
        };
        if (!data.source) {
          res.status(404).json({ error: 'No playable stream found for this Kick VOD.' });
          return;
        }
        res.json({
          kind: 'vod',
          title: data.livestream?.session_title || `Kick VOD (${parsed.uuid.slice(0, 8)})`,
          channel: data.livestream?.channel?.slug || 'Kick',
          duration:
            typeof data.livestream?.duration === 'number' && data.livestream.duration > 0
              ? data.livestream.duration / 1000
              : 0,
          isLive: false,
          streamUrl: data.source,
        });
        return;
      }

      // Channel URL -> Check live playback_url first, fallback to latest VOD
      const chResp = await fetch(
        `https://kick.com/api/v2/channels/${encodeURIComponent(parsed.slug)}`,
        { headers: KICK_HEADERS }
      );
      if (!chResp.ok) {
        res.status(404).json({ error: `Kick channel "${parsed.slug}" not found.` });
        return;
      }
      const chData = (await chResp.json()) as {
        slug?: string;
        playback_url?: string;
        livestream?: { session_title?: string; is_live?: boolean } | null;
      };

      if (chData.playback_url && chData.livestream?.is_live) {
        res.json({
          kind: 'live',
          title: chData.livestream.session_title || `${parsed.slug} Live Stream`,
          channel: chData.slug || parsed.slug,
          duration: 0,
          isLive: true,
          streamUrl: chData.playback_url,
        });
        return;
      }

      // If offline, try latest VOD
      const vodsResp = await fetch(
        `https://kick.com/api/v2/channels/${encodeURIComponent(parsed.slug)}/videos`,
        { headers: KICK_HEADERS }
      );
      if (vodsResp.ok) {
        const vods = (await vodsResp.json()) as Array<{
          source?: string;
          session_title?: string;
          duration?: number;
        }>;
        const latest = vods?.[0];
        if (latest?.source) {
          res.json({
            kind: 'vod',
            title: latest.session_title || `${parsed.slug} Latest VOD`,
            channel: parsed.slug,
            duration:
              typeof latest.duration === 'number' && latest.duration > 0
                ? latest.duration / 1000
                : 0,
            isLive: false,
            streamUrl: latest.source,
          });
          return;
        }
      }

      res.status(404).json({
        error: `Kick channel "${parsed.slug}" is currently offline and has no public VODs.`,
      });
    } catch {
      res.status(500).json({ error: 'Failed to resolve Kick link.' });
    }
  });

  // Capture a Kick Clip, VOD segment, or Live Stream segment into a real local MP4 via ffmpeg
  app.post('/api/kick/capture', async (req, res) => {
    const streamUrl = typeof req.body?.streamUrl === 'string' ? req.body.streamUrl.trim() : '';
    const startTime = typeof req.body?.startTime === 'number' ? Math.max(0, req.body.startTime) : 0;
    const durationSeconds =
      typeof req.body?.durationSeconds === 'number'
        ? Math.min(300, Math.max(3, req.body.durationSeconds))
        : 30;
    const isLive = Boolean(req.body?.isLive);
    const kind = typeof req.body?.kind === 'string' ? req.body.kind : 'vod';

    if (!streamUrl.startsWith('https://')) {
      res.status(400).json({ error: 'Invalid stream URL.' });
      return;
    }

    const fileId = `kick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
    const outPath = path.join(MEDIA_DIR, fileId);

    const args: string[] = ['-y'];
    if (!isLive && kind !== 'clip' && startTime > 0) {
      args.push('-ss', String(startTime));
    }
    args.push('-i', streamUrl);
    if (kind !== 'clip' || durationSeconds) {
      if (kind !== 'clip') {
        args.push('-t', String(durationSeconds));
      }
    }
    args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', outPath);

    try {
      await runFfmpegCapture(args);
      const stat = fs.statSync(outPath);
      res.json({
        mediaUrl: `/api/media/${fileId}`,
        fileSize: stat.size,
      });
    } catch (err) {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch {
        // ignore
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to capture Kick stream.',
      });
    }
  });

  // CORS-safe HLS proxy for direct playback of Kick VODs/streams inside <video> via hls.js
  app.get('/api/hls-proxy', async (req, res) => {
    const target = typeof req.query.url === 'string' ? req.query.url : '';
    if (!target) {
      res.status(400).send('Missing url');
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(target);
      if (parsedUrl.protocol !== 'https:') {
        res.status(400).send('Only https URLs allowed');
        return;
      }
    } catch {
      res.status(400).send('Invalid URL');
      return;
    }

    try {
      const upstream = await fetch(parsedUrl.toString(), { headers: KICK_HEADERS });
      if (!upstream.ok) {
        res.status(upstream.status).send('Upstream error');
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (
        parsedUrl.pathname.endsWith('.m3u8') ||
        contentType.includes('mpegurl') ||
        contentType.includes('m3u8')
      ) {
        const text = await upstream.text();
        const rewritten = text
          .split('\n')
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              // Rewrite URI="..." attributes inside tags like #EXT-X-KEY or #EXT-X-MEDIA
              return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
                const abs = new URL(uri, parsedUrl).toString();
                return `URI="/api/hls-proxy?url=${encodeURIComponent(abs)}"`;
              });
            }
            const abs = new URL(trimmed, parsedUrl).toString();
            return `/api/hls-proxy?url=${encodeURIComponent(abs)}`;
          })
          .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
        return;
      }

      res.setHeader('Content-Type', contentType);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch {
      res.status(502).send('HLS proxy request failed');
    }
  });

  // Transcode WebM Short export blob into universal H.264/AAC MP4 via FFmpeg
  app.post(
    '/api/convert-mp4',
    express.raw({ type: '*/*', limit: '250mb' }),
    async (req, res) => {
      const body = req.body as Buffer | undefined;
      if (!body || !Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Empty video payload' });
        return;
      }

      const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const inPath = path.join(MEDIA_DIR, `raw_${token}.webm`);
      const outPath = path.join(MEDIA_DIR, `short_${token}.mp4`);

      try {
        fs.writeFileSync(inPath, body);
        await runFfmpegCapture([
          '-y',
          '-i',
          inPath,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          outPath,
        ]);
        const mp4Buf = fs.readFileSync(outPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.send(mp4Buf);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'MP4 conversion failed',
        });
      } finally {
        try {
          if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch {
          // ignore cleanup
        }
      }
    }
  );

  if (IS_PROD) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipForge server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
