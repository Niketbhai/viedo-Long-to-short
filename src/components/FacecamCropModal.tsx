import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crop,
  Film,
  Pause,
  Play,
  RotateCcw,
  Upload,
  User,
  X,
} from 'lucide-react';
import { ActiveTimeRange, CropRect, VideoRole, VideoSource } from '../types/editor';
import {
  computeCropAndCover,
  DEFAULT_TRANSFORM,
  FULL_CROP,
  normalizeCropRect,
} from '../utils/layoutGeometry';
import { clamp, formatTimecode } from '../utils/time';
import { SmartVideo } from './SmartVideo';
import { YouTubeEmbedPlayer, YouTubePlayerHandle } from './YouTubeEmbedPlayer';

interface FacecamCropModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  initialCrop?: CropRect;
  initialActiveRange?: ActiveTimeRange | null;
  timelineInPoint: number;
  timelineOutPoint: number;
  onQuickUploadFacecam: (file: File) => void;
  onApplyFacecamCrop: (params: {
    sourceMode: 'gameplay' | 'facecam';
    crop: CropRect;
    activeRange: ActiveTimeRange | null;
  }) => void;
}

type DragHandle =
  | 'move'
  | 'draw'
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w';

const CORNER_PRESETS: { label: string; crop: CropRect }[] = [
  { label: 'Bottom-Left', crop: { x: 0.02, y: 0.64, width: 0.28, height: 0.34 } },
  { label: 'Bottom-Right', crop: { x: 0.70, y: 0.64, width: 0.28, height: 0.34 } },
  { label: 'Top-Left', crop: { x: 0.02, y: 0.02, width: 0.28, height: 0.34 } },
  { label: 'Top-Right', crop: { x: 0.70, y: 0.02, width: 0.28, height: 0.34 } },
  { label: 'Center Cam', crop: { x: 0.30, y: 0.22, width: 0.40, height: 0.56 } },
  { label: 'Full Frame', crop: { ...FULL_CROP } },
];

