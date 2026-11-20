import React, { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  SplitSquareHorizontal,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import { VideoRole, VideoSource } from '../types/editor';
import { formatTimecode } from '../utils/time';
import { SmartVideo } from './SmartVideo';
import { YouTubeEmbedPlayer, YouTubePlayerHandle } from './YouTubeEmbedPlayer';

interface SourcePlayerProps {
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  monitorRole: VideoRole;
  onChangeMonitorRole: (role: VideoRole) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  ytSourceRef: React.RefObject<YouTubePlayerHandle | null>;
  onSourceMetadata: (role: VideoRole, duration: number, width?: number, height?: number, title?: string) => void;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  selectedSegmentId: string | null;
  canDeleteSegment: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onStepFrame: (deltaFrames: number) => void;
  onSetInPoint: () => void;
  onSetOutPoint: () => void;
  onApplyDuration: (seconds: number) => void;
  onCutClip: () => void;
  onSplitSegment: () => void;
  onDeleteSegment: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenImport: () => void;
}

export const SourcePlayer: React.FC<SourcePlayerProps> = ({
  gameplay,
  facecam,
  monitorRole,
  onChangeMonitorRole,
  videoRef,
  ytSourceRef,
  onSourceMetadata,
  isPlaying,
  currentTime,
  duration,
  inPoint,
  outPoint,
  selectedSegmentId,
  canDeleteSegment,
  canUndo,
  canRedo,
  onTogglePlay,
  onSeek,
  onStepFrame,
  onSetInPoint,
  onSetOutPoint,
  onApplyDuration,
  onCutClip,
  onSplitSegment,
  onDeleteSegment,
  onUndo,
  onRedo,
  onOpenImport,
}) => {
  const [customSec, setCustomSec] = useState('30');
  const [videoError, setVideoError] = useState<string | null>(null);

  const activeSource =
    monitorRole === 'facecam' && facecam ? facecam : gameplay || facecam;

  const hasMedia = Boolean(gameplay || facecam);
  const inPct = duration > 0 ? (inPoint / duration) * 100 : 0;
  const outPct = duration > 0 ? (outPoint / duration) * 100 : 100;

  return (
    <section className="rounded-xl border border-white/[0.08] bg-[#0C0F17] flex flex-col min-w-0 overflow-hidden">
      {/* Monitor Header */}
      <div className="px-4 py-2.5 border-b border-white/[0.07] flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-semibold text-slate-200 whitespace-nowrap">
            Source Monitor
          </span>
          {activeSource && (
            <span className="text-xs text-slate-400 truncate">
              {activeSource.name}
            </span>
          )}
        </div>

        {gameplay && facecam && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#07080D] border border-white/[0.07] shrink-0">
            <button
              type="button"
              onClick={() => {
                setVideoError(null);
                onChangeMonitorRole('gameplay');
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                monitorRole === 'gameplay'
                  ? 'bg-sky-500/20 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Gameplay
            </button>
            <button
              type="button"
              onClick={() => {
                setVideoError(null);
                onChangeMonitorRole('facecam');
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                monitorRole === 'facecam'
                  ? 'bg-violet-500/20 text-violet-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Facecam
            </button>
          </div>
        )}
      </div>

      {/* Main Video Canvas */}
      <div className="relative bg-[#05060A] flex-1 min-h-[260px] lg:min-h-[340px] flex items-center justify-center overflow-hidden">
        {activeSource ? (
          <>
            {activeSource.sourceType === 'youtube' && activeSource.youtubeId ? (
              <div className="relative w-full h-full flex items-center justify-center">
                <YouTubeEmbedPlayer
                  key={activeSource.id}
                  ref={ytSourceRef}
                  videoId={activeSource.youtubeId}
                  muted={true}
                  volume={0}
                  onMetadata={(dur, title) =>
                    onSourceMetadata(activeSource.role, dur, 1920, 1080, title)
                  }
                  className="w-full h-full"
                />
                <div
                  onClick={onTogglePlay}
                  title={isPlaying ? 'Pause' : 'Play'}
                  className="absolute inset-0 cursor-pointer"
                />
              </div>
            ) : (
              <SmartVideo
                key={activeSource.id}
                ref={videoRef}
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
                onClick={onTogglePlay}
                onLoadedMetadataInfo={(dur, w, h) => {
                  setVideoError(null);
                  onSourceMetadata(activeSource.role, dur, w, h);
                }}
                onVideoError={(msg) => setVideoError(msg)}
                className="max-w-full max-h-full w-full h-full object-contain cursor-pointer"
              />
            )}
            {/* Top-right clean timecode readout */}
            <div className="absolute top-3 right-3 px-2.5 py-1 rounded-md bg-black/70 border border-white/10 font-mono text-xs tabular-nums text-slate-100 pointer-events-none">
              {formatTimecode(currentTime, true)} / {formatTimecode(duration, true)}
            </div>
            {videoError && (
              <div className="absolute bottom-3 left-3 right-3 px-3 py-2 rounded-lg bg-red-950/90 border border-red-500/40 text-xs text-red-200">
                {videoError}
              </div>
            )}
          </>
        ) : (
          <div className="p-8 text-center max-w-md">
            <h2 className="font-display text-xl font-semibold text-white text-balance">
              Upload Video or Paste YouTube / Kick Link
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Upload your Gameplay and Facecam recordings from your computer, or paste a Kick livestream/VOD/clip or YouTube link to start clipping.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onOpenImport}
                className="px-5 py-2.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white inline-flex items-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Video or Paste Link</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Seek Bar with In/Out Highlight */}
      <div className="px-4 pt-3 pb-2 border-t border-white/[0.07] bg-[#0B0E16]">
        <div className="relative h-6 flex items-center">
          <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/10 overflow-hidden pointer-events-none">
            <div
              className="absolute top-0 bottom-0 bg-violet-500/45"
              style={{
                left: `${inPct}%`,
                width: `${Math.max(0, outPct - inPct)}%`,
              }}
            />
            <div
              className="absolute top-0 bottom-0 left-0 bg-sky-400"
              style={{
                width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
              }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.01}
            value={Math.min(currentTime, duration || 0)}
            disabled={!hasMedia}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            aria-label="Seek video timeline"
            className="relative z-10 w-full studio-slider blue opacity-90"
          />
        </div>

        {/* Transport & Frame Stepping Row */}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={!hasMedia}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              className="w-9 h-8 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-white/[0.06] disabled:text-slate-500 text-white flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => onSeek(Math.max(0, currentTime - 5))}
              disabled={!hasMedia}
              title="Back 5 seconds"
              className="px-2 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-40 text-slate-200 text-xs font-mono inline-flex items-center gap-1 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <RotateCcw className="w-3 h-3" />
              <span>5s</span>
            </button>

            <button
              type="button"
              onClick={() => onStepFrame(-1)}
              disabled={!hasMedia}
              title="Previous Frame (Left Arrow)"
              className="px-2 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-40 text-slate-200 text-xs font-mono inline-flex items-center gap-0.5 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>1f</span>
            </button>

            <button
              type="button"
              onClick={() => onStepFrame(1)}
              disabled={!hasMedia}
              title="Next Frame (Right Arrow)"
              className="px-2 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-40 text-slate-200 text-xs font-mono inline-flex items-center gap-0.5 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <span>1f</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => onSeek(Math.min(duration, currentTime + 5))}
              disabled={!hasMedia}
              title="Forward 5 seconds"
              className="px-2 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-40 text-slate-200 text-xs font-mono inline-flex items-center gap-1 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <span>5s</span>
              <RotateCw className="w-3 h-3" />
            </button>
          </div>

          {/* Quick Clip Length Selector (15s / 30s / 45s / 60s / Custom sec) */}
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-slate-400 mr-1 hidden sm:inline">Clip Length:</span>
            {[15, 30, 45, 60].map((sec) => (
              <button
                key={sec}
                type="button"
                disabled={!hasMedia}
                onClick={() => onApplyDuration(sec)}
                title={`Set clip length to ${sec} seconds from Start point`}
                className="px-2 py-1 rounded bg-white/[0.05] hover:bg-sky-500/20 hover:text-sky-200 disabled:opacity-35 text-[11px] font-mono text-slate-300 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                {sec}s
              </button>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const val = parseFloat(customSec);
                if (Number.isFinite(val) && val >= 1) {
                  onApplyDuration(val);
                }
              }}
              className="flex items-center gap-1 ml-0.5"
            >
              <input
                type="number"
                min={1}
                max={600}
                value={customSec}
                disabled={!hasMedia}
                onChange={(e) => setCustomSec(e.target.value)}
                aria-label="Custom clip seconds"
                className="w-12 px-1.5 py-1 rounded bg-[#07080D] border border-white/10 text-[11px] font-mono text-white text-center disabled:opacity-40"
              />
              <button
                type="submit"
                disabled={!hasMedia}
                className="px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-35 text-[11px] font-medium text-slate-200 cursor-pointer disabled:cursor-not-allowed"
              >
                Set
              </button>
            </form>
          </div>
        </div>

        {/* Editing Action Bar */}
        <div className="mt-2.5 pt-2.5 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onSetInPoint}
              disabled={!hasMedia}
              title="Set Start Point (I)"
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-sky-500/20 hover:text-sky-200 disabled:opacity-40 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
            >
              Set Start <span className="text-slate-400 font-mono ml-1">[I]</span>
            </button>

            <button
              type="button"
              onClick={onSetOutPoint}
              disabled={!hasMedia}
              title="Set End Point (O)"
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-sky-500/20 hover:text-sky-200 disabled:opacity-40 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
            >
              Set End <span className="text-slate-400 font-mono ml-1">[O]</span>
            </button>

            <button
              type="button"
              onClick={onCutClip}
              disabled={!hasMedia || outPoint <= inPoint + 0.1}
              title="Cut selected range into a Short Clip (C)"
              className="px-3.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-white/[0.06] disabled:text-slate-500 text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>Cut Clip</span>
            </button>

            <button
              type="button"
              onClick={onSplitSegment}
              disabled={!hasMedia}
              title="Split segment at playhead (S)"
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
            >
              <SplitSquareHorizontal className="w-3.5 h-3.5 text-sky-400" />
              <span>Split</span>
            </button>

            <button
              type="button"
              onClick={onDeleteSegment}
              disabled={!hasMedia || !selectedSegmentId || !canDeleteSegment}
              title="Delete selected segment (Delete)"
              className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-red-500/20 hover:text-red-200 disabled:opacity-35 text-xs font-medium text-slate-300 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete Segment</span>
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              className="p-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.12] disabled:opacity-30 text-slate-200 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              className="p-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.12] disabled:opacity-30 text-slate-200 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
