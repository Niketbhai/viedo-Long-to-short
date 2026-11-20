import React, { useMemo, useRef, useState } from 'react';
import { ZoomIn } from 'lucide-react';
import { ShortClip, TimelineSegment, VideoSource } from '../types/editor';
import { clamp, formatShortDuration, formatTimecode } from '../utils/time';

interface TimelineEditorProps {
  duration: number;
  currentTime: number;
  inPoint: number;
  outPoint: number;
  segments: TimelineSegment[];
  selectedSegmentId: string | null;
  clips: ShortClip[];
  activeClipId: string | null;
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  facecamSyncOffset: number;
  onSeek: (time: number) => void;
  onChangeInPoint: (time: number) => void;
  onChangeOutPoint: (time: number) => void;
  onSelectSegment: (segmentId: string) => void;
  onSelectClip: (clipId: string) => void;
}

export const TimelineEditor: React.FC<TimelineEditorProps> = ({
  duration,
  currentTime,
  inPoint,
  outPoint,
  segments,
  selectedSegmentId,
  clips,
  activeClipId,
  gameplay,
  facecam,
  facecamSyncOffset,
  onSeek,
  onChangeInPoint,
  onChangeOutPoint,
  onSelectSegment,
  onSelectClip,
}) => {
  const [zoom, setZoom] = useState(1);
  const trackContainerRef = useRef<HTMLDivElement>(null);

  const safeDuration = Math.max(duration, 1);

  const ticks = useMemo(() => {
    const approxIntervals = Math.max(4, Math.round(8 * zoom));
    const rawStep = safeDuration / approxIntervals;
    const niceSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = niceSteps.find((s) => s >= rawStep) ?? 600;
    const result: number[] = [];
    for (let t = 0; t <= safeDuration; t += step) {
      result.push(Number(t.toFixed(2)));
    }
    return result;
  }, [safeDuration, zoom]);

  const timeFromClientX = (clientX: number): number => {
    const el = trackContainerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return Number((frac * safeDuration).toFixed(2));
  };

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    e.preventDefault();
    onSeek(timeFromClientX(e.clientX));

    const onMove = (ev: PointerEvent) => {
      onSeek(timeFromClientX(ev.clientX));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleInHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    e.preventDefault();
    e.stopPropagation();

    const onMove = (ev: PointerEvent) => {
      const t = clamp(timeFromClientX(ev.clientX), 0, Math.max(0, outPoint - 0.2));
      onChangeInPoint(t);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleOutHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    e.preventDefault();
    e.stopPropagation();

    const onMove = (ev: PointerEvent) => {
      const t = clamp(
        timeFromClientX(ev.clientX),
        Math.min(safeDuration, inPoint + 0.2),
        safeDuration
      );
      onChangeOutPoint(t);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const playheadPct = duration > 0 ? clamp((currentTime / safeDuration) * 100, 0, 100) : 0;
  const inPct = duration > 0 ? clamp((inPoint / safeDuration) * 100, 0, 100) : 0;
  const outPct = duration > 0 ? clamp((outPoint / safeDuration) * 100, 0, 100) : 100;
  const selectedLen = Math.max(0, outPoint - inPoint);

  return (
    <section className="rounded-xl border border-white/[0.08] bg-[#0C0F17] flex flex-col overflow-hidden shrink-0">
      {/* Timeline Toolbar */}
      <div className="px-4 py-2 border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-3 bg-[#0A0D14]">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="font-semibold text-slate-200">Timeline</span>
          <div className="flex items-center gap-3 font-mono tabular-nums text-[11px] text-slate-400">
            <span>
              In <strong className="text-sky-300 font-medium">{formatTimecode(inPoint)}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Out <strong className="text-sky-300 font-medium">{formatTimecode(outPoint)}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Range{' '}
              <strong className="text-violet-300 font-medium">
                {formatShortDuration(selectedLen)}
              </strong>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
            <ZoomIn className="w-3.5 h-3.5" />
            <span className="font-mono tabular-nums w-7">{zoom.toFixed(1)}×</span>
          </span>
          <input
            type="range"
            min={1}
            max={8}
            step={0.25}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            aria-label="Timeline zoom"
            className="w-24 studio-slider blue"
          />
          {zoom > 1 && (
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
            >
              Fit
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Multi-Track Canvas */}
      <div className="flex overflow-hidden">
        {/* Left Track Labels */}
        <div className="w-24 sm:w-28 shrink-0 border-r border-white/[0.07] bg-[#0A0C12] select-none">
          <div className="h-6 border-b border-white/[0.06] px-3 flex items-center text-[10px] font-mono text-slate-500">
            TIME
          </div>
          <div className="h-8 border-b border-white/[0.06] px-3 flex items-center text-[11px] font-medium text-slate-300">
            Segments
          </div>
          <div className="h-8 border-b border-white/[0.06] px-3 flex items-center text-[11px] font-medium text-sky-300">
            Gameplay
          </div>
          <div className="h-8 border-b border-white/[0.06] px-3 flex items-center text-[11px] font-medium text-violet-300">
            Facecam
          </div>
          <div className="h-8 px-3 flex items-center text-[11px] font-medium text-slate-300">
            Shorts Clips
          </div>
        </div>

        {/* Horizontally Scrollable Tracks */}
        <div className="flex-1 overflow-x-auto bg-[#07090F]">
          <div
            ref={trackContainerRef}
            style={{ width: `${zoom * 100}%`, minWidth: '100%' }}
            className="relative select-none"
          >
            {/* Time Ruler */}
            <div
              onPointerDown={handleRulerPointerDown}
              className="relative h-6 border-b border-white/[0.07] bg-[#0B0E16] cursor-pointer"
            >
              {ticks.map((t) => {
                const leftPct = (t / safeDuration) * 100;
                return (
                  <div
                    key={t}
                    style={{ left: `${leftPct}%` }}
                    className="absolute top-0 bottom-0 flex flex-col justify-between pointer-events-none"
                  >
                    <div className="w-px h-2 bg-white/25" />
                    <span className="text-[10px] font-mono tabular-nums text-slate-500 pl-1 -translate-y-0.5 whitespace-nowrap">
                      {formatTimecode(t)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* In/Out Highlight Bracket Overlay across tracks */}
            {duration > 0 && (
              <div
                style={{
                  left: `${inPct}%`,
                  width: `${Math.max(0.4, outPct - inPct)}%`,
                }}
                className="absolute top-6 bottom-0 bg-violet-500/[0.08] border-x border-sky-400/70 pointer-events-none z-10"
              >
                {/* Draggable In Handle */}
                <div
                  onPointerDown={handleInHandleDown}
                  title="Drag to adjust Start Point"
                  className="absolute -left-2 top-0 bottom-0 w-4 cursor-ew-resize pointer-events-auto flex items-start justify-center group"
                >
                  <div className="w-2.5 h-5 rounded-b bg-sky-400 group-hover:bg-sky-300 shadow" />
                </div>

                {/* Draggable Out Handle */}
                <div
                  onPointerDown={handleOutHandleDown}
                  title="Drag to adjust End Point"
                  className="absolute -right-2 top-0 bottom-0 w-4 cursor-ew-resize pointer-events-auto flex items-start justify-center group"
                >
                  <div className="w-2.5 h-5 rounded-b bg-sky-400 group-hover:bg-sky-300 shadow" />
                </div>
              </div>
            )}

            {/* Track 1: Segments (Split / Delete Segment) */}
            <div
              onPointerDown={handleRulerPointerDown}
              className="relative h-8 border-b border-white/[0.06] cursor-pointer"
            >
              {duration > 0 &&
                segments.map((seg) => {
                  const leftPct = (seg.start / safeDuration) * 100;
                  const widthPct = ((seg.end - seg.start) / safeDuration) * 100;
                  const isSel = seg.id === selectedSegmentId;
                  return (
                    <button
                      key={seg.id}
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectSegment(seg.id);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onChangeInPoint(seg.start);
                        onChangeOutPoint(seg.end);
                        onSeek(seg.start);
                      }}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={`${seg.label} (${formatTimecode(seg.start)} – ${formatTimecode(seg.end)}). Double-click to select range.`}
                      className={`absolute top-1 bottom-1 rounded px-2 text-left text-[10px] font-medium truncate transition-colors cursor-pointer ${
                        isSel
                          ? 'bg-sky-500/30 border border-sky-400 text-white'
                          : 'bg-white/[0.07] border border-white/10 text-slate-300 hover:bg-white/[0.12]'
                      }`}
                    >
                      {seg.label}
                    </button>
                  );
                })}
            </div>

            {/* Track 2: Gameplay */}
            <div
              onPointerDown={handleRulerPointerDown}
              className="relative h-8 border-b border-white/[0.06] cursor-pointer"
            >
              {gameplay && (
                <div
                  style={{
                    left: '0%',
                    width: `${clamp((gameplay.duration / safeDuration) * 100, 1, 100)}%`,
                  }}
                  className="absolute top-1 bottom-1 rounded bg-sky-500/20 border border-sky-400/40 px-2 flex items-center text-[10px] text-sky-200 truncate pointer-events-none"
                >
                  {gameplay.name}
                </div>
              )}
            </div>

            {/* Track 3: Facecam */}
            <div
              onPointerDown={handleRulerPointerDown}
              className="relative h-8 border-b border-white/[0.06] cursor-pointer"
            >
              {facecam && (
                <div
                  style={{
                    left: `${clamp(((-facecamSyncOffset) / safeDuration) * 100, -50, 95)}%`,
                    width: `${clamp((facecam.duration / safeDuration) * 100, 1, 100)}%`,
                  }}
                  className="absolute top-1 bottom-1 rounded bg-violet-500/20 border border-violet-400/40 px-2 flex items-center text-[10px] text-violet-200 truncate pointer-events-none"
                >
                  {facecam.name}
                </div>
              )}
            </div>

            {/* Track 4: Created Shorts Clips */}
            <div
              onPointerDown={handleRulerPointerDown}
              className="relative h-8 cursor-pointer"
            >
              {clips.map((clip) => {
                const leftPct = (clip.startTime / safeDuration) * 100;
                const widthPct = Math.max(
                  0.8,
                  ((clip.endTime - clip.startTime) / safeDuration) * 100
                );
                const isActive = clip.id === activeClipId;
                return (
                  <button
                    key={clip.id}
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectClip(clip.id);
                    }}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    title={`${clip.name} (${formatShortDuration(clip.endTime - clip.startTime)})`}
                    className={`absolute top-1.5 bottom-1.5 rounded px-2 text-left text-[10px] font-semibold truncate transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-violet-600 text-white border border-violet-300'
                        : 'bg-violet-500/35 text-violet-100 border border-violet-400/50 hover:bg-violet-500/50'
                    }`}
                  >
                    {clip.name}
                  </button>
                );
              })}
            </div>

            {/* Playhead Needle */}
            {duration > 0 && (
              <div
                style={{ left: `${playheadPct}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-white z-20 pointer-events-none shadow-[0_0_8px_rgba(255,255,255,0.65)]"
              >
                <div className="w-3 h-3 -ml-[5px] bg-white rotate-45 -mt-1.5 rounded-[1px]" />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
