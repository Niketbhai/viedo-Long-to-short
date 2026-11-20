import React, { useState } from 'react';
import {
  Check,
  Crop,
  Download,
  Film,
  FolderOpen,
  Link2,
  Pencil,
  Play,
  Square,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react';
import { ShortClip, VideoRole, VideoSource } from '../types/editor';
import { LAYOUT_LABELS } from '../utils/layoutGeometry';
import { formatShortDuration, formatTimecode } from '../utils/time';

interface MediaAndClipsSidebarProps {
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  clips: ShortClip[];
  activeClipId: string | null;
  previewingClipId: string | null;
  onOpenImport: () => void;
  onQuickUpload: (role: VideoRole, file: File) => void;
  onRemoveSource: (role: VideoRole) => void;
  onOpenFacecamCrop: () => void;
  hasFacecamCrop: boolean;
  onPreviewClip: (clipId: string) => void;
  onStopPreviewClip: () => void;
  onSelectClip: (clipId: string) => void;
  onRenameClip: (clipId: string, newName: string) => void;
  onDeleteClip: (clipId: string) => void;
  onExportClip: (clipId: string) => void;
}

export const MediaAndClipsSidebar: React.FC<MediaAndClipsSidebarProps> = ({
  gameplay,
  facecam,
  clips,
  activeClipId,
  previewingClipId,
  onOpenImport,
  onQuickUpload,
  onRemoveSource,
  onOpenFacecamCrop,
  hasFacecamCrop,
  onPreviewClip,
  onStopPreviewClip,
  onSelectClip,
  onRenameClip,
  onDeleteClip,
  onExportClip,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const startRename = (clip: ShortClip) => {
    setEditingId(clip.id);
    setDraftName(clip.name);
  };

  const commitRename = (clipId: string) => {
    const trimmed = draftName.trim();
    if (trimmed) {
      onRenameClip(clipId, trimmed);
    }
    setEditingId(null);
  };

  const renderSourceRow = (
    role: VideoRole,
    label: string,
    source: VideoSource | null,
    accentClass: string
  ) => (
    <div className="py-2.5 flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {role === 'gameplay' ? (
            <Film className={`w-3.5 h-3.5 shrink-0 ${accentClass}`} />
          ) : (
            <User className={`w-3.5 h-3.5 shrink-0 ${accentClass}`} />
          )}
          <span className="text-xs font-semibold text-slate-200">{label}</span>
        </div>
        {source ? (
          <div className="mt-1 pl-5.5">
            <p className="text-[11px] text-slate-300 truncate">{source.name}</p>
            <p className="text-[11px] font-mono tabular-nums text-slate-500">
              {formatTimecode(source.duration)} · {source.width}×{source.height}
              {role === 'facecam' && hasFacecamCrop ? ' · Cropped' : ''}
            </p>
          </div>
        ) : (
          <p className="mt-0.5 pl-5.5 text-[11px] text-slate-500">
            {role === 'facecam' && gameplay ? 'Crop from gameplay or upload' : 'No video loaded'}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {role === 'facecam' && (
          <button
            type="button"
            onClick={onOpenFacecamCrop}
            title="Crop Facecam region by hand"
            className={`px-2 py-1.5 rounded-md text-[11px] font-medium inline-flex items-center gap-1 transition-colors cursor-pointer ${
              hasFacecamCrop
                ? 'bg-violet-600 text-white'
                : 'bg-violet-500/20 hover:bg-violet-500/30 text-violet-200'
            }`}
          >
            <Crop className="w-3 h-3" />
            <span>Crop</span>
          </button>
        )}
        <label
          title={`Upload ${label} file`}
          className="p-1.5 rounded-md bg-white/[0.05] hover:bg-white/[0.1] text-slate-300 hover:text-white transition-colors cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onQuickUpload(role, f);
              e.target.value = '';
            }}
          />
        </label>
        {source && (
          <button
            type="button"
            onClick={() => onRemoveSource(role)}
            title={`Remove ${label}`}
            className="p-1.5 rounded-md bg-white/[0.04] hover:bg-red-500/20 text-slate-400 hover:text-red-300 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <aside className="rounded-xl border border-white/[0.08] bg-[#0C0F17] flex flex-col min-h-0 overflow-hidden">
      {/* Sources Header */}
      <div className="px-4 py-3 border-b border-white/[0.07] flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-200 tracking-wide">
          Media Sources
        </span>
        <button
          type="button"
          onClick={onOpenImport}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/[0.06] hover:bg-white/[0.11] text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Link2 className="w-3 h-3 text-sky-400" />
          <span>Import / URL</span>
        </button>
      </div>

      <div className="px-4 divide-y divide-white/[0.06] border-b border-white/[0.08]">
        {renderSourceRow('gameplay', 'Gameplay Video', gameplay, 'text-sky-400')}
        {renderSourceRow('facecam', 'Facecam Video', facecam, 'text-violet-400')}
      </div>

      {/* Shorts Clips Bin */}
      <div className="px-4 py-3 border-b border-white/[0.07] flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-200">
          Shorts Clips
        </span>
        <span className="text-xs font-mono tabular-nums text-slate-400">
          {clips.length} {clips.length === 1 ? 'clip' : 'clips'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[180px]">
        {clips.length === 0 ? (
          <div className="h-full min-h-[160px] flex flex-col items-center justify-center text-center px-4 py-6">
            <FolderOpen className="w-7 h-7 text-slate-600 mb-2" />
            <p className="text-xs font-medium text-slate-300">No short clips yet</p>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              Mark Start and End points on the timeline, then click Cut Clip to save a vertical Short.
            </p>
          </div>
        ) : (
          clips.map((clip) => {
            const isSelected = activeClipId === clip.id;
            const isPreviewing = previewingClipId === clip.id;
            const duration = clip.endTime - clip.startTime;

            return (
              <div
                key={clip.id}
                onClick={() => onSelectClip(clip.id)}
                className={`rounded-lg border p-3 transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-violet-500/60 bg-violet-500/[0.08]'
                    : 'border-white/[0.07] bg-[#111521] hover:border-white/15'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  {editingId === clip.id ? (
                    <div
                      className="flex items-center gap-1 flex-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="text"
                        value={draftName}
                        autoFocus
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(clip.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => commitRename(clip.id)}
                        className="w-full px-2 py-1 rounded bg-[#07080D] border border-violet-500 text-xs text-white focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => commitRename(clip.id)}
                        className="p-1 text-emerald-400 hover:text-emerald-300"
                        aria-label="Save clip name"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="text-xs font-semibold text-white truncate">
                        {clip.name}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(clip);
                        }}
                        title="Rename clip"
                        className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>

                <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400">
                  <span>
                    {formatTimecode(clip.startTime)} – {formatTimecode(clip.endTime)}
                  </span>
                  <span className="text-sky-400 font-medium">
                    {formatShortDuration(duration)}
                  </span>
                </div>

                <p className="mt-1 text-[11px] text-slate-500 truncate">
                  {LAYOUT_LABELS[clip.layout.mode]}
                </p>

                <div
                  className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {isPreviewing ? (
                    <button
                      type="button"
                      onClick={onStopPreviewClip}
                      className="flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>Stop</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPreviewClip(clip.id)}
                      className="flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-white/[0.06] hover:bg-white/[0.12] text-slate-200 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>Preview</span>
                    </button>
                  )}

                  {clip.exportedDownloadUrl || clip.exportedUrl ? (
                    (() => {
                      const safeName = `${clip.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'clipforge_short'}.${clip.exportedExt || 'mp4'}`;
                      const dlHref = clip.exportedDownloadUrl
                        ? `${clip.exportedDownloadUrl}?name=${encodeURIComponent(safeName)}`
                        : clip.exportedUrl;
                      return (
                        <a
                          href={dlHref}
                          download={safeName}
                          title="Download cut Short"
                          className="px-2.5 py-1.5 rounded-md text-[11px] font-semibold bg-emerald-600/30 hover:bg-emerald-600/45 text-emerald-200 inline-flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <Download className="w-3 h-3" />
                          <span>Save</span>
                        </a>
                      );
                    })()
                  ) : (
                    <button
                      type="button"
                      onClick={() => onExportClip(clip.id)}
                      title="Direct cut & download this short clip"
                      className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-violet-600/25 hover:bg-violet-600/40 text-violet-200 inline-flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      <span>Export</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onDeleteClip(clip.id)}
                    title="Delete clip"
                    className="p-1.5 rounded-md bg-white/[0.04] hover:bg-red-500/20 text-slate-400 hover:text-red-300 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
