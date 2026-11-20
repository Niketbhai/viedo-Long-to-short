import React from 'react';
import { Download } from 'lucide-react';

export type ActiveView = 'studio' | 'import' | 'clips' | 'shortcuts';

interface HeaderProps {
  activeView: ActiveView;
  onSelectView: (view: ActiveView) => void;
  clipCount: number;
  hasMedia: boolean;
  onOpenExport: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeView,
  onSelectView,
  clipCount,
  hasMedia,
  onOpenExport,
}) => {
  return (
    <header className="h-14 border-b border-white/[0.08] bg-[#0A0C12] px-5 flex items-center justify-between gap-8 shrink-0">
      {/* Zone 1: Single-element brand wordmark */}
      <button
        type="button"
        onClick={() => onSelectView('studio')}
        className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded"
      >
        ClipForge
      </button>

      {/* Zone 2: Concise single-line navigation links */}
      <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
        <button
          type="button"
          onClick={() => onSelectView('studio')}
          className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
            activeView === 'studio'
              ? 'text-white border-violet-500'
              : 'text-slate-400 border-transparent hover:text-slate-200'
          }`}
        >
          Editor Studio
        </button>
        <button
          type="button"
          onClick={() => onSelectView('import')}
          className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
            activeView === 'import'
              ? 'text-white border-violet-500'
              : 'text-slate-400 border-transparent hover:text-slate-200'
          }`}
        >
          Import Media
        </button>
        <button
          type="button"
          onClick={() => onSelectView('clips')}
          className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 tabular-nums ${
            activeView === 'clips'
              ? 'text-white border-violet-500'
              : 'text-slate-400 border-transparent hover:text-slate-200'
          }`}
        >
          Shorts Queue ({clipCount})
        </button>
        <button
          type="button"
          onClick={() => onSelectView('shortcuts')}
          className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
            activeView === 'shortcuts'
              ? 'text-white border-violet-500'
              : 'text-slate-400 border-transparent hover:text-slate-200'
          }`}
        >
          Shortcuts
        </button>
      </nav>

      {/* Zone 3: Single primary action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onOpenExport}
          disabled={!hasMedia}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:bg-white/[0.06] disabled:text-slate-500 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export Short</span>
        </button>
      </div>
    </header>
  );
};
