import React from 'react';
import {
  ArrowLeft,
  Download,
  Film,
  Play,
  Scissors,
  Trash2,
} from 'lucide-react';
import { ShortClip } from '../types/editor';
import { LAYOUT_LABELS } from '../utils/layoutGeometry';
import { formatShortDuration, formatTimecode } from '../utils/time';

interface ShortsQueueViewProps {
  clips: ShortClip[];
  onBackToStudio: () => void;
  onPreviewInStudio: (clipId: string) => void;
  onExportClip: (clipId: string) => void;
  onDeleteClip: (clipId: string) => void;
  onRenameClip: (clipId: string, name: string) => void;
}

export const ShortsQueueView: React.FC<ShortsQueueViewProps> = ({
  clips,
  onBackToStudio,
  onPreviewInStudio,
  onExportClip,
  onDeleteClip,
  onRenameClip,
}) => {
  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-6xl w-full mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-white">
            Shorts Export Queue
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Review, rename, preview, or export each short clip individually in 9:16 vertical format.
          </p>
        </div>

        <button
          type="button"
          onClick={onBackToStudio}
          className="px-4 py-2 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] text-slate-200 inline-flex items-center gap-2 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Editor Studio</span>
        </button>
      </div>

      {clips.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-[#0C0F17] p-12 text-center">
          <Scissors className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <h2 className="font-display text-lg font-medium text-white">
            No Short Clips Cut Yet
          </h2>
          <p className="text-xs text-slate-400 mt-1.5 max-w-md mx-auto leading-relaxed">
            Return to the Editor Studio, mark your Start and End timestamps on the long video, and click Cut Clip to build your Shorts queue.
          </p>
          <button
            type="button"
            onClick={onBackToStudio}
            className="mt-5 px-5 py-2.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors cursor-pointer"
          >
            Open Editor Studio
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {clips.map((clip) => {
            const duration = clip.endTime - clip.startTime;
            return (
              <div
                key={clip.id}
                className="rounded-xl border border-white/[0.08] bg-[#0C0F17] p-4 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <input
                      type="text"
                      value={clip.name}
                      onChange={(e) => onRenameClip(clip.id, e.target.value)}
                      aria-label="Clip name"
                      className="flex-1 bg-transparent border-b border-transparent hover:border-white/15 focus:border-violet-500 text-sm font-semibold text-white focus:outline-none py-0.5"
                    />
                    <span className="font-mono text-xs tabular-nums text-sky-400 shrink-0">
                      {formatShortDuration(duration)}
                    </span>
                  </div>

                  <div className="text-xs font-mono tabular-nums text-slate-400">
                    {formatTimecode(clip.startTime)} – {formatTimecode(clip.endTime)}
                  </div>

                  <div className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Film className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                    <span className="truncate">{LAYOUT_LABELS[clip.layout.mode]}</span>
                  </div>

                  {clip.exportedUrl && (
                    <div className="pt-2">
                      <video
                        src={clip.exportedUrl}
                        controls
                        playsInline
                        className="w-full max-h-48 rounded-lg bg-black object-contain border border-white/10"
                      />
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-white/[0.07] flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onPreviewInStudio(clip.id)}
                    className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] text-slate-200 inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Preview</span>
                  </button>

                  {clip.exportedUrl || clip.exportedDownloadUrl ? (
                    (() => {
                      const safeDownloadName = `${clip.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'clipforge_short'}.${clip.exportedExt || 'mp4'}`;
                      const downloadHref = clip.exportedDownloadUrl
                        ? `${clip.exportedDownloadUrl}?name=${encodeURIComponent(safeDownloadName)}`
                        : clip.exportedUrl;
                      return (
                        <a
                          href={downloadHref}
                          download={safeDownloadName}
                          className="flex-1 px-3 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download</span>
                        </a>
                      );
                    })()
                  ) : (
                    <button
                      type="button"
                      onClick={() => onExportClip(clip.id)}
                      className="flex-1 px-3 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Export</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onDeleteClip(clip.id)}
                    title="Delete clip"
                    className="p-2 rounded-lg bg-white/[0.04] hover:bg-red-500/20 text-slate-400 hover:text-red-300 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
