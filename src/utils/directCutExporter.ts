import {
  ExportFps,
  ExportResolution,
  LayoutConfig,
  VideoSource,
} from '../types/editor';
import { ExportResult } from './videoExporter';

const uploadedSourceCache = new Map<string, Promise<string>>();

function getSourceExt(source: VideoSource): string {
  const nameOrUrl = (source.name || source.url || '').toLowerCase();
  if (nameOrUrl.endsWith('.webm')) return 'webm';
  if (nameOrUrl.endsWith('.mov')) return 'mov';
  if (nameOrUrl.endsWith('.mkv')) return 'mkv';
  if (nameOrUrl.endsWith('.m4v')) return 'm4v';
  if (nameOrUrl.endsWith('.ogg')) return 'ogg';
  return 'mp4';
}

function uploadBlobWithProgress(
  blob: Blob,
  ext: string,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload-source?ext=${encodeURIComponent(ext)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    const onAbort = () => {
      xhr.abort();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress?.(Math.min(1, ev.loaded / ev.total));
      }
    };

    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as { sourceId?: string };
          if (parsed.sourceId) {
            resolve(parsed.sourceId);
            return;
          }
        } catch {
          // fall through
        }
      }
      reject(new Error(`Source upload failed (HTTP ${xhr.status}).`));
    };

    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Network error while uploading source video for cutting.'));
    };

    xhr.send(blob);
  });
}

async function resolveDescriptor(
  source: VideoSource,
  onUploadProgress?: (ratio: number) => void,
  signal?: AbortSignal
): Promise<{ serverSourceId?: string; url?: string }> {
  // 1. Already stored on server disk (/api/media/...)
  if (source.url.startsWith('/api/media/')) {
    const fileId = source.url.slice('/api/media/'.length).split('?')[0];
    return { serverSourceId: fileId };
  }

  // 2. Direct remote URL or Kick HLS proxy URL (FFmpeg reads directly without uploading)
  if (
    source.url.startsWith('/api/hls-proxy?') ||
    source.url.startsWith('https://') ||
    source.url.startsWith('http://')
  ) {
    return { url: source.url };
  }

  // 3. Local File or blob: URL -> upload once and cache by source.id
  let cachedPromise = uploadedSourceCache.get(source.id);
  if (!cachedPromise) {
    cachedPromise = (async () => {
      const blob: Blob =
        source.file ??
        (await fetch(source.url, { signal }).then((r) => {
          if (!r.ok) throw new Error('Could not read local video blob.');
          return r.blob();
        }));
      const ext = getSourceExt(source);
      return uploadBlobWithProgress(blob, ext, onUploadProgress, signal);
    })();
    uploadedSourceCache.set(source.id, cachedPromise);
    cachedPromise.catch(() => {
      uploadedSourceCache.delete(source.id);
    });
  }

  const serverSourceId = await cachedPromise;
  return { serverSourceId };
}

/**
 * Optionally starts uploading a local file in the background right after import
 * so direct clip cutting is instantaneous when the user clicks Cut & Download.
 */
export function prewarmServerSource(source: VideoSource): void {
  if (!source.url.startsWith('blob:')) return;
  resolveDescriptor(source).catch(() => undefined);
}

export interface DirectCutParams {
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  startTime: number;
  endTime: number;
  layout: LayoutConfig;
  resolution: ExportResolution;
  fps: ExportFps;
  preferMp4: boolean;
  onProgress: (progress: number, elapsedSec: number, statusLabel?: string) => void;
  signal?: AbortSignal;
}

export async function directCutExportShort({
  gameplay,
  facecam,
  startTime,
  endTime,
  layout,
  resolution,
  fps,
  preferMp4,
  onProgress,
  signal,
}: DirectCutParams): Promise<ExportResult> {
  if (!gameplay && !facecam) {
    throw new Error('Import at least one video before cutting.');
  }

  if (
    gameplay?.sourceType === 'youtube' ||
    facecam?.sourceType === 'youtube'
  ) {
    throw new Error(
      'YouTube links cannot be directly cut into MP4 without screen recording. Upload the MP4/WebM file or use a Kick/direct video link.'
    );
  }

  const duration = Math.max(0.2, endTime - startTime);
  const outW = resolution === '720p' ? 720 : 1080;
  const outH = resolution === '720p' ? 1280 : 1920;

  onProgress(0.08, 0, 'Preparing source video for direct cut...');

  const gpDesc = gameplay
    ? await resolveDescriptor(
        gameplay,
        (ratio) => onProgress(0.08 + ratio * 0.37, 0, `Uploading gameplay for cut (${Math.round(ratio * 100)}%)...`),
        signal
      )
    : undefined;

  let fcDesc: { serverSourceId?: string; url?: string; derivedFromGameplay?: boolean } | undefined;
  if (facecam) {
    if (facecam.derivedFromRole === 'gameplay' && gameplay) {
      fcDesc = { ...gpDesc, derivedFromGameplay: true };
    } else {
      fcDesc = await resolveDescriptor(
        facecam,
        (ratio) => onProgress(0.45 + ratio * 0.15, 0, `Uploading facecam for cut (${Math.round(ratio * 100)}%)...`),
        signal
      );
    }
  }

  onProgress(0.65, 0, 'Cutting & compositing exact 9:16 clip (FFmpeg)...');

  // Smooth progress pulse while FFmpeg finishes direct cut on server
  let simProgress = 0.65;
  const pulseTimer = window.setInterval(() => {
    simProgress = Math.min(0.94, simProgress + 0.03);
    onProgress(simProgress, duration * simProgress, 'Cutting & encoding MP4 (no screen recording)...');
  }, 350);

  try {
    const resp = await fetch('/api/cut-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        gameplay: gpDesc,
        facecam: fcDesc,
        startTime,
        endTime,
        layout,
        resolution,
        fps,
        extension: preferMp4 ? 'mp4' : 'webm',
      }),
    });

    const data = (await resp.json()) as {
      fileId?: string;
      downloadUrl?: string;
      previewUrl?: string;
      size?: number;
      mimeType?: string;
      extension?: 'mp4' | 'webm';
      width?: number;
      height?: number;
      duration?: number;
      error?: string;
    };

    if (!resp.ok || !data.downloadUrl || !data.previewUrl) {
      throw new Error(data.error || 'Direct FFmpeg clip cutting failed.');
    }

    onProgress(1, duration, 'Clip cut ready for download');

    return {
      blobUrl: data.previewUrl,
      downloadUrl: data.downloadUrl,
      previewUrl: data.previewUrl,
      blob: new Blob([], { type: data.mimeType || 'video/mp4' }),
      size: data.size || 0,
      mimeType: data.mimeType || 'video/mp4',
      extension: data.extension || 'mp4',
      width: data.width || outW,
      height: data.height || outH,
      duration: data.duration || duration,
    };
  } finally {
    window.clearInterval(pulseTimer);
  }
}
