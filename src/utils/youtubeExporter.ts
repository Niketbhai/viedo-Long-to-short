import { YouTubePlayerHandle } from '../components/YouTubeEmbedPlayer';
import { ExportFps, ExportResolution } from '../types/editor';
import { clamp } from './time';
import { ExportResult } from './videoExporter';

const MP4_CANDIDATES = [
  'video/mp4;codecs=avc1.64002a,mp4a.40.2',
  'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
];

const WEBM_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function getCandidateMimeTypes(preferMp4: boolean): string[] {
  const list: string[] = [];
  if (preferMp4) {
    for (const m of MP4_CANDIDATES) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
        list.push(m);
      }
    }
  }
  for (const m of WEBM_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      list.push(m);
    }
  }
  list.push('');
  return Array.from(new Set(list));
}

export class TabCaptureBlockedError extends Error {
  isPolicyBlocked: boolean;
  constructor(message: string, isPolicyBlocked: boolean) {
    super(message);
    this.name = 'TabCaptureBlockedError';
    this.isPolicyBlocked = isPolicyBlocked;
  }
}

export async function requestTabCaptureStream(fps: ExportFps): Promise<MediaStream> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    throw new TabCaptureBlockedError(
      'Your browser does not support tab capture for YouTube embeds. Open in Chrome/Edge or upload a local MP4/WebM file.',
      true
    );
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: fps },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    } as DisplayMediaStreamOptions);
    return stream;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = (err as DOMException)?.name || '';
    const isPolicy =
      msg.toLowerCase().includes('permissions policy') ||
      msg.toLowerCase().includes('disallowed') ||
      name === 'SecurityError';
    if (isPolicy) {
      throw new TabCaptureBlockedError(
        'Tab capture is restricted inside this embedded preview frame. Click "Open Studio in Full Tab" below to render YouTube Shorts directly, or upload a local MP4/WebM file.',
        true
      );
    }
    throw new TabCaptureBlockedError(
      'Tab capture was cancelled. Click Start Render & Export and choose "This Tab" (with Share tab audio enabled) to render your YouTube Short.',
      false
    );
  }
}

export interface YouTubeTabCaptureParams {
  displayStream: MediaStream;
  stageEl: HTMLDivElement;
  ytGameplay: YouTubePlayerHandle | null;
  ytFacecam: YouTubePlayerHandle | null;
  vidGameplay: HTMLVideoElement | null;
  vidFacecam: HTMLVideoElement | null;
  startTime: number;
  endTime: number;
  facecamSyncOffset: number;
  resolution: ExportResolution;
  fps: ExportFps;
  preferMp4: boolean;
  onProgress: (progress: number, elapsedSec: number, statusLabel?: string) => void;
  signal?: AbortSignal;
}

