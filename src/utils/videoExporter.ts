import Hls from 'hls.js';
import {
  ExportFps,
  ExportResolution,
  LayoutConfig,
  VideoSource,
} from '../types/editor';
import { computeCropAndCover, computeZoneBoxes } from './layoutGeometry';
import { clamp } from './time';

export interface ExportFormatInfo {
  mimeType: string;
  extension: 'mp4' | 'webm';
  label: string;
  isMp4: boolean;
}

// H.264 Level 4.2 / 4.0 candidates first (avc1.42E01E is Level 3.0 which fails at 720p/1080p!)
const MP4_CANDIDATES = [
  'video/mp4;codecs=avc1.64002a,mp4a.40.2',
  'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
];

const WEBM_CANDIDATES = [
  { mime: 'video/webm;codecs=vp9,opus', label: 'WebM (VP9 / Opus)' },
  { mime: 'video/webm;codecs=vp8,opus', label: 'WebM (VP8 / Opus)' },
  { mime: 'video/webm;codecs=vp9', label: 'WebM (VP9)' },
  { mime: 'video/webm;codecs=vp8', label: 'WebM (VP8)' },
  { mime: 'video/webm', label: 'WebM' },
];

export function detectBestExportFormat(): ExportFormatInfo {
  if (typeof MediaRecorder === 'undefined') {
    return {
      mimeType: 'video/webm',
      extension: 'webm',
      label: 'WebM (fallback)',
      isMp4: false,
    };
  }

  for (const mime of MP4_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return {
        mimeType: mime,
        extension: 'mp4',
        label: 'MP4 (H.264 / AAC)',
        isMp4: true,
      };
    }
  }

  for (const item of WEBM_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(item.mime)) {
      return {
        mimeType: item.mime,
        extension: 'webm',
        label: item.label,
        isMp4: false,
      };
    }
  }

  return {
    mimeType: '',
    extension: 'webm',
    label: 'Browser Default',
    isMp4: false,
  };
}

export interface ExportShortParams {
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  startTime: number;
  endTime: number;
  layout: LayoutConfig;
  resolution: ExportResolution;
  fps: ExportFps;
  preferMp4: boolean;
  onProgress: (progress: number, elapsedSec: number, statusLabel?: string) => void;
  onFramePreview?: (canvas: HTMLCanvasElement) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blobUrl: string;
  downloadUrl?: string;
  previewUrl?: string;
  blob: Blob;
  size: number;
  mimeType: string;
  extension: 'mp4' | 'webm';
  width: number;
  height: number;
  duration: number;
}

interface LoadedVideoHandle {
  video: HTMLVideoElement;
  hls: Hls | null;
}

function loadVideoForExport(src: VideoSource): Promise<LoadedVideoHandle> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    if (src.sourceType === 'url' || src.isHls) {
      video.crossOrigin = 'anonymous';
    }

    const useHls =
      (src.isHls || src.url.includes('.m3u8') || src.url.includes('/api/hls-proxy')) &&
      Hls.isSupported();

    let hls: Hls | null = null;
    let settled = false;

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      hls?.destroy();
      reject(
        new Error(
          `Timed out loading ${src.role} video for export. Verify the video file or stream is accessible.`
        )
      );
    }, 25000);

    const onLoaded = () => {
      if (settled) return;
      if (video.readyState < 2) return;
      settled = true;
      cleanup();
      resolve({ video, hls });
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      hls?.destroy();
      reject(
        new Error(
          `Unable to load ${src.role} video for export. If using a remote URL, ensure CORS headers allow canvas capture or upload a local file.`
        )
      );
    };

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('canplay', onLoaded);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('canplay', onLoaded);
    video.addEventListener('error', onError);

    if (useHls) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(src.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (data.fatal) {
          onError();
        }
      });
    } else {
      video.src = src.url;
      video.load();
    }
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : time + 60;
    const target = clamp(time, 0, Math.max(0, dur - 0.02));
    if (Math.abs(video.currentTime - target) < 0.03 && video.readyState >= 2) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('canplay', onCanPlay);
      resolve();
    };
    const onSeeked = () => {
      if (video.readyState >= 2) {
        finish();
      }
    };
    const onCanPlay = () => {
      if (Math.abs(video.currentTime - target) < 0.25) {
        finish();
      }
    };
    const timer = window.setTimeout(finish, 6000);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('canplay', onCanPlay);
    try {
      video.currentTime = target;
    } catch {
      finish();
    }
  });
}

