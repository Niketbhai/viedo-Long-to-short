import React, { useEffect, useRef, useState } from 'react';
import {
  Columns2,
  Crop,
  GripHorizontal,
  GripVertical,
  Maximize2,
  Move,
  RotateCcw,
  Rows2,
  Volume2,
  VolumeX,
  ZoomIn,
} from 'lucide-react';
import {
  LayoutConfig,
  SplitLayoutMode,
  VideoRole,
  VideoSource,
} from '../types/editor';
import {
  computeCropAndCover,
  computeZoneBoxes,
  DEFAULT_TRANSFORM,
  hasActiveCrop,
} from '../utils/layoutGeometry';
import { clamp, formatShortDuration } from '../utils/time';
import { SmartVideo } from './SmartVideo';
import { YouTubeEmbedPlayer, YouTubePlayerHandle } from './YouTubeEmbedPlayer';

interface ShortsPreview9x16Props {
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  previewGameplayRef: React.RefObject<HTMLVideoElement | null>;
  previewFacecamRef: React.RefObject<HTMLVideoElement | null>;
  ytGameplayRef: React.RefObject<YouTubePlayerHandle | null>;
  ytFacecamRef: React.RefObject<YouTubePlayerHandle | null>;
  onYouTubeMetadata: (role: VideoRole, duration: number, title?: string) => void;
  layout: LayoutConfig;
  currentTime: number;
  selectedDuration: number;
  isPreviewingClip: boolean;
  onChangeLayout: (updater: (prev: LayoutConfig) => LayoutConfig) => void;
  onOpenFacecamCrop: () => void;
}

const LAYOUT_BUTTONS: { mode: SplitLayoutMode; label: string; icon: React.ReactNode }[] = [
  { mode: 'gameplay-top', label: 'Game Top', icon: <Rows2 className="w-3.5 h-3.5" /> },
  { mode: 'facecam-top', label: 'Cam Top', icon: <Rows2 className="w-3.5 h-3.5 rotate-180" /> },
  { mode: 'side-by-side', label: 'Side Split', icon: <Columns2 className="w-3.5 h-3.5" /> },
  { mode: 'full-gameplay', label: 'Full Game', icon: <Maximize2 className="w-3.5 h-3.5" /> },
  { mode: 'full-facecam', label: 'Full Cam', icon: <Maximize2 className="w-3.5 h-3.5" /> },
];

