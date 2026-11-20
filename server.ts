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
        reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-400)}`));
      }
    });
  });
}

interface MediaProbeInfo {
  width: number;
  height: number;
  hasAudio: boolean;
}

function probeMediaInfo(inputPathOrUrl: string): Promise<MediaProbeInfo> {
  return new Promise((resolve) => {
    const proc = spawn(
      '/usr/bin/ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', inputPathOrUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.on('error', () => resolve({ width: 1920, height: 1080, hasAudio: true }));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ width: 1920, height: 1080, hasAudio: true });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
        };
        const streams = parsed.streams || [];
        const videoStream = streams.find((s) => s.codec_type === 'video' && (s.width || 0) > 0);
        const hasAudio = streams.some((s) => s.codec_type === 'audio');
        resolve({
          width: videoStream?.width || 1920,
          height: videoStream?.height || 1080,
          hasAudio,
        });
      } catch {
        resolve({ width: 1920, height: 1080, hasAudio: true });
      }
    });
  });
}

function resolveCutSourceInput(src?: { serverSourceId?: string; url?: string }): string | null {
  if (!src) return null;
  if (typeof src.serverSourceId === 'string' && /^[a-zA-Z0-9_.-]+$/.test(src.serverSourceId)) {
    const candidate = path.join(MEDIA_DIR, src.serverSourceId);
    if (fs.existsSync(candidate)) return candidate;
  }
  const rawUrl = typeof src.url === 'string' ? src.url.trim() : '';
  if (!rawUrl) return null;
  if (rawUrl.startsWith('/api/media/')) {
    const fileName = rawUrl.slice('/api/media/'.length).split('?')[0];
    if (/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
      const candidate = path.join(MEDIA_DIR, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (rawUrl.startsWith('/api/hls-proxy?')) {
    try {
      const parsed = new URL('http://localhost' + rawUrl);
      const target = parsed.searchParams.get('url');
      if (target && (target.startsWith('https://') || target.startsWith('http://'))) {
        return target;
      }
    } catch {
      return null;
    }
  }
  if (rawUrl.startsWith('https://') || rawUrl.startsWith('http://')) {
    return rawUrl;
  }
  return null;
}

function evenDim(n: number, minVal = 2): number {
  return Math.max(minVal, Math.round(n / 2) * 2);
}

interface CutTransform {
  zoom?: number;
  panX?: number;
  panY?: number;
  crop?: { x: number; y: number; width: number; height: number };
}

function buildCropScaleFilter(
  srcW: number,
  srcH: number,
  zoneW: number,
  zoneH: number,
  transform: CutTransform | undefined,
  fps: number
): string {
  const safeSrcW = srcW > 0 ? srcW : 1920;
  const safeSrcH = srcH > 0 ? srcH : 1080;

  const rawCrop = transform?.crop;
  const cx = rawCrop ? Math.min(0.94, Math.max(0, rawCrop.x)) : 0;
  const cy = rawCrop ? Math.min(0.94, Math.max(0, rawCrop.y)) : 0;
  const cw = rawCrop ? Math.min(1 - cx, Math.max(0.06, rawCrop.width)) : 1;
  const ch = rawCrop ? Math.min(1 - cy, Math.max(0.06, rawCrop.height)) : 1;

  const sx = cx * safeSrcW;
  const sy = cy * safeSrcH;
  const sw = cw * safeSrcW;
  const sh = ch * safeSrcH;

  const zoom = Math.max(1, Number(transform?.zoom || 1));
  const panX = Math.min(1, Math.max(-1, Number(transform?.panX || 0)));
  const panY = Math.min(1, Math.max(-1, Number(transform?.panY || 0)));

  const baseScale = Math.max(zoneW / sw, zoneH / sh);
  const scale = baseScale * zoom;

  const visW = Math.min(sw, zoneW / scale);
  const visH = Math.min(sh, zoneH / scale);

  const overflowX = Math.max(0, sw - visW);
  const overflowY = Math.max(0, sh - visH);

  const rawCropX = sx + (overflowX * (1 - panX)) / 2;
  const rawCropY = sy + (overflowY * (1 - panY)) / 2;

  const cropW = Math.min(safeSrcW, Math.max(2, Math.round(visW)));
  const cropH = Math.min(safeSrcH, Math.max(2, Math.round(visH)));
  const cropX = Math.min(Math.max(0, Math.round(rawCropX)), Math.max(0, safeSrcW - cropW));
  const cropY = Math.min(Math.max(0, Math.round(rawCropY)), Math.max(0, safeSrcH - cropH));

  return `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${zoneW}:${zoneH}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p`;
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

      const returnJson = req.headers['x-return-json'] === '1';
      const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const inPath = path.join(MEDIA_DIR, `raw_${token}.webm`);
      const outFileId = `short_${token}.mp4`;
      const outPath = path.join(MEDIA_DIR, outFileId);

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

        const stat = fs.statSync(outPath);
        if (returnJson) {
          res.json({
            fileId: outFileId,
            downloadUrl: `/api/download/${outFileId}`,
            previewUrl: `/api/media/${outFileId}`,
            size: stat.size,
            mimeType: 'video/mp4',
            extension: 'mp4',
          });
          return;
        }

        const mp4Buf = fs.readFileSync(outPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.send(mp4Buf);
      } catch (err) {
        try {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch {
          // ignore
        }
        res.status(500).json({
          error: err instanceof Error ? err.message : 'MP4 conversion failed',
        });
      } finally {
        try {
          if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
          if (!returnJson && fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch {
          // ignore cleanup
        }
      }
    }
  );

  // Save already-encoded Short (MP4 or WebM) for reliable HTTP attachment download
  app.post(
    '/api/save-export',
    express.raw({ type: '*/*', limit: '250mb' }),
    (req, res) => {
      const body = req.body as Buffer | undefined;
      if (!body || !Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Empty video payload' });
        return;
      }

      const rawExt = typeof req.query.ext === 'string' ? req.query.ext.toLowerCase() : 'mp4';
      const ext = rawExt === 'webm' ? 'webm' : 'mp4';
      const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const fileId = `short_${token}.${ext}`;
      const outPath = path.join(MEDIA_DIR, fileId);

      try {
        fs.writeFileSync(outPath, body);
        res.json({
          fileId,
          downloadUrl: `/api/download/${fileId}`,
          previewUrl: `/api/media/${fileId}`,
          size: body.length,
          mimeType: ext === 'mp4' ? 'video/mp4' : 'video/webm',
          extension: ext,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to save export',
        });
      }
    }
  );

  // Stream-upload local video files to temporary disk storage once for instant FFmpeg cutting
  app.post('/api/upload-source', (req, res) => {
    const rawExt = typeof req.query.ext === 'string' ? req.query.ext.toLowerCase() : 'mp4';
    const ext = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogg'].includes(rawExt) ? rawExt : 'mp4';
    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fileId = `src_${token}.${ext}`;
    const outPath = path.join(MEDIA_DIR, fileId);

    const writeStream = fs.createWriteStream(outPath);
    let totalBytes = 0;
    let finished = false;

    const cleanupOnError = (msg: string, status = 500) => {
      if (finished) return;
      finished = true;
      try {
        writeStream.destroy();
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch {
        // ignore
      }
      res.status(status).json({ error: msg });
    };

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
    });
    req.on('aborted', () => cleanupOnError('Upload aborted', 499));
    req.on('error', (err) => cleanupOnError(err.message || 'Upload stream error'));
    writeStream.on('error', (err) => cleanupOnError(err.message || 'Disk write error'));

    writeStream.on('finish', () => {
      if (finished) return;
      finished = true;
      if (totalBytes === 0) {
        try {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch {
          // ignore
        }
        res.status(400).json({ error: 'Empty video file' });
        return;
      }
      res.json({
        sourceId: fileId,
        mediaUrl: `/api/media/${fileId}`,
        size: totalBytes,
      });
    });

    req.pipe(writeStream);
  });

  // Direct FFmpeg clip cutting + 9:16 split-screen compositing (zero screen recording!)
  app.post('/api/cut-export', async (req, res) => {
    const body = (req.body || {}) as {
      gameplay?: { serverSourceId?: string; url?: string };
      facecam?: { serverSourceId?: string; url?: string; derivedFromGameplay?: boolean };
      startTime?: number;
      endTime?: number;
      layout?: {
        mode?: 'gameplay-top' | 'facecam-top' | 'side-by-side' | 'full-gameplay' | 'full-facecam';
        splitRatio?: number;
        gameplayTransform?: CutTransform;
        facecamTransform?: CutTransform;
        gameplayVolume?: number;
        facecamVolume?: number;
        gameplayMuted?: boolean;
        facecamMuted?: boolean;
        facecamSyncOffset?: number;
        facecamActiveRange?: { start: number; end: number } | null;
      };
      resolution?: '720p' | '1080p';
      fps?: 30 | 60;
      extension?: 'mp4' | 'webm';
    };

    const startTime = Math.max(0, Number(body.startTime || 0));
    const endTime = Math.max(startTime + 0.2, Number(body.endTime || startTime + 1));
    const duration = Math.max(0.2, Number((endTime - startTime).toFixed(3)));
    const outW = body.resolution === '720p' ? 720 : 1080;
    const outH = body.resolution === '720p' ? 1280 : 1920;
    const fps = body.fps === 60 ? 60 : 30;
    const ext = body.extension === 'webm' ? 'webm' : 'mp4';

    const layout = body.layout || {};
    const mode = layout.mode || 'gameplay-top';
    const ratio = Math.min(0.85, Math.max(0.15, Number(layout.splitRatio ?? 0.5)));

    const gpInput = resolveCutSourceInput(body.gameplay);
    let fcInput = resolveCutSourceInput(body.facecam);
    if (!fcInput && body.facecam?.derivedFromGameplay && gpInput) {
      fcInput = gpInput;
    }

    if (!gpInput && !fcInput) {
      res.status(400).json({ error: 'No playable server-accessible gameplay or facecam source provided.' });
      return;
    }

    // Compute exact even-dimension 9:16 zones
    let gpZone: { width: number; height: number } | null = null;
    let fcZone: { width: number; height: number } | null = null;
    if (mode === 'gameplay-top') {
      const topH = evenDim(outH * ratio);
      gpZone = { width: outW, height: topH };
      fcZone = { width: outW, height: outH - topH };
    } else if (mode === 'facecam-top') {
      const topH = evenDim(outH * ratio);
      fcZone = { width: outW, height: topH };
      gpZone = { width: outW, height: outH - topH };
    } else if (mode === 'side-by-side') {
      const leftW = evenDim(outW * ratio);
      gpZone = { width: leftW, height: outH };
      fcZone = { width: outW - leftW, height: outH };
    } else if (mode === 'full-gameplay') {
      gpZone = { width: outW, height: outH };
    } else if (mode === 'full-facecam') {
      fcZone = { width: outW, height: outH };
    }

    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outFileId = `short_${token}.${ext}`;
    const outPath = path.join(MEDIA_DIR, outFileId);

    try {
      const gpProbe = gpInput ? await probeMediaInfo(gpInput) : null;
      const fcProbe =
        fcInput && fcInput !== gpInput
          ? await probeMediaInfo(fcInput)
          : fcInput
            ? gpProbe
            : null;

      const args: string[] = ['-y'];
      let nextInputIdx = 0;

      let gpIdx = -1;
      let fcIdx = -1;

      const syncOffset = Number(layout.facecamSyncOffset || 0);
      const sameFileAndOffsetZero =
        Boolean(gpInput && fcInput && gpInput === fcInput && Math.abs(syncOffset) < 0.01);

      if (gpInput) {
        gpIdx = nextInputIdx++;
        args.push('-ss', String(startTime), '-t', String(duration), '-i', gpInput);
      }

      if (fcInput) {
        if (sameFileAndOffsetZero && gpIdx !== -1) {
          fcIdx = gpIdx;
        } else {
          fcIdx = nextInputIdx++;
          const fcStart = startTime + syncOffset;
          if (fcStart >= 0) {
            args.push('-ss', String(fcStart), '-t', String(duration), '-i', fcInput);
          } else {
            args.push(
              '-ss',
              '0',
              '-t',
              String(Math.max(0.1, duration + fcStart)),
              '-i',
              fcInput
            );
          }
        }
      }

      const filters: string[] = [];

      // Build gameplay zone video
      let gpVideoPad: string | null = null;
      if (gpZone) {
        if (gpIdx !== -1 && gpProbe) {
          const gpFilter = buildCropScaleFilter(
            gpProbe.width,
            gpProbe.height,
            gpZone.width,
            gpZone.height,
            layout.gameplayTransform,
            fps
          );
          filters.push(`[${gpIdx}:v]${gpFilter},setpts=PTS-STARTPTS[gp_zone]`);
          gpVideoPad = '[gp_zone]';
        } else {
          filters.push(
            `color=c=0x05060A:s=${gpZone.width}x${gpZone.height}:r=${fps}:d=${duration},format=yuv420p[gp_zone]`
          );
          gpVideoPad = '[gp_zone]';
        }
      }

      // Build facecam zone video
      let fcVideoPad: string | null = null;
      if (fcZone) {
        if (fcIdx !== -1 && fcProbe) {
          const fcFilter = buildCropScaleFilter(
            fcProbe.width,
            fcProbe.height,
            fcZone.width,
            fcZone.height,
            layout.facecamTransform,
            fps
          );
          const fcStart = startTime + syncOffset;
          const padPrefix =
            !sameFileAndOffsetZero && fcStart < 0
              ? `tpad=start_duration=${Math.abs(fcStart).toFixed(3)}:start_mode=clone,`
              : '';

          const range = layout.facecamActiveRange;
          const relStart = range ? Math.max(0, range.start - startTime) : 0;
          const relEnd = range ? Math.min(duration, range.end - startTime) : duration;

          if (range && (relStart > 0.05 || relEnd < duration - 0.05)) {
            filters.push(
              `color=c=0x05060A:s=${fcZone.width}x${fcZone.height}:r=${fps}:d=${duration},format=yuv420p[fc_bg]`
            );
            filters.push(`[${fcIdx}:v]${padPrefix}${fcFilter},setpts=PTS-STARTPTS[fc_fg]`);
            if (relEnd <= relStart) {
              filters.push(`[fc_bg]null[fc_zone]`);
            } else {
              filters.push(
                `[fc_bg][fc_fg]overlay=0:0:enable='between(t,${relStart.toFixed(3)},${relEnd.toFixed(3)})'[fc_zone]`
              );
            }
          } else {
            filters.push(`[${fcIdx}:v]${padPrefix}${fcFilter},setpts=PTS-STARTPTS[fc_zone]`);
          }
          fcVideoPad = '[fc_zone]';
        } else {
          filters.push(
            `color=c=0x05060A:s=${fcZone.width}x${fcZone.height}:r=${fps}:d=${duration},format=yuv420p[fc_zone]`
          );
          fcVideoPad = '[fc_zone]';
        }
      }

      // Combine video zones into [vout]
      if (mode === 'gameplay-top' && gpVideoPad && fcVideoPad) {
        filters.push(`${gpVideoPad}${fcVideoPad}vstack=inputs=2[vout]`);
      } else if (mode === 'facecam-top' && fcVideoPad && gpVideoPad) {
        filters.push(`${fcVideoPad}${gpVideoPad}vstack=inputs=2[vout]`);
      } else if (mode === 'side-by-side' && gpVideoPad && fcVideoPad) {
        filters.push(`${gpVideoPad}${fcVideoPad}hstack=inputs=2[vout]`);
      } else if (gpVideoPad) {
        filters.push(`${gpVideoPad}null[vout]`);
      } else if (fcVideoPad) {
        filters.push(`${fcVideoPad}null[vout]`);
      }

      // Mix audio cleanly (with silent AAC fallback if video has no audio or all tracks muted)
      const gpVol = Number(layout.gameplayVolume ?? 0.85);
      const fcVol = Number(layout.facecamVolume ?? 1.0);
      const useGpAudio = Boolean(gpIdx !== -1 && gpProbe?.hasAudio && !layout.gameplayMuted && gpVol > 0);
      const useFcAudio = Boolean(
        fcIdx !== -1 &&
          fcProbe?.hasAudio &&
          !layout.facecamMuted &&
          fcVol > 0 &&
          !(body.facecam?.derivedFromGameplay && useGpAudio)
      );

      const audioPads: string[] = [];
      if (useGpAudio) {
        filters.push(
          `[${gpIdx}:a]aresample=48000:async=1:first_pts=0,volume=${gpVol.toFixed(3)},asetpts=PTS-STARTPTS[a_gp]`
        );
        audioPads.push('[a_gp]');
      }
      if (useFcAudio) {
        const fcStart = startTime + syncOffset;
        const delayMs = !sameFileAndOffsetZero && fcStart < 0 ? Math.round(Math.abs(fcStart) * 1000) : 0;
        const delayFilter = delayMs > 0 ? `adelay=${delayMs}|${delayMs},` : '';
        filters.push(
          `[${fcIdx}:a]${delayFilter}aresample=48000:async=1:first_pts=0,volume=${fcVol.toFixed(3)},asetpts=PTS-STARTPTS[a_fc]`
        );
        audioPads.push('[a_fc]');
      }

      if (audioPads.length === 2) {
        filters.push(`${audioPads[0]}${audioPads[1]}amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      } else if (audioPads.length === 1) {
        filters.push(`${audioPads[0]}anull[aout]`);
      } else {
        filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${duration}[aout]`);
      }

      args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');

      if (ext === 'webm') {
        args.push(
          '-c:v',
          'libvpx-vp9',
          '-deadline',
          'realtime',
          '-cpu-used',
          '5',
          '-crf',
          '28',
          '-b:v',
          '0',
          '-c:a',
          'libopus',
          '-b:a',
          '160k',
          '-t',
          String(duration),
          outPath
        );
      } else {
        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '19',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          '-t',
          String(duration),
          outPath
        );
      }

      await runFfmpegCapture(args);
      const stat = fs.statSync(outPath);

      res.json({
        fileId: outFileId,
        downloadUrl: `/api/download/${outFileId}`,
        previewUrl: `/api/media/${outFileId}`,
        size: stat.size,
        mimeType: ext === 'webm' ? 'video/webm' : 'video/mp4',
        extension: ext,
        width: outW,
        height: outH,
        duration,
      });
    } catch (err) {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch {
        // ignore
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Direct FFmpeg cut failed.',
      });
    }
  });

  // Direct HTTP attachment download endpoint (works reliably inside iframes and all browsers)
  app.get('/api/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    if (!fileId || !/^[a-zA-Z0-9_.-]+$/.test(fileId)) {
      res.status(400).send('Invalid file id');
      return;
    }

    const filePath = path.join(MEDIA_DIR, fileId);
    if (!fs.existsSync(filePath)) {
      res.status(404).send('Exported file expired or not found');
      return;
    }

    const rawName = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const safeName = rawName
      ? rawName.replace(/[^a-zA-Z0-9_.-]+/g, '_')
      : fileId;
    res.setHeader('Cache-Control', 'no-store');
    res.download(filePath, safeName);
  });

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