function getCandidateMimeTypes(preferMp4: boolean): string[] {
  const list: string[] = [];
  if (preferMp4) {
    for (const m of MP4_CANDIDATES) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
        list.push(m);
      }
    }
  }
  for (const item of WEBM_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(item.mime)) {
      list.push(item.mime);
    }
  }
  list.push('');
  return Array.from(new Set(list));
}

export async function exportShortVideo(params: ExportShortParams): Promise<ExportResult> {
  const {
    gameplay,
    facecam,
    startTime,
    endTime,
    layout,
    resolution,
    fps,
    preferMp4,
    onProgress,
    onFramePreview,
    signal,
  } = params;

  if (!gameplay && !facecam) {
    throw new Error('At least one video source (gameplay or facecam) is required to export.');
  }

  // Create & resume AudioContext synchronously inside click handler for iframe autoplay compatibility
  const audioCtx = new AudioContext();
  const resumePromise =
    audioCtx.state === 'suspended' ? audioCtx.resume().catch(() => undefined) : Promise.resolve();

  const clipDuration = Math.max(0.2, endTime - startTime);
  const width = resolution === '1080p' ? 1080 : 720;
  const height = resolution === '1080p' ? 1920 : 1280;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    await audioCtx.close();
    throw new Error('Canvas 2D context is not available.');
  }

  const shareSameVideo = Boolean(
    gameplay &&
      facecam &&
      gameplay.url === facecam.url &&
      Math.abs(layout.facecamSyncOffset) < 0.01
  );

  let gpHandle: LoadedVideoHandle | null = null;
  let fcHandle: LoadedVideoHandle | null = null;

  try {
    gpHandle = gameplay ? await loadVideoForExport(gameplay) : null;
    fcHandle =
      facecam && !shareSameVideo ? await loadVideoForExport(facecam) : shareSameVideo ? gpHandle : null;
  } catch (err) {
    gpHandle?.hls?.destroy();
    if (fcHandle && fcHandle !== gpHandle) fcHandle.hls?.destroy();
    await audioCtx.close();
    throw err;
  }

  const gpVideo = gpHandle?.video ?? null;
  const fcVideo = fcHandle?.video ?? null;

  const cleanupAllHandles = () => {
    try {
      gpVideo?.pause();
      if (fcVideo && fcVideo !== gpVideo) fcVideo.pause();
      gpHandle?.hls?.destroy();
      if (fcHandle && fcHandle !== gpHandle) fcHandle.hls?.destroy();
      if (gpVideo) {
        gpVideo.removeAttribute('src');
        gpVideo.load();
      }
      if (fcVideo && fcVideo !== gpVideo) {
        fcVideo.removeAttribute('src');
        fcVideo.load();
      }
    } catch {
      // ignore cleanup
    }
  };

  if (signal?.aborted) {
    cleanupAllHandles();
    await audioCtx.close();
    throw new DOMException('Export cancelled', 'AbortError');
  }

  // Web Audio mixing + silent PCM keepalive so MediaRecorder never stalls on muted/audio-less videos
  const audioDest = audioCtx.createMediaStreamDestination();
  let keepAliveSource: AudioBufferSourceNode | null = null;
  try {
    const silentBuffer = audioCtx.createBuffer(2, audioCtx.sampleRate, audioCtx.sampleRate);
    keepAliveSource = audioCtx.createBufferSource();
    keepAliveSource.buffer = silentBuffer;
    keepAliveSource.loop = true;
    const keepAliveGain = audioCtx.createGain();
    keepAliveGain.gain.value = 0;
    keepAliveSource.connect(keepAliveGain);
    keepAliveGain.connect(audioDest);
    keepAliveSource.start();

    if (gpVideo) {
      const gpSource = audioCtx.createMediaElementSource(gpVideo);
      const gpGain = audioCtx.createGain();
      gpGain.gain.value = layout.gameplayMuted ? 0 : layout.gameplayVolume;
      gpSource.connect(gpGain);
      gpGain.connect(audioDest);
    }
    if (fcVideo && fcVideo !== gpVideo) {
      const fcSource = audioCtx.createMediaElementSource(fcVideo);
      const fcGain = audioCtx.createGain();
      fcGain.gain.value = layout.facecamMuted ? 0 : layout.facecamVolume;
      fcSource.connect(fcGain);
      fcGain.connect(audioDest);
    }
  } catch {
    // Continue even if MediaElementSource cannot attach
  }

  await resumePromise;

  const zones = computeZoneBoxes(width, height, layout.mode, layout.splitRatio);

  const isFacecamVisibleAtTime = (t: number) => {
    const range = layout.facecamActiveRange;
    if (!range) return true;
    return t >= range.start - 0.02 && t <= range.end + 0.02;
  };

  const renderFrame = (masterTime: number) => {
    ctx.fillStyle = '#07080d';
    ctx.fillRect(0, 0, width, height);

    if (zones.gameplay && gpVideo && gpVideo.readyState >= 2) {
      const zone = zones.gameplay;
      const rect = computeCropAndCover(
        gpVideo.videoWidth,
        gpVideo.videoHeight,
        zone,
        layout.gameplayTransform
      );
      const sx = clamp(rect.sx, 0, Math.max(0, (gpVideo.videoWidth || 1920) - 2));
      const sy = clamp(rect.sy, 0, Math.max(0, (gpVideo.videoHeight || 1080) - 2));
      const sw = Math.max(1, Math.min(rect.sw, (gpVideo.videoWidth || 1920) - sx));
      const sh = Math.max(1, Math.min(rect.sh, (gpVideo.videoHeight || 1080) - sy));

      ctx.save();
      ctx.beginPath();
      ctx.rect(zone.x, zone.y, zone.width, zone.height);
      ctx.clip();
      ctx.drawImage(gpVideo, sx, sy, sw, sh, rect.dx, rect.dy, rect.dw, rect.dh);
      ctx.restore();
    }

    const showFacecam = isFacecamVisibleAtTime(masterTime);
    if (zones.facecam && fcVideo && fcVideo.readyState >= 2 && showFacecam) {
      const zone = zones.facecam;
      const rect = computeCropAndCover(
        fcVideo.videoWidth,
        fcVideo.videoHeight,
        zone,
        layout.facecamTransform
      );
      const sx = clamp(rect.sx, 0, Math.max(0, (fcVideo.videoWidth || 1920) - 2));
      const sy = clamp(rect.sy, 0, Math.max(0, (fcVideo.videoHeight || 1080) - 2));
      const sw = Math.max(1, Math.min(rect.sw, (fcVideo.videoWidth || 1920) - sx));
      const sh = Math.max(1, Math.min(rect.sh, (fcVideo.videoHeight || 1080) - sy));

      ctx.save();
      ctx.beginPath();
      ctx.rect(zone.x, zone.y, zone.width, zone.height);
      ctx.clip();
      ctx.drawImage(fcVideo, sx, sy, sw, sh, rect.dx, rect.dy, rect.dw, rect.dh);
      ctx.restore();
    }

    if (zones.gameplay && zones.facecam) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      if (layout.mode === 'side-by-side') {
        ctx.fillRect(zones.gameplay.width - 1, 0, 2, height);
      } else {
        const splitY =
          layout.mode === 'gameplay-top' ? zones.gameplay.height : zones.facecam.height;
        ctx.fillRect(0, splitY - 1, width, 2);
      }
    }

    onFramePreview?.(canvas);
  };

  // Seek initial frames & verify canvas is not CORS-tainted
  const seekAllToStart = async () => {
    const seekPromises: Promise<void>[] = [];
    if (gpVideo) seekPromises.push(seekVideo(gpVideo, startTime));
    if (fcVideo && fcVideo !== gpVideo) {
      const fcDur =
        Number.isFinite(fcVideo.duration) && fcVideo.duration > 0 ? fcVideo.duration : 99999;
      const fcStart = clamp(startTime + layout.facecamSyncOffset, 0, Math.max(0, fcDur - 0.05));
      seekPromises.push(seekVideo(fcVideo, fcStart));
    }
    await Promise.all(seekPromises);
  };

  await seekAllToStart();

  try {
    renderFrame(startTime);
    canvas.toDataURL('image/jpeg', 0.1);
  } catch {
    keepAliveSource?.stop();
    cleanupAllHandles();
    await audioCtx.close();
    throw new Error(
      'Canvas export blocked by cross-origin (CORS) security on the remote video URL. Please download and upload the video file directly.'
    );
  }

  const bitrate = resolution === '1080p' ? 8_000_000 : 4_500_000;
  const candidateMimes = getCandidateMimeTypes(preferMp4);

  const attemptRecordWithMime = (mimeType: string): Promise<{ blob: Blob; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Export cancelled', 'AbortError'));
        return;
      }

      const canvasStream = canvas.captureStream(fps);
      const combinedStream = new MediaStream();
      canvasStream.getVideoTracks().forEach((track) => combinedStream.addTrack(track));
      audioDest.stream.getAudioTracks().forEach((track) => combinedStream.addTrack(track));

      let recorder: MediaRecorder;
      try {
        const opts: MediaRecorderOptions = { videoBitsPerSecond: bitrate };
        if (mimeType) opts.mimeType = mimeType;
        recorder = new MediaRecorder(combinedStream, opts);
      } catch (err) {
        combinedStream.getTracks().forEach((t) => t.stop());
        reject(err instanceof Error ? err : new Error('Failed to initialize MediaRecorder'));
        return;
      }

      const chunks: Blob[] = [];
      let rafId = 0;
      let intervalId = 0;
      let finished = false;

      const stopLoopAndStream = () => {
        cancelAnimationFrame(rafId);
        window.clearInterval(intervalId);
        gpVideo?.pause();
        if (fcVideo && fcVideo !== gpVideo) fcVideo.pause();
        combinedStream.getTracks().forEach((t) => t.stop());
      };

      const onAbort = () => {
        if (finished) return;
        finished = true;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // ignore
          }
        }
        stopLoopAndStream();
        reject(new DOMException('Export cancelled', 'AbortError'));
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunks.push(ev.data);
        }
      };

      recorder.onerror = () => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        stopLoopAndStream();
        reject(new Error(`Encoder error for ${mimeType || 'default'}`));
      };

      recorder.onstop = () => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        stopLoopAndStream();
        const finalMime = recorder.mimeType || mimeType || 'video/webm';
        const blob = new Blob(chunks, { type: finalMime });
        if (blob.size === 0) {
          reject(new Error('Recorded 0 bytes'));
          return;
        }
        resolve({ blob, mimeType: finalMime });
      };

      try {
        recorder.start(200);
      } catch (err) {
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        stopLoopAndStream();
        reject(err instanceof Error ? err : new Error('MediaRecorder.start failed'));
        return;
      }

      const safePlay = async (video: HTMLVideoElement) => {
        try {
          await video.play();
        } catch {
          video.muted = true;
          await video.play().catch(() => undefined);
        }
      };

      const startClock = performance.now();
      const playPromises: Promise<void>[] = [];
      if (gpVideo) playPromises.push(safePlay(gpVideo));
      if (fcVideo && fcVideo !== gpVideo) {
        const fcDur =
          Number.isFinite(fcVideo.duration) && fcVideo.duration > 0 ? fcVideo.duration : Infinity;
        const targetFcTime = startTime + layout.facecamSyncOffset;
        if (targetFcTime >= 0 && targetFcTime < fcDur) {
          playPromises.push(safePlay(fcVideo));
        }
      }

      const masterVideo = gpVideo || fcVideo;

      const tickFrame = () => {
        if (finished) return;

        const wallElapsed = (performance.now() - startClock) / 1000;
        const currentMasterTime = masterVideo
          ? gpVideo
            ? gpVideo.currentTime
            : fcVideo!.currentTime - layout.facecamSyncOffset
          : startTime + wallElapsed;

        const elapsed = clamp(currentMasterTime - startTime, 0, clipDuration);
        const progress = clamp(
          Math.max(elapsed / clipDuration, wallElapsed / (clipDuration + 0.5)),
          0,
          0.95
        );
        onProgress(progress, elapsed);

        if (gpVideo && fcVideo && fcVideo !== gpVideo) {
          const fcDur =
            Number.isFinite(fcVideo.duration) && fcVideo.duration > 0 ? fcVideo.duration : 99999;
          const expectedFc = gpVideo.currentTime + layout.facecamSyncOffset;
          if (expectedFc >= 0 && expectedFc < fcDur - 0.05) {
            if (fcVideo.paused) {
              fcVideo.currentTime = expectedFc;
              safePlay(fcVideo);
            } else if (Math.abs(fcVideo.currentTime - expectedFc) > 0.1) {
              fcVideo.currentTime = expectedFc;
            }
          } else if (!fcVideo.paused) {
            fcVideo.pause();
          }
        }

        renderFrame(currentMasterTime);

        const reachedEnd =
          currentMasterTime >= endTime - 0.02 ||
          wallElapsed >= clipDuration + 0.45 ||
          (masterVideo?.ended ?? false);

        if (reachedEnd) {
          if (recorder.state === 'recording') {
            try {
              recorder.requestData();
              recorder.stop();
            } catch {
              // ignore
            }
          }
          return;
        }

        rafId = requestAnimationFrame(tickFrame);
      };

      Promise.all(playPromises).then(() => {
        if (!finished) {
          rafId = requestAnimationFrame(tickFrame);
          // Fallback interval pump in case tab loses focus / rAF throttles
          intervalId = window.setInterval(() => {
            if (document.hidden && !finished) {
              tickFrame();
            }
          }, Math.max(16, Math.round(1000 / fps)));
        }
      });
    });
  };

  let recorded: { blob: Blob; mimeType: string } | null = null;
  let lastError: unknown = null;

  try {
    for (let i = 0; i < candidateMimes.length; i++) {
      if (signal?.aborted) {
        throw new DOMException('Export cancelled', 'AbortError');
      }
      if (i > 0) {
        await seekAllToStart();
      }
      try {
        recorded = await attemptRecordWithMime(candidateMimes[i]);
        break;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') {
          throw err;
        }
        lastError = err;
      }
    }
  } finally {
    try {
      keepAliveSource?.stop();
    } catch {
      // ignore
    }
    cleanupAllHandles();
    await audioCtx.close().catch(() => undefined);
  }

  if (!recorded) {
    throw lastError instanceof Error
      ? lastError
      : new Error('Unable to render video in this browser.');
  }

  let finalBlob = recorded.blob;
  let finalMime = recorded.mimeType;
  let isMp4 = finalMime.toLowerCase().includes('mp4');
  let downloadUrl: string | undefined;
  let previewUrl: string | undefined;
  let finalSize = finalBlob.size;

  // Transcode WebM -> universal H.264/AAC MP4 & persist for reliable HTTP attachment download
  if (preferMp4 && !isMp4 && !signal?.aborted) {
    onProgress(0.96, clipDuration, 'Converting to MP4...');
    try {
      const resp = await fetch('/api/convert-mp4', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Return-Json': '1',
        },
        body: finalBlob,
        signal,
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          downloadUrl?: string;
          previewUrl?: string;
          size?: number;
        };
        if (data.downloadUrl) {
          downloadUrl = data.downloadUrl;
          previewUrl = data.previewUrl;
          finalSize = data.size || finalSize;
          finalMime = 'video/mp4';
          isMp4 = true;
        }
      }
    } catch {
      // Fall back gracefully to local WebM blob
    }
  } else if (!signal?.aborted) {
    onProgress(0.96, clipDuration, 'Preparing download...');
    try {
      const ext = isMp4 ? 'mp4' : 'webm';
      const resp = await fetch(`/api/save-export?ext=${ext}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: finalBlob,
        signal,
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          downloadUrl?: string;
          previewUrl?: string;
          size?: number;
        };
        if (data.downloadUrl) {
          downloadUrl = data.downloadUrl;
          previewUrl = data.previewUrl;
          finalSize = data.size || finalSize;
        }
      }
    } catch {
      // Fall back gracefully to local blob
    }
  }

  onProgress(1, clipDuration);

  const blobUrl = URL.createObjectURL(finalBlob);
  return {
    blobUrl,
    downloadUrl,
    previewUrl,
    blob: finalBlob,
    size: finalSize,
    mimeType: finalMime,
    extension: isMp4 ? 'mp4' : 'webm',
    width,
    height,
    duration: clipDuration,
  };
}
