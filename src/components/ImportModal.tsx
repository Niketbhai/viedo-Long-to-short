import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Crop,
  Film,
  Link2,
  Loader2,
  Radio,
  Sparkles,
  Upload,
  User,
  X,
} from 'lucide-react';
import { VideoRole, VideoSource } from '../types/editor';
import { formatFileSize, formatTimecode, generateId } from '../utils/time';
import { extractYouTubeVideoId, isKickUrl } from '../utils/youtube';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  onSetSource: (role: VideoRole, source: VideoSource) => void;
  onLoadDemo: () => Promise<void>;
  isGeneratingDemo: boolean;
  onOpenFacecamCrop: () => void;
}

interface ResolvedKickInfo {
  kind: 'clip' | 'vod' | 'live';
  title: string;
  channel: string;
  duration: number;
  isLive: boolean;
  streamUrl: string;
}

function probeVideoMetadata(
  url: string,
  isRemoteUrl: boolean
): Promise<{ duration: number; width: number; height: number; corsSafe: boolean }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    if (isRemoteUrl) {
      video.crossOrigin = 'anonymous';
    }
    video.src = url;

    const timeout = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'Timed out loading video metadata. Verify the file or URL is a valid playable video.'
        )
      );
    }, 12000);

    const onLoaded = () => {
      cleanup();
      resolve({
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
        width: video.videoWidth || 1920,
        height: video.videoHeight || 1080,
        corsSafe: !isRemoteUrl || url.startsWith('/api/'),
      });
    };

    const onError = () => {
      cleanup();
      if (isRemoteUrl && !url.startsWith('/api/')) {
        const fallbackVideo = document.createElement('video');
        fallbackVideo.preload = 'metadata';
        fallbackVideo.src = url;
        fallbackVideo.onloadedmetadata = () => {
          resolve({
            duration:
              Number.isFinite(fallbackVideo.duration) && fallbackVideo.duration > 0
                ? fallbackVideo.duration
                : 0,
            width: fallbackVideo.videoWidth || 1920,
            height: fallbackVideo.videoHeight || 1080,
            corsSafe: false,
          });
        };
        fallbackVideo.onerror = () => {
          reject(
            new Error(
              'Browser could not load this URL directly. Paste a YouTube link, Kick link, or direct MP4/WebM URL.'
            )
          );
        };
        return;
      }
      reject(
        new Error(
          'Unsupported video codec in this browser. Please convert or use MP4 (H.264) or WebM.'
        )
      );
    };

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  onClose,
  gameplay,
  facecam,
  onSetSource,
  onLoadDemo,
  isGeneratingDemo,
  onOpenFacecamCrop,
}) => {
  const gameplayInputRef = useRef<HTMLInputElement>(null);
  const facecamInputRef = useRef<HTMLInputElement>(null);

  const [urlRole, setUrlRole] = useState<VideoRole>('gameplay');
  const [urlInput, setUrlInput] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<VideoRole | null>(null);

  // Kick Live / VOD capture configuration state
  const [pendingKick, setPendingKick] = useState<ResolvedKickInfo | null>(null);
  const [kickStartSec, setKickStartSec] = useState(0);
  const [kickDurationSec, setKickDurationSec] = useState(30);
  const [capturingKick, setCapturingKick] = useState(false);

  if (!isOpen) return null;

  const handleFile = async (role: VideoRole, file: File) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setPendingKick(null);
    const objectUrl = URL.createObjectURL(file);
    try {
      const meta = await probeVideoMetadata(objectUrl, false);
      if (meta.duration <= 0) {
        throw new Error('Could not read video duration from this file.');
      }
      onSetSource(role, {
        id: generateId('src'),
        role,
        name: file.name,
        url: objectUrl,
        sourceType: 'file',
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fileSize: file.size,
        corsSafe: true,
      });
      setStatusMsg(`Loaded ${role} video: ${file.name}`);
    } catch (err) {
      URL.revokeObjectURL(objectUrl);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load video file.');
    }
  };

  const captureKickSegment = async (
    kickInfo: ResolvedKickInfo,
    startSec: number,
    durSec: number
  ) => {
    setCapturingKick(true);
    setErrorMsg(null);
    try {
      const resp = await fetch('/api/kick/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamUrl: kickInfo.streamUrl,
          startTime: startSec,
          durationSeconds: durSec,
          isLive: kickInfo.isLive,
          kind: kickInfo.kind,
          title: kickInfo.title,
        }),
      });
      const data = (await resp.json()) as {
        mediaUrl?: string;
        fileSize?: number;
        error?: string;
      };
      if (!resp.ok || !data.mediaUrl) {
        throw new Error(data.error || 'Failed to capture Kick stream.');
      }

      const meta = await probeVideoMetadata(data.mediaUrl, true);
      onSetSource(urlRole, {
        id: generateId('src'),
        role: urlRole,
        name: kickInfo.title || `Kick (${kickInfo.channel})`,
        url: data.mediaUrl,
        sourceType: 'kick',
        duration: meta.duration || durSec,
        width: meta.width,
        height: meta.height,
        fileSize: data.fileSize,
        corsSafe: true,
      });
      setPendingKick(null);
      setUrlInput('');
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to fetch Kick video.');
    } finally {
      setCapturingKick(false);
    }
  };

  const loadKickHlsStream = (kickInfo: ResolvedKickInfo) => {
    const proxiedUrl = `/api/hls-proxy?url=${encodeURIComponent(kickInfo.streamUrl)}`;
    onSetSource(urlRole, {
      id: generateId('src'),
      role: urlRole,
      name: kickInfo.title || `Kick (${kickInfo.channel})`,
      url: proxiedUrl,
      sourceType: 'kick',
      isHls: true,
      duration: kickInfo.duration || 0,
      width: 1920,
      height: 1080,
      corsSafe: true,
    });
    setPendingKick(null);
    setUrlInput('');
    onClose();
  };

  const handleUrlImport = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setPendingKick(null);

    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Please enter a valid http:// or https:// URL.');
      }
    } catch {
      setErrorMsg('Please enter a valid YouTube, Kick, or direct MP4/WebM URL.');
      return;
    }

    // 1. Check YouTube Link
    const youtubeId = extractYouTubeVideoId(trimmed);
    if (youtubeId) {
      setUrlLoading(true);
      let ytTitle = `YouTube (${youtubeId})`;
      try {
        const resp = await fetch('/api/youtube/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { title?: string };
          if (data.title) ytTitle = data.title;
        }
      } catch {
        // fallback to ID label
      } finally {
        setUrlLoading(false);
      }

      onSetSource(urlRole, {
        id: generateId('src'),
        role: urlRole,
        name: ytTitle,
        url: trimmed,
        sourceType: 'youtube',
        youtubeId,
        duration: 0,
        width: 1920,
        height: 1080,
        corsSafe: false,
      });
      setUrlInput('');
      onClose();
      return;
    }

    // 2. Check Kick Link (Channel Live, VOD, or Clip)
    if (isKickUrl(trimmed)) {
      setUrlLoading(true);
      try {
        const resp = await fetch('/api/kick/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed }),
        });
        const data = (await resp.json()) as ResolvedKickInfo & { error?: string };
        if (!resp.ok || !data.streamUrl) {
          throw new Error(data.error || 'Could not resolve this Kick link.');
        }

        if (data.kind === 'clip') {
          // Clips are short — capture immediately to local MP4 & jump to editor
          await captureKickSegment(data, 0, Math.min(180, Math.max(5, data.duration || 60)));
        } else {
          // VOD or Live Stream: let user pick seconds to capture OR load full stream directly
          setPendingKick(data);
          setKickStartSec(0);
          setKickDurationSec(30);
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unable to fetch Kick link.');
      } finally {
        setUrlLoading(false);
      }
      return;
    }

    // 3. Direct MP4 / WebM / OGG / HLS (.m3u8) URL
    setUrlLoading(true);
    try {
      const isHlsUrl = trimmed.toLowerCase().includes('.m3u8');
      if (isHlsUrl) {
        const fileName = trimmed.split('/').pop()?.split('?')[0] || `${urlRole}_stream.m3u8`;
        onSetSource(urlRole, {
          id: generateId('src'),
          role: urlRole,
          name: fileName,
          url: trimmed,
          sourceType: 'url',
          isHls: true,
          duration: 0,
          width: 1920,
          height: 1080,
          corsSafe: true,
        });
        setUrlInput('');
        onClose();
        return;
      }

      const meta = await probeVideoMetadata(trimmed, true);
      const fileName = trimmed.split('/').pop()?.split('?')[0] || `${urlRole}_video.mp4`;
      onSetSource(urlRole, {
        id: generateId('src'),
        role: urlRole,
        name: fileName,
        url: trimmed,
        sourceType: 'url',
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        corsSafe: meta.corsSafe,
      });
      setUrlInput('');
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to load this video URL.');
    } finally {
      setUrlLoading(false);
    }
  };

  const renderDropCard = (
    role: VideoRole,
    title: string,
    subtitle: string,
    source: VideoSource | null,
    inputRef: React.RefObject<HTMLInputElement | null>,
    accent: 'blue' | 'purple'
  ) => {
    const isDragging = dragTarget === role;
    const borderAccent = isDragging
      ? accent === 'blue'
        ? 'border-sky-400 bg-sky-500/10'
        : 'border-violet-400 bg-violet-500/10'
      : 'border-white/10 bg-[#111520] hover:border-white/20';

    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragTarget(role);
        }}
        onDragLeave={() => setDragTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          setDragTarget(null);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(role, file);
        }}
        className={`rounded-xl border p-5 transition-colors ${borderAccent}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(role, file);
            e.target.value = '';
          }}
        />

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                accent === 'blue'
                  ? 'bg-sky-500/15 text-sky-400'
                  : 'bg-violet-500/15 text-violet-400'
              }`}
            >
              {role === 'gameplay' ? (
                <Film className="w-5 h-5" />
              ) : (
                <User className="w-5 h-5" />
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">{title}</h3>
              <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {role === 'facecam' && gameplay && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenFacecamCrop();
                }}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Crop className="w-3.5 h-3.5" />
                <span>Crop</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                accent === 'blue'
                  ? 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/30'
                  : 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{source ? 'Replace File' : 'Upload Video'}</span>
            </button>
          </div>
        </div>

        {source ? (
          <div className="mt-4 pt-3 border-t border-white/[0.07] flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-slate-200 font-medium truncate max-w-[240px]">
              {source.name}
            </span>
            <span className="font-mono tabular-nums text-slate-400">
              {source.duration > 0 ? formatTimecode(source.duration) : 'Stream ready'} ·{' '}
              {source.width}×{source.height}
              {source.fileSize ? ` · ${formatFileSize(source.fileSize)}` : ''}
            </span>
          </div>
        ) : (
          <div className="mt-4 pt-3 border-t border-dashed border-white/10 text-xs text-slate-500">
            Drag and drop an MP4, WebM, or MOV recording here, or click Upload Video.
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-modal-title"
    >
      <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0B0E16] shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div>
            <h2 id="import-modal-title" className="font-display text-lg font-semibold text-white">
              Import Gameplay & Facecam Videos
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Upload local recordings or paste a YouTube, Kick (Live / VOD / Clip), or direct MP4/WebM link.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import dialog"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {renderDropCard(
              'gameplay',
              '1. Gameplay Video',
              'Full match, VOD, or livestream capture',
              gameplay,
              gameplayInputRef,
              'blue'
            )}
            {renderDropCard(
              'facecam',
              '2. Facecam Video',
              'Optional webcam track for 50/50 split',
              facecam,
              facecamInputRef,
              'purple'
            )}
          </div>

          {/* URL Import Section (YouTube + Kick + Direct Video) */}
          <form
            onSubmit={handleUrlImport}
            className="rounded-xl border border-white/10 bg-[#111520] p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Link2 className="w-4 h-4 text-sky-400" />
                <span>Paste YouTube, Kick, or Direct Video Link</span>
              </div>

              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#080A10] border border-white/[0.07]">
                <button
                  type="button"
                  onClick={() => setUrlRole('gameplay')}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    urlRole === 'gameplay'
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  As Gameplay
                </button>
                <button
                  type="button"
                  onClick={() => setUrlRole('facecam')}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    urlRole === 'facecam'
                      ? 'bg-violet-500/20 text-violet-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  As Facecam
                </button>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://kick.com/channel  or  https://youtube.com/watch?v=...  or  https://.../clip.mp4"
                className="flex-1 px-3.5 py-2 rounded-lg bg-[#07080D] border border-white/10 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
              />
              <button
                type="submit"
                disabled={urlLoading || capturingKick || !urlInput.trim()}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {urlLoading || capturingKick ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{capturingKick ? 'Fetching MP4...' : 'Resolving Link...'}</span>
                  </>
                ) : (
                  <span>Fetch & Open in Editor</span>
                )}
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              Supports Kick (live channels, VODs, clips), YouTube (watch, shorts, live, youtu.be), and direct MP4/WebM/M3U8 URLs.
            </p>
          </form>

          {/* Kick Live / VOD Extraction Panel */}
          {pendingKick && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Radio className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-xs font-semibold text-white truncate">
                    {pendingKick.title}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-emerald-300">
                  {pendingKick.isLive
                    ? 'Kick Live Stream'
                    : pendingKick.duration > 0
                      ? `Kick VOD · ${formatTimecode(pendingKick.duration)}`
                      : 'Kick VOD'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {!pendingKick.isLive && (
                  <label className="space-y-1 block">
                    <span className="text-slate-300">Start Timestamp (seconds)</span>
                    <input
                      type="number"
                      min={0}
                      max={pendingKick.duration > 0 ? Math.floor(pendingKick.duration) : 36000}
                      value={kickStartSec}
                      onChange={(e) => setKickStartSec(Math.max(0, Number(e.target.value) || 0))}
                      className="w-full px-3 py-2 rounded-lg bg-[#07080D] border border-white/10 font-mono text-white"
                    />
                  </label>
                )}

                <label className="space-y-1 block">
                  <span className="text-slate-300">
                    {pendingKick.isLive
                      ? 'Capture Live Seconds (3–300s)'
                      : 'Fetch Duration (seconds)'}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {[15, 30, 60, 120].map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        onClick={() => setKickDurationSec(sec)}
                        className={`px-2.5 py-2 rounded-lg font-mono text-xs transition-colors cursor-pointer ${
                          kickDurationSec === sec
                            ? 'bg-emerald-500 text-slate-950 font-semibold'
                            : 'bg-[#07080D] border border-white/10 text-slate-300 hover:border-white/25'
                        }`}
                      >
                        {sec}s
                      </button>
                    ))}
                    <input
                      type="number"
                      min={3}
                      max={300}
                      value={kickDurationSec}
                      onChange={(e) =>
                        setKickDurationSec(Math.min(300, Math.max(3, Number(e.target.value) || 30)))
                      }
                      className="w-16 px-2 py-2 rounded-lg bg-[#07080D] border border-white/10 font-mono text-white text-center"
                    />
                  </div>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={capturingKick}
                  onClick={() =>
                    captureKickSegment(pendingKick, kickStartSec, kickDurationSec)
                  }
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 inline-flex items-center gap-2 transition-colors cursor-pointer"
                >
                  {capturingKick ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Capturing {kickDurationSec}s MP4...</span>
                    </>
                  ) : (
                    <span>Capture {kickDurationSec}s as Editable MP4</span>
                  )}
                </button>

                {!pendingKick.isLive && (
                  <button
                    type="button"
                    disabled={capturingKick}
                    onClick={() => loadKickHlsStream(pendingKick)}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-white/[0.08] hover:bg-white/[0.14] text-white transition-colors cursor-pointer"
                  >
                    Stream Full VOD Directly in Editor
                  </button>
                )}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-start gap-2.5 text-xs text-red-200">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {statusMsg && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-start gap-2.5 text-xs text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>{statusMsg}</span>
            </div>
          )}

          <div className="pt-2 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={async () => {
                setErrorMsg(null);
                setStatusMsg(null);
                await onLoadDemo();
                onClose();
              }}
              disabled={isGeneratingDemo}
              className="px-4 py-2 rounded-lg text-xs font-medium border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-slate-200 inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {isGeneratingDemo ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
                  <span>Generating Sample...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                  <span>Try Sample Clips (Offline Demo)</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 rounded-lg text-xs font-semibold bg-white/10 hover:bg-white/15 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Open Editor Studio
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