const waitMs = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export async function exportYouTubeViaTabCapture(
  params: YouTubeTabCaptureParams
): Promise<ExportResult> {
  const {
    displayStream,
    stageEl,
    ytGameplay,
    ytFacecam,
    vidGameplay,
    vidFacecam,
    startTime,
    endTime,
    facecamSyncOffset,
    resolution,
    fps,
    preferMp4,
    onProgress,
    signal,
  } = params;

  const clipDuration = Math.max(0.2, endTime - startTime);
  const width = resolution === '1080p' ? 1080 : 720;
  const height = resolution === '1080p' ? 1920 : 1280;

  const stopDisplayStream = () => {
    displayStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
  };

  if (signal?.aborted) {
    stopDisplayStream();
    throw new DOMException('Export cancelled', 'AbortError');
  }

  onProgress(0.02, 0, 'Preparing YouTube players...');

  // Wait up to 6s for YouTube iframes to finish handshake
  const readyDeadline = performance.now() + 6000;
  while (performance.now() < readyDeadline) {
    if (signal?.aborted) {
      stopDisplayStream();
      throw new DOMException('Export cancelled', 'AbortError');
    }
    const gpOk = !ytGameplay || ytGameplay.isReady();
    const fcOk = !ytFacecam || ytFacecam.isReady();
    if (gpOk && fcOk) break;
    await waitMs(120);
  }

  // Seek players to exact Start Point and wait for frame buffer
  ytGameplay?.seekTo(startTime);
  ytFacecam?.seekTo(Math.max(0, startTime + facecamSyncOffset));
  if (vidGameplay) vidGameplay.currentTime = startTime;
  if (vidFacecam) vidFacecam.currentTime = Math.max(0, startTime + facecamSyncOffset);

  await waitMs(800);

  if (signal?.aborted) {
    stopDisplayStream();
    throw new DOMException('Export cancelled', 'AbortError');
  }

  // Region Capture API: crop tab stream strictly to the 9:16 stage container if supported
  const videoTrack = displayStream.getVideoTracks()[0];
  let croppedByApi = false;
  const winAny = window as unknown as {
    CropTarget?: { fromElement?: (el: Element) => Promise<unknown> };
  };
  const trackAny = videoTrack as unknown as { cropTo?: (target: unknown) => Promise<void> };

  if (
    videoTrack &&
    typeof winAny.CropTarget?.fromElement === 'function' &&
    typeof trackAny?.cropTo === 'function'
  ) {
    try {
      const target = await winAny.CropTarget.fromElement(stageEl);
      await trackAny.cropTo(target);
      croppedByApi = true;
    } catch {
      croppedByApi = false;
    }
  }

  // Attach captured stream to hidden <video> for scaling to 720p/1080p Canvas
  const captureVideo = document.createElement('video');
  captureVideo.srcObject = displayStream;
  captureVideo.muted = true;
  captureVideo.playsInline = true;
  await captureVideo.play().catch(() => undefined);

  // Wait for captureVideo dimensions
  const dimDeadline = performance.now() + 3000;
  while ((!captureVideo.videoWidth || !captureVideo.videoHeight) && performance.now() < dimDeadline) {
    await waitMs(60);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    stopDisplayStream();
    throw new Error('Canvas 2D context is not available.');
  }

  // Audio mix: captured tab audio + silent keepalive clock
  const audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume().catch(() => undefined);
  }
  const audioDest = audioCtx.createMediaStreamDestination();
  let keepAlive: AudioBufferSourceNode | null = null;
  try {
    const silentBuffer = audioCtx.createBuffer(2, audioCtx.sampleRate, audioCtx.sampleRate);
    keepAlive = audioCtx.createBufferSource();
    keepAlive.buffer = silentBuffer;
    keepAlive.loop = true;
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    keepAlive.connect(gain);
    gain.connect(audioDest);
    keepAlive.start();

    if (displayStream.getAudioTracks().length > 0) {
      const tabAudioStream = new MediaStream(displayStream.getAudioTracks());
      const srcNode = audioCtx.createMediaStreamSource(tabAudioStream);
      srcNode.connect(audioDest);
    }
  } catch {
    // continue with silent audio track if tab audio wasn't shared
  }

  const drawStageFrame = () => {
    ctx.fillStyle = '#07080d';
    ctx.fillRect(0, 0, width, height);

    if (captureVideo.readyState < 2 || !captureVideo.videoWidth || !captureVideo.videoHeight) {
      return;
    }

    if (croppedByApi) {
      ctx.drawImage(captureVideo, 0, 0, width, height);
    } else {
      const rect = stageEl.getBoundingClientRect();
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const scaleX = captureVideo.videoWidth / vw;
      const scaleY = captureVideo.videoHeight / vh;

      const sx = clamp(rect.left * scaleX, 0, captureVideo.videoWidth - 2);
      const sy = clamp(rect.top * scaleY, 0, captureVideo.videoHeight - 2);
      const sw = Math.max(2, Math.min(rect.width * scaleX, captureVideo.videoWidth - sx));
      const sh = Math.max(2, Math.min(rect.height * scaleY, captureVideo.videoHeight - sy));
      ctx.drawImage(captureVideo, sx, sy, sw, sh, 0, 0, width, height);
    }
  };

  drawStageFrame();

  const bitrate = resolution === '1080p' ? 8_000_000 : 4_500_000;
  const candidateMimes = getCandidateMimeTypes(preferMp4);

  const recordOnce = (mimeType: string): Promise<{ blob: Blob; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const canvasStream = canvas.captureStream(fps);
      const combinedStream = new MediaStream();
      canvasStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));
      audioDest.stream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));

      let recorder: MediaRecorder;
      try {
        const opts: MediaRecorderOptions = { videoBitsPerSecond: bitrate };
        if (mimeType) opts.mimeType = mimeType;
        recorder = new MediaRecorder(combinedStream, opts);
      } catch (err) {
        combinedStream.getTracks().forEach((t) => t.stop());
        reject(err instanceof Error ? err : new Error('MediaRecorder init failed'));
        return;
      }

      const chunks: Blob[] = [];
      let rafId = 0;
      let intervalId = 0;
      let finished = false;

      const stopRecordingLoop = () => {
        cancelAnimationFrame(rafId);
        window.clearInterval(intervalId);
        ytGameplay?.pause();
        ytFacecam?.pause();
        vidGameplay?.pause();
        vidFacecam?.pause();
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
        stopRecordingLoop();
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
        stopRecordingLoop();
        reject(new Error(`Encoder error for ${mimeType || 'default'}`));
      };

      recorder.onstop = () => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        stopRecordingLoop();
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
        stopRecordingLoop();
        reject(err instanceof Error ? err : new Error('MediaRecorder.start failed'));
        return;
      }

      // Start playback of stage players
      ytGameplay?.play();
      ytFacecam?.play();
      vidGameplay?.play().catch(() => undefined);
      vidFacecam?.play().catch(() => undefined);

      const startClock = performance.now();

      const tick = () => {
        if (finished) return;

        const wallElapsed = (performance.now() - startClock) / 1000;
        const progress = clamp(wallElapsed / clipDuration, 0, 0.95);
        onProgress(progress, Math.min(wallElapsed, clipDuration), `Recording YouTube Short (${resolution} · ${fps}fps)...`);

        drawStageFrame();

        if (wallElapsed >= clipDuration) {
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

        rafId = requestAnimationFrame(tick);
      };

      rafId = requestAnimationFrame(tick);
      intervalId = window.setInterval(() => {
        if (document.hidden && !finished) tick();
      }, Math.max(16, Math.round(1000 / fps)));
    });
  };

  let recorded: { blob: Blob; mimeType: string } | null = null;
  let lastError: unknown = null;

  try {
    for (let i = 0; i < candidateMimes.length; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (i > 0) {
        ytGameplay?.seekTo(startTime);
        ytFacecam?.seekTo(Math.max(0, startTime + facecamSyncOffset));
        await waitMs(450);
      }
      try {
        recorded = await recordOnce(candidateMimes[i]);
        break;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') throw err;
        lastError = err;
      }
    }
  } finally {
    try {
      keepAlive?.stop();
    } catch {
      // ignore
    }
    stopDisplayStream();
    captureVideo.srcObject = null;
    await audioCtx.close().catch(() => undefined);
  }

  if (!recorded) {
    throw lastError instanceof Error
      ? lastError
      : new Error('Unable to record YouTube capture stream.');
  }

  let finalBlob = recorded.blob;
  let finalMime = recorded.mimeType;
  let isMp4 = finalMime.toLowerCase().includes('mp4');
  let downloadUrl: string | undefined;
  let previewUrl: string | undefined;
  let finalSize = finalBlob.size;

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
      // Fallback gracefully to valid WebM blob
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
      // Fallback gracefully to valid blob
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