export const FacecamCropModal: React.FC<FacecamCropModalProps> = ({
  isOpen,
  onClose,
  gameplay,
  facecam,
  initialCrop,
  initialActiveRange,
  timelineInPoint,
  timelineOutPoint,
  onQuickUploadFacecam,
  onApplyFacecamCrop,
}) => {
  const [sourceMode, setSourceMode] = useState<'gameplay' | 'facecam'>('gameplay');
  const [crop, setCrop] = useState<CropRect>({ x: 0.02, y: 0.64, width: 0.28, height: 0.34 });
  const [durationMode, setDurationMode] = useState<'full' | 'timeline' | 'custom'>('full');
  const [customStart, setCustomStart] = useState(0);
  const [customEnd, setCustomEnd] = useState(30);

  const [isPlaying, setIsPlaying] = useState(false);
  const [localTime, setLocalTime] = useState(0);
  const [detectedDuration, setDetectedDuration] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBoxSize, setPreviewBoxSize] = useState({ width: 210, height: 190 });

  const mainVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const ytMainRef = useRef<YouTubePlayerHandle | null>(null);
  const ytPreviewRef = useRef<YouTubePlayerHandle | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setIsPlaying(false);
      return;
    }

    // Default to cropping from gameplay if no separate facecam exists or facecam is already derived from gameplay
    if (facecam && facecam.derivedFromRole !== 'gameplay') {
      setSourceMode('facecam');
    } else if (gameplay) {
      setSourceMode('gameplay');
    } else if (facecam) {
      setSourceMode('facecam');
    }

    setCrop(
      initialCrop
        ? normalizeCropRect(initialCrop)
        : { x: 0.02, y: 0.64, width: 0.28, height: 0.34 }
    );

    if (initialActiveRange) {
      setDurationMode('custom');
      setCustomStart(initialActiveRange.start);
      setCustomEnd(initialActiveRange.end);
    } else {
      setDurationMode('full');
      setCustomStart(0);
      setCustomEnd(gameplay?.duration || facecam?.duration || 30);
    }

    setLocalTime(0);
    setIsPlaying(false);
  }, [isOpen, gameplay, facecam, initialCrop, initialActiveRange]);

  const activeSource: VideoSource | null =
    sourceMode === 'gameplay' ? gameplay || facecam : facecam || gameplay;

  const effectiveDuration = Math.max(
    detectedDuration,
    activeSource?.duration || 0
  );

  // Measure live cropped result box size
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el || !isOpen) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setPreviewBoxSize({ width: r.width, height: r.height });
      }
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, [isOpen]);

  // Keep playback time synced between main crop video and live cropped preview
  useEffect(() => {
    if (!isOpen || !isPlaying) return;
    const timer = window.setInterval(() => {
      if (activeSource?.sourceType === 'youtube') {
        const t = ytMainRef.current?.getCurrentTime() || 0;
        setLocalTime(t);
        if (ytPreviewRef.current && Math.abs(ytPreviewRef.current.getCurrentTime() - t) > 0.35) {
          ytPreviewRef.current.seekTo(t);
        }
      } else if (mainVideoRef.current) {
        const t = mainVideoRef.current.currentTime;
        setLocalTime(t);
        if (
          previewVideoRef.current &&
          Math.abs(previewVideoRef.current.currentTime - t) > 0.12
        ) {
          previewVideoRef.current.currentTime = t;
        }
        if (mainVideoRef.current.ended) {
          setIsPlaying(false);
        }
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [isOpen, isPlaying, activeSource?.sourceType]);

  const togglePlay = () => {
    if (!activeSource) return;
    const next = !isPlaying;
    setIsPlaying(next);
    if (activeSource.sourceType === 'youtube') {
      if (next) {
        ytMainRef.current?.play();
        ytPreviewRef.current?.play();
      } else {
        ytMainRef.current?.pause();
        ytPreviewRef.current?.pause();
      }
    } else {
      if (next) {
        mainVideoRef.current?.play().catch(() => undefined);
        previewVideoRef.current?.play().catch(() => undefined);
      } else {
        mainVideoRef.current?.pause();
        previewVideoRef.current?.pause();
      }
    }
  };

  const seekBoth = (t: number) => {
    setLocalTime(t);
    if (activeSource?.sourceType === 'youtube') {
      ytMainRef.current?.seekTo(t);
      ytPreviewRef.current?.seekTo(t);
    } else {
      if (mainVideoRef.current) mainVideoRef.current.currentTime = t;
      if (previewVideoRef.current) previewVideoRef.current.currentTime = t;
    }
  };

  const startDrag = (handle: DragHandle, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = stageRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startNormX = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const startNormY = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    const initial = { ...crop };

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startClientX) / rect.width;
      const dy = (ev.clientY - startClientY) / rect.height;

      if (handle === 'draw') {
        const curX = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const curY = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
        const x = Math.min(startNormX, curX);
        const y = Math.min(startNormY, curY);
        const w = Math.max(0.06, Math.abs(curX - startNormX));
        const h = Math.max(0.06, Math.abs(curY - startNormY));
        setCrop(normalizeCropRect({ x, y, width: w, height: h }));
        return;
      }

      if (handle === 'move') {
        const nextX = clamp(initial.x + dx, 0, 1 - initial.width);
        const nextY = clamp(initial.y + dy, 0, 1 - initial.height);
        setCrop({ ...initial, x: nextX, y: nextY });
        return;
      }

      let left = initial.x;
      let top = initial.y;
      let right = initial.x + initial.width;
      let bottom = initial.y + initial.height;
      const minSize = 0.06;

      if (handle.includes('w')) {
        left = clamp(initial.x + dx, 0, right - minSize);
      }
      if (handle.includes('e')) {
        right = clamp(initial.x + initial.width + dx, left + minSize, 1);
      }
      if (handle.includes('n')) {
        top = clamp(initial.y + dy, 0, bottom - minSize);
      }
      if (handle.includes('s')) {
        bottom = clamp(initial.y + initial.height + dy, top + minSize, 1);
      }

      setCrop({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const liveResultRect = useMemo(() => {
    if (!activeSource) return null;
    return computeCropAndCover(
      activeSource.width,
      activeSource.height,
      { x: 0, y: 0, width: previewBoxSize.width, height: previewBoxSize.height },
      { ...DEFAULT_TRANSFORM, crop }
    );
  }, [activeSource, previewBoxSize, crop]);

  if (!isOpen) return null;

  const handleApply = () => {
    if (!activeSource) return;
    let activeRange: ActiveTimeRange | null = null;
    if (durationMode === 'timeline' && timelineOutPoint > timelineInPoint + 0.1) {
      activeRange = { start: timelineInPoint, end: timelineOutPoint };
    } else if (durationMode === 'custom' && customEnd > customStart + 0.1) {
      activeRange = { start: Math.max(0, customStart), end: customEnd };
    }

    setIsPlaying(false);
    onApplyFacecamCrop({
      sourceMode: activeSource.role === 'gameplay' && sourceMode === 'gameplay' ? 'gameplay' : 'facecam',
      crop: normalizeCropRect(crop),
      activeRange,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="facecam-crop-title"
    >
      <div className="w-full max-w-4xl rounded-2xl border border-white/10 bg-[#0B0E16] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Crop className="w-4 h-4 text-violet-400" />
            <div>
              <h2 id="facecam-crop-title" className="font-display text-lg font-semibold text-white">
                Crop Facecam Region by Hand
              </h2>
              <p className="text-xs text-slate-400">
                Draw or drag the box around your facecam. Only this cropped area will be lifted into the 9:16 Facecam slot.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close facecam crop"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
          {/* Source Switcher + Upload */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {gameplay && (
                <button
                  type="button"
                  onClick={() => {
                    setIsPlaying(false);
                    setSourceMode('gameplay');
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                    sourceMode === 'gameplay'
                      ? 'bg-sky-500/20 border border-sky-400/50 text-sky-200'
                      : 'bg-white/[0.05] border border-white/10 text-slate-300 hover:text-white'
                  }`}
                >
                  <Film className="w-3.5 h-3.5 text-sky-400" />
                  <span>Crop from Gameplay / Link Video</span>
                </button>
              )}

              {facecam && facecam.derivedFromRole !== 'gameplay' && (
                <button
                  type="button"
                  onClick={() => {
                    setIsPlaying(false);
                    setSourceMode('facecam');
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                    sourceMode === 'facecam'
                      ? 'bg-violet-500/20 border border-violet-400/50 text-violet-200'
                      : 'bg-white/[0.05] border border-white/10 text-slate-300 hover:text-white'
                  }`}
                >
                  <User className="w-3.5 h-3.5 text-violet-400" />
                  <span>Crop Separate Facecam Video</span>
                </button>
              )}
            </div>

            <label className="px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-500/15 hover:bg-violet-500/25 border border-violet-400/30 text-violet-200 inline-flex items-center gap-1.5 cursor-pointer transition-colors">
              <Upload className="w-3.5 h-3.5" />
              <span>Upload Separate Facecam</span>
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    onQuickUploadFacecam(f);
                    setSourceMode('facecam');
                  }
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          {!activeSource ? (
            <div className="rounded-xl border border-dashed border-white/15 bg-[#07080D] p-10 text-center space-y-3">
              <p className="text-sm font-medium text-white">No video loaded yet</p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Upload a Gameplay or Facecam video first, or upload a recording using the button above to draw your facecam crop box.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_240px] gap-4">
              {/* Left: Interactive Hand-Crop Video Canvas */}
              <div className="space-y-3">
                <div
                  ref={stageRef}
                  onPointerDown={(e) => startDrag('draw', e)}
                  className="relative w-full aspect-video rounded-xl overflow-hidden bg-black border border-white/15 select-none cursor-crosshair"
                >
                  {activeSource.sourceType === 'youtube' && activeSource.youtubeId ? (
                    <YouTubeEmbedPlayer
                      key={`crop_yt_${activeSource.id}`}
                      ref={ytMainRef}
                      videoId={activeSource.youtubeId}
                      muted={true}
                      volume={0}
                      onMetadata={(dur) => setDetectedDuration(dur)}
                      className="w-full h-full pointer-events-none"
                    />
                  ) : (
                    <SmartVideo
                      key={`crop_vid_${activeSource.id}`}
                      ref={mainVideoRef}
                      src={activeSource.url}
                      isHls={activeSource.isHls}
                      crossOrigin={
                        activeSource.sourceType === 'url' && activeSource.corsSafe
                          ? 'anonymous'
                          : undefined
                      }
                      muted
                      playsInline
                      preload="auto"
                      onLoadedMetadataInfo={(dur) => setDetectedDuration(dur)}
                      className="w-full h-full object-fill pointer-events-none"
                    />
                  )}

                  {/* Crop Box with Dark Backdrop Cutout */}
                  <div
                    onPointerDown={(e) => startDrag('move', e)}
                    style={{
                      left: `${crop.x * 100}%`,
                      top: `${crop.y * 100}%`,
                      width: `${crop.width * 100}%`,
                      height: `${crop.height * 100}%`,
                      boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.62)',
                    }}
                    className="absolute border-2 border-violet-400 cursor-move z-10"
                  >
                    {/* Rule of thirds guide lines */}
                    <div className="absolute inset-0 pointer-events-none">
                      <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/20" />
                      <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/20" />
                      <div className="absolute top-1/3 left-0 right-0 h-px bg-white/20" />
                      <div className="absolute top-2/3 left-0 right-0 h-px bg-white/20" />
                    </div>

                    {/* 8 Resize Handles */}
                    <div
                      onPointerDown={(e) => startDrag('nw', e)}
                      className="absolute -left-1.5 -top-1.5 w-3.5 h-3.5 rounded-sm bg-white border border-violet-600 cursor-nwse-resize"
                    />
                    <div
                      onPointerDown={(e) => startDrag('n', e)}
                      className="absolute left-1/2 -translate-x-1/2 -top-1.5 w-6 h-3 rounded-sm bg-white border border-violet-600 cursor-ns-resize"
                    />
                    <div
                      onPointerDown={(e) => startDrag('ne', e)}
                      className="absolute -right-1.5 -top-1.5 w-3.5 h-3.5 rounded-sm bg-white border border-violet-600 cursor-nesw-resize"
                    />
                    <div
                      onPointerDown={(e) => startDrag('e', e)}
                      className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-3 h-6 rounded-sm bg-white border border-violet-600 cursor-ew-resize"
                    />
                    <div
                      onPointerDown={(e) => startDrag('se', e)}
                      className="absolute -right-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-sm bg-white border border-violet-600 cursor-nwse-resize"
                    />
                    <div
                      onPointerDown={(e) => startDrag('s', e)}
                      className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-6 h-3 rounded-sm bg-white border border-violet-600 cursor-ns-resize"
                    />
                    <div
                      onPointerDown={(e) => startDrag('sw', e)}
                      className="absolute -left-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-sm bg-white border border-violet-600 cursor-nesw-resize"
                    />
                    <div
                      onPointerDown={(e) => startDrag('w', e)}
                      className="absolute -left-1.5 top-1/2 -translate-y-1/2 w-3 h-6 rounded-sm bg-white border border-violet-600 cursor-ew-resize"
                    />
                  </div>
                </div>

                {/* Scrub Bar + Quick Corner Presets */}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="w-8 h-8 rounded-lg bg-violet-600 hover:bg-violet-500 text-white flex items-center justify-center shrink-0 cursor-pointer"
                  >
                    {isPlaying ? (
                      <Pause className="w-3.5 h-3.5 fill-current" />
                    ) : (
                      <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                    )}
                  </button>

                  <input
                    type="range"
                    min={0}
                    max={effectiveDuration || 100}
                    step={0.05}
                    value={Math.min(localTime, effectiveDuration || 0)}
                    onChange={(e) => seekBoth(parseFloat(e.target.value))}
                    aria-label="Scrub crop preview"
                    className="flex-1 studio-slider"
                  />

                  <span className="text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
                    {formatTimecode(localTime)} / {formatTimecode(effectiveDuration)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-400 mr-1">Quick Position:</span>
                  {CORNER_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setCrop(preset.crop)}
                      className="px-2.5 py-1 rounded-md bg-white/[0.06] hover:bg-violet-500/20 text-[11px] text-slate-300 hover:text-white transition-colors cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCrop({ ...FULL_CROP })}
                    className="px-2 py-1 rounded-md text-[11px] text-slate-400 hover:text-white inline-flex items-center gap-1 cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset</span>
                  </button>
                </div>
              </div>

              {/* Right: Live Extracted Facecam Preview & Active Duration */}
              <div className="space-y-3 flex flex-col">
                <div className="rounded-xl border border-white/10 bg-[#111521] p-3 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-violet-300">
                      Extracted Facecam Result
                    </span>
                    <span className="font-mono text-slate-400">
                      {Math.round(crop.width * 100)}% × {Math.round(crop.height * 100)}%
                    </span>
                  </div>

                  <div
                    ref={previewBoxRef}
                    className="relative w-full aspect-[9/8] rounded-lg overflow-hidden bg-black border border-violet-500/40"
                  >
                    {liveResultRect &&
                      (activeSource.sourceType === 'youtube' && activeSource.youtubeId ? (
                        <YouTubeEmbedPlayer
                          key={`crop_prev_yt_${activeSource.id}`}
                          ref={ytPreviewRef}
                          videoId={activeSource.youtubeId}
                          muted={true}
                          volume={0}
                          style={{
                            position: 'absolute',
                            left: liveResultRect.domLeft,
                            top: liveResultRect.domTop,
                            width: liveResultRect.domWidth,
                            height: liveResultRect.domHeight,
                            maxWidth: 'none',
                          }}
                          className="pointer-events-none"
                        />
                      ) : (
                        <SmartVideo
                          key={`crop_prev_vid_${activeSource.id}`}
                          ref={previewVideoRef}
                          src={activeSource.url}
                          isHls={activeSource.isHls}
                          crossOrigin={
                            activeSource.sourceType === 'url' && activeSource.corsSafe
                              ? 'anonymous'
                              : undefined
                          }
                          muted
                          playsInline
                          preload="auto"
                          style={{
                            position: 'absolute',
                            left: liveResultRect.domLeft,
                            top: liveResultRect.domTop,
                            width: liveResultRect.domWidth,
                            height: liveResultRect.domHeight,
                            maxWidth: 'none',
                          }}
                          className="pointer-events-none"
                        />
                      ))}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Drag on the darkened area to draw a new box, or drag corners to resize.
                  </p>
                </div>

                {/* Facecam Active Duration Option */}
                <div className="rounded-xl border border-white/10 bg-[#111521] p-3 space-y-2 text-xs">
                  <span className="text-[11px] font-semibold text-slate-200 block">
                    Facecam Duration in Short
                  </span>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 cursor-pointer text-[11px] text-slate-300">
                      <input
                        type="radio"
                        name="fc-dur-mode"
                        checked={durationMode === 'full'}
                        onChange={() => setDurationMode('full')}
                        className="accent-violet-500"
                      />
                      <span>Full Video Duration ({formatTimecode(effectiveDuration)})</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-[11px] text-slate-300">
                      <input
                        type="radio"
                        name="fc-dur-mode"
                        checked={durationMode === 'timeline'}
                        onChange={() => setDurationMode('timeline')}
                        className="accent-violet-500"
                      />
                      <span>
                        Match Timeline Clip ({formatTimecode(timelineInPoint)} –{' '}
                        {formatTimecode(timelineOutPoint)})
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-[11px] text-slate-300">
                      <input
                        type="radio"
                        name="fc-dur-mode"
                        checked={durationMode === 'custom'}
                        onChange={() => setDurationMode('custom')}
                        className="accent-violet-500"
                      />
                      <span>Custom Range (seconds)</span>
                    </label>
                  </div>

                  {durationMode === 'custom' && (
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <label className="space-y-0.5 text-[10px] text-slate-400">
                        <span>Start (sec)</span>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={customStart}
                          onChange={(e) => setCustomStart(Math.max(0, Number(e.target.value) || 0))}
                          className="w-full px-2 py-1 rounded bg-[#07080D] border border-white/10 font-mono text-xs text-white"
                        />
                      </label>
                      <label className="space-y-0.5 text-[10px] text-slate-400">
                        <span>End (sec)</span>
                        <input
                          type="number"
                          min={0.5}
                          step={0.5}
                          value={customEnd}
                          onChange={(e) => setCustomEnd(Math.max(0.5, Number(e.target.value) || 1))}
                          className="w-full px-2 py-1 rounded bg-[#07080D] border border-white/10 font-mono text-xs text-white"
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-3 bg-[#090B12]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] text-slate-300 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!activeSource}
            onClick={handleApply}
            className="px-5 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white inline-flex items-center gap-2 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply Facecam Crop to 9:16 Preview</span>
          </button>
        </div>
      </div>
    </div>
  );
};