export const ShortsPreview9x16: React.FC<ShortsPreview9x16Props> = ({
  gameplay,
  facecam,
  previewGameplayRef,
  previewFacecamRef,
  ytGameplayRef,
  ytFacecamRef,
  onYouTubeMetadata,
  layout,
  currentTime,
  selectedDuration,
  isPreviewingClip,
  onChangeLayout,
  onOpenFacecamCrop,
}) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 225, height: 400 });
  const [activeLayer, setActiveLayer] = useState<VideoRole>('gameplay');
  const [draggingDivider, setDraggingDivider] = useState(false);

  // Measure actual 9:16 stage pixel dimensions for 1:1 parity with Canvas export
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zones = computeZoneBoxes(
    stageSize.width,
    stageSize.height,
    layout.mode,
    layout.splitRatio
  );

  // Interactive pan dragging inside a video zone
  const handleZonePointerDown = (
    role: VideoRole,
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    e.preventDefault();
    setActiveLayer(role);
    const startX = e.clientX;
    const startY = e.clientY;
    const initialTransform =
      role === 'gameplay' ? layout.gameplayTransform : layout.facecamTransform;

    const zone = role === 'gameplay' ? zones.gameplay : zones.facecam;
    const src = role === 'gameplay' ? gameplay : facecam;
    if (!zone || !src) return;

    const drawRect = computeCropAndCover(src.width, src.height, zone, initialTransform);
    const maxOverflowX = Math.max(20, (drawRect.dw - zone.width) / 2);
    const maxOverflowY = Math.max(20, (drawRect.dh - zone.height) / 2);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const nextPanX = clamp(initialTransform.panX + dx / maxOverflowX, -1, 1);
      const nextPanY = clamp(initialTransform.panY + dy / maxOverflowY, -1, 1);

      onChangeLayout((prev) => ({
        ...prev,
        [role === 'gameplay' ? 'gameplayTransform' : 'facecamTransform']: {
          ...prev[role === 'gameplay' ? 'gameplayTransform' : 'facecamTransform'],
          panX: nextPanX,
          panY: nextPanY,
        },
      }));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Mouse wheel zoom inside a video zone
  const handleZoneWheel = (role: VideoRole, e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    setActiveLayer(role);
    const delta = e.deltaY < 0 ? 0.12 : -0.12;
    onChangeLayout((prev) => {
      const key = role === 'gameplay' ? 'gameplayTransform' : 'facecamTransform';
      const current = prev[key];
      return {
        ...prev,
        [key]: {
          ...current,
          zoom: clamp(Number((current.zoom + delta).toFixed(2)), 1, 3.5),
        },
      };
    });
  };

  // Interactive split-divider resizing directly on the 9:16 stage
  const handleDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const stageEl = stageRef.current;
    if (!stageEl) return;
    setDraggingDivider(true);

    const rect = stageEl.getBoundingClientRect();
    const isHorizontalSplit = layout.mode === 'side-by-side';

    const onMove = (ev: PointerEvent) => {
      const nextRatio = isHorizontalSplit
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;

      onChangeLayout((prev) => ({
        ...prev,
        splitRatio: clamp(Number(nextRatio.toFixed(3)), 0.15, 0.85),
      }));
    };

    const onUp = () => {
      setDraggingDivider(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const activeTransform =
    activeLayer === 'gameplay' ? layout.gameplayTransform : layout.facecamTransform;

  const updateActiveTransform = (patch: Partial<typeof DEFAULT_TRANSFORM>) => {
    onChangeLayout((prev) => {
      const key = activeLayer === 'gameplay' ? 'gameplayTransform' : 'facecamTransform';
      return {
        ...prev,
        [key]: { ...prev[key], ...patch },
      };
    });
  };

  const gpRect =
    zones.gameplay && gameplay
      ? computeCropAndCover(gameplay.width, gameplay.height, zones.gameplay, layout.gameplayTransform)
      : null;
  const fcRect =
    zones.facecam && facecam
      ? computeCropAndCover(facecam.width, facecam.height, zones.facecam, layout.facecamTransform)
      : null;

  const isFacecamInActiveRange =
    !layout.facecamActiveRange ||
    (currentTime >= layout.facecamActiveRange.start - 0.05 &&
      currentTime <= layout.facecamActiveRange.end + 0.05);

  const isDurationOptimal = selectedDuration > 0 && selectedDuration <= 60;

  return (
    <aside className="rounded-xl border border-white/[0.08] bg-[#0C0F17] flex flex-col min-h-0 h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-white/[0.07] flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-200 whitespace-nowrap">
          9:16 Shorts Preview
        </span>
        <span
          className={`text-[11px] font-mono tabular-nums whitespace-nowrap ${
            isPreviewingClip
              ? 'text-sky-400'
              : isDurationOptimal
                ? 'text-violet-300'
                : 'text-amber-400'
          }`}
        >
          {isPreviewingClip ? 'Looping Clip · ' : ''}
          {formatShortDuration(selectedDuration)}
          {selectedDuration > 60 ? ' (>60s)' : ' Shorts Ready'}
        </span>
      </div>

      {/* Stage & Controls Scroll Body */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5">
        {/* Vertical 9:16 Preview Frame */}
        <div className="flex justify-center">
          <div
            ref={stageRef}
            className="relative w-[216px] sm:w-[234px] aspect-[9/16] rounded-xl overflow-hidden bg-[#05060A] border border-white/15 shadow-2xl select-none"
          >
            {/* Gameplay Zone */}
            {zones.gameplay && (
              <div
                onPointerDown={(e) => handleZonePointerDown('gameplay', e)}
                onWheel={(e) => handleZoneWheel('gameplay', e)}
                style={{
                  left: zones.gameplay.x,
                  top: zones.gameplay.y,
                  width: zones.gameplay.width,
                  height: zones.gameplay.height,
                }}
                className={`absolute overflow-hidden cursor-grab active:cursor-grabbing group ${
                  activeLayer === 'gameplay' ? 'ring-1 ring-inset ring-sky-400/50' : ''
                }`}
              >
                {gameplay && gpRect ? (
                  gameplay.sourceType === 'youtube' && gameplay.youtubeId ? (
                    <>
                      <YouTubeEmbedPlayer
                        key={gameplay.id}
                        ref={ytGameplayRef}
                        videoId={gameplay.youtubeId}
                        muted={layout.gameplayMuted}
                        volume={layout.gameplayVolume}
                        onMetadata={(dur, title) =>
                          onYouTubeMetadata('gameplay', dur, title)
                        }
                        style={{
                          position: 'absolute',
                          left: gpRect.domLeft,
                          top: gpRect.domTop,
                          width: gpRect.domWidth,
                          height: gpRect.domHeight,
                          maxWidth: 'none',
                        }}
                        className="pointer-events-none"
                      />
                      <div className="absolute inset-0 z-10" />
                    </>
                  ) : (
                    <SmartVideo
                      key={gameplay.id}
                      ref={previewGameplayRef}
                      src={gameplay.url}
                      isHls={gameplay.isHls}
                      crossOrigin={
                        gameplay.sourceType === 'url' && gameplay.corsSafe
                          ? 'anonymous'
                          : undefined
                      }
                      playsInline
                      preload="auto"
                      style={{
                        position: 'absolute',
                        left: gpRect.domLeft,
                        top: gpRect.domTop,
                        width: gpRect.domWidth,
                        height: gpRect.domHeight,
                        maxWidth: 'none',
                      }}
                      className="pointer-events-none"
                    />
                  )
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center bg-[#0B101C] text-center p-3">
                    <span className="text-[11px] font-semibold text-sky-400">
                      Gameplay Slot
                    </span>
                    <span className="text-[10px] text-slate-500 mt-0.5">
                      Upload gameplay video
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Facecam Zone */}
            {zones.facecam && (
              <div
                onPointerDown={(e) => handleZonePointerDown('facecam', e)}
                onWheel={(e) => handleZoneWheel('facecam', e)}
                style={{
                  left: zones.facecam.x,
                  top: zones.facecam.y,
                  width: zones.facecam.width,
                  height: zones.facecam.height,
                }}
                className={`absolute overflow-hidden cursor-grab active:cursor-grabbing group ${
                  activeLayer === 'facecam' ? 'ring-1 ring-inset ring-violet-400/60' : ''
                }`}
              >
                {facecam && fcRect ? (
                  facecam.sourceType === 'youtube' && facecam.youtubeId ? (
                    <>
                      <YouTubeEmbedPlayer
                        key={facecam.id}
                        ref={ytFacecamRef}
                        videoId={facecam.youtubeId}
                        muted={layout.facecamMuted}
                        volume={layout.facecamVolume}
                        onMetadata={(dur, title) =>
                          onYouTubeMetadata('facecam', dur, title)
                        }
                        style={{
                          position: 'absolute',
                          left: fcRect.domLeft,
                          top: fcRect.domTop,
                          width: fcRect.domWidth,
                          height: fcRect.domHeight,
                          maxWidth: 'none',
                          opacity: isFacecamInActiveRange ? 1 : 0,
                        }}
                        className="pointer-events-none"
                      />
                      <div className="absolute inset-0 z-10" />
                    </>
                  ) : (
                    <SmartVideo
                      key={facecam.id}
                      ref={previewFacecamRef}
                      src={facecam.url}
                      isHls={facecam.isHls}
                      crossOrigin={
                        facecam.sourceType === 'url' && facecam.corsSafe
                          ? 'anonymous'
                          : undefined
                      }
                      playsInline
                      preload="auto"
                      style={{
                        position: 'absolute',
                        left: fcRect.domLeft,
                        top: fcRect.domTop,
                        width: fcRect.domWidth,
                        height: fcRect.domHeight,
                        maxWidth: 'none',
                        opacity: isFacecamInActiveRange ? 1 : 0,
                      }}
                      className="pointer-events-none"
                    />
                  )
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center bg-[#120E1E] text-center p-3 gap-2">
                    <span className="text-[11px] font-semibold text-violet-400">
                      Facecam Slot
                    </span>
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFacecamCrop();
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                    >
                      <Crop className="w-3 h-3" />
                      <span>{gameplay ? 'Crop Facecam from Video' : 'Crop Facecam'}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Interactive Split Divider Handle */}
            {zones.gameplay && zones.facecam && (
              <div
                onPointerDown={handleDividerPointerDown}
                title="Drag to resize split areas"
                style={
                  layout.mode === 'side-by-side'
                    ? {
                        left: zones.gameplay.width - 6,
                        top: 0,
                        bottom: 0,
                        width: 12,
                      }
                    : {
                        top:
                          (layout.mode === 'gameplay-top'
                            ? zones.gameplay.height
                            : zones.facecam.height) - 6,
                        left: 0,
                        right: 0,
                        height: 12,
                      }
                }
                className={`absolute z-20 flex items-center justify-center ${
                  layout.mode === 'side-by-side' ? 'cursor-ew-resize' : 'cursor-ns-resize'
                }`}
              >
                <div
                  className={`rounded-full flex items-center justify-center transition-colors ${
                    draggingDivider
                      ? 'bg-violet-500 text-white shadow-lg'
                      : 'bg-black/80 border border-white/25 text-slate-200 hover:bg-violet-600 hover:border-violet-400'
                  } ${layout.mode === 'side-by-side' ? 'w-4 h-8' : 'w-8 h-4'}`}
                >
                  {layout.mode === 'side-by-side' ? (
                    <GripVertical className="w-3 h-3" />
                  ) : (
                    <GripHorizontal className="w-3 h-3" />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Hidden video/iframe fallbacks when a layer is toggled off in Full mode */}
        {!zones.facecam && facecam && (
          facecam.sourceType === 'youtube' && facecam.youtubeId ? (
            <YouTubeEmbedPlayer
              key={`hidden_${facecam.id}`}
              ref={ytFacecamRef}
              videoId={facecam.youtubeId}
              muted={layout.facecamMuted}
              volume={layout.facecamVolume}
              onMetadata={(dur, title) => onYouTubeMetadata('facecam', dur, title)}
              className="hidden"
            />
          ) : (
            <SmartVideo
              key={`hidden_${facecam.id}`}
              ref={previewFacecamRef}
              src={facecam.url}
              isHls={facecam.isHls}
              crossOrigin={
                facecam.sourceType === 'url' && facecam.corsSafe ? 'anonymous' : undefined
              }
              playsInline
              preload="auto"
              className="hidden"
            />
          )
        )}
        {!zones.gameplay && gameplay && (
          gameplay.sourceType === 'youtube' && gameplay.youtubeId ? (
            <YouTubeEmbedPlayer
              key={`hidden_${gameplay.id}`}
              ref={ytGameplayRef}
              videoId={gameplay.youtubeId}
              muted={layout.gameplayMuted}
              volume={layout.gameplayVolume}
              onMetadata={(dur, title) => onYouTubeMetadata('gameplay', dur, title)}
              className="hidden"
            />
          ) : (
            <SmartVideo
              key={`hidden_${gameplay.id}`}
              ref={previewGameplayRef}
              src={gameplay.url}
              isHls={gameplay.isHls}
              crossOrigin={
                gameplay.sourceType === 'url' && gameplay.corsSafe ? 'anonymous' : undefined
              }
              playsInline
              preload="auto"
              className="hidden"
            />
          )
        )}

        {/* Layout Mode Presets */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-slate-300">Split Layout</span>
            {zones.gameplay && zones.facecam && (
              <span className="font-mono tabular-nums text-slate-400">
                {Math.round(layout.splitRatio * 100)}% / {Math.round((1 - layout.splitRatio) * 100)}%
              </span>
            )}
          </div>
          <div className="grid grid-cols-5 gap-1">
            {LAYOUT_BUTTONS.map((btn) => {
              const active = layout.mode === btn.mode;
              return (
                <button
                  key={btn.mode}
                  type="button"
                  onClick={() =>
                    onChangeLayout((prev) => ({
                      ...prev,
                      mode: btn.mode,
                    }))
                  }
                  className={`px-1.5 py-2 rounded-lg border text-[10px] font-medium flex flex-col items-center gap-1 transition-colors cursor-pointer ${
                    active
                      ? 'border-violet-500/70 bg-violet-500/20 text-white'
                      : 'border-white/[0.07] bg-[#111521] text-slate-400 hover:text-slate-200 hover:border-white/15'
                  }`}
                >
                  {btn.icon}
                  <span className="truncate max-w-full">{btn.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Manual Split Size Slider (when both layers visible) */}
        {zones.gameplay && zones.facecam && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">Split Area Resize</span>
              <button
                type="button"
                onClick={() => onChangeLayout((prev) => ({ ...prev, splitRatio: 0.5 }))}
                className="text-sky-400 hover:text-sky-300 cursor-pointer"
              >
                50 / 50
              </button>
            </div>
            <input
              type="range"
              min={0.15}
              max={0.85}
              step={0.01}
              value={layout.splitRatio}
              onChange={(e) =>
                onChangeLayout((prev) => ({
                  ...prev,
                  splitRatio: parseFloat(e.target.value),
                }))
              }
              aria-label="Split screen ratio"
              className="w-full studio-slider"
            />
          </div>
        )}

        {/* Zoom & Reposition Inspector */}
        <div className="pt-2 border-t border-white/[0.07] space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#07080D] border border-white/[0.07]">
              <button
                type="button"
                onClick={() => setActiveLayer('gameplay')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  activeLayer === 'gameplay'
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Gameplay Crop
              </button>
              <button
                type="button"
                onClick={() => setActiveLayer('facecam')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  activeLayer === 'facecam'
                    ? 'bg-violet-500/20 text-violet-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Facecam Crop
              </button>
            </div>

            <div className="flex items-center gap-2">
              {activeLayer === 'facecam' && (
                <button
                  type="button"
                  onClick={onOpenFacecamCrop}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    hasActiveCrop(layout.facecamTransform.crop)
                      ? 'bg-violet-600 text-white'
                      : 'bg-violet-500/20 hover:bg-violet-500/30 text-violet-200'
                  }`}
                >
                  <Crop className="w-3 h-3" />
                  <span>Hand Crop</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => updateActiveTransform({ ...DEFAULT_TRANSFORM, crop: undefined })}
                title="Reset zoom, crop and position"
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset</span>
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="inline-flex items-center gap-1 text-slate-400">
                <ZoomIn className="w-3 h-3" />
                <span>Zoom</span>
              </span>
              <span className="font-mono tabular-nums text-slate-300">
                {activeTransform.zoom.toFixed(2)}×
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={3.5}
              step={0.05}
              value={activeTransform.zoom}
              onChange={(e) => updateActiveTransform({ zoom: parseFloat(e.target.value) })}
              aria-label="Layer zoom"
              className={`w-full studio-slider ${activeLayer === 'gameplay' ? 'blue' : ''}`}
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <div className="flex items-center justify-between text-[11px] text-slate-400 mb-0.5">
                <span className="inline-flex items-center gap-1">
                  <Move className="w-3 h-3" /> Pan X
                </span>
                <span className="font-mono tabular-nums">
                  {Math.round(activeTransform.panX * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.02}
                value={activeTransform.panX}
                onChange={(e) => updateActiveTransform({ panX: parseFloat(e.target.value) })}
                aria-label="Horizontal pan"
                className={`w-full studio-slider ${activeLayer === 'gameplay' ? 'blue' : ''}`}
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-[11px] text-slate-400 mb-0.5">
                <span className="inline-flex items-center gap-1">
                  <Move className="w-3 h-3" /> Pan Y
                </span>
                <span className="font-mono tabular-nums">
                  {Math.round(activeTransform.panY * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.02}
                value={activeTransform.panY}
                onChange={(e) => updateActiveTransform({ panY: parseFloat(e.target.value) })}
                aria-label="Vertical pan"
                className={`w-full studio-slider ${activeLayer === 'gameplay' ? 'blue' : ''}`}
              />
            </div>
          </div>
        </div>

        {/* Audio Mix & Facecam Sync */}
        <div className="pt-2 border-t border-white/[0.07] space-y-2">
          <span className="text-[11px] font-semibold text-slate-300 block">
            Audio Mix & Facecam Sync
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onChangeLayout((prev) => ({ ...prev, gameplayMuted: !prev.gameplayMuted }))
              }
              className="p-1.5 rounded bg-white/[0.05] hover:bg-white/[0.1] text-sky-400 cursor-pointer"
              title={layout.gameplayMuted ? 'Unmute gameplay' : 'Mute gameplay'}
            >
              {layout.gameplayMuted ? (
                <VolumeX className="w-3.5 h-3.5 text-slate-500" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
            </button>
            <span className="text-[11px] text-slate-400 w-16 shrink-0">Game Vol</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={layout.gameplayMuted ? 0 : layout.gameplayVolume}
              onChange={(e) =>
                onChangeLayout((prev) => ({
                  ...prev,
                  gameplayMuted: false,
                  gameplayVolume: parseFloat(e.target.value),
                }))
              }
              aria-label="Gameplay volume"
              className="flex-1 studio-slider blue"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onChangeLayout((prev) => ({ ...prev, facecamMuted: !prev.facecamMuted }))
              }
              className="p-1.5 rounded bg-white/[0.05] hover:bg-white/[0.1] text-violet-400 cursor-pointer"
              title={layout.facecamMuted ? 'Unmute facecam' : 'Mute facecam'}
            >
              {layout.facecamMuted ? (
                <VolumeX className="w-3.5 h-3.5 text-slate-500" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
            </button>
            <span className="text-[11px] text-slate-400 w-16 shrink-0">Cam Vol</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={layout.facecamMuted ? 0 : layout.facecamVolume}
              onChange={(e) =>
                onChangeLayout((prev) => ({
                  ...prev,
                  facecamMuted: false,
                  facecamVolume: parseFloat(e.target.value),
                }))
              }
              aria-label="Facecam volume"
              className="flex-1 studio-slider"
            />
          </div>

          {facecam && (
            <div className="pt-1 space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Facecam Sync Offset</span>
                <span className="font-mono tabular-nums text-slate-300">
                  {layout.facecamSyncOffset >= 0 ? '+' : ''}
                  {layout.facecamSyncOffset.toFixed(2)}s
                </span>
              </div>
              <input
                type="range"
                min={-5}
                max={5}
                step={0.05}
                value={layout.facecamSyncOffset}
                onChange={(e) =>
                  onChangeLayout((prev) => ({
                    ...prev,
                    facecamSyncOffset: parseFloat(e.target.value),
                  }))
                }
                aria-label="Facecam sync offset"
                className="w-full studio-slider"
              />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
