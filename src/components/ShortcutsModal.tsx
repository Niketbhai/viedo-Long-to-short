import React from 'react';
import { Keyboard, X } from 'lucide-react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { key: 'Space', action: 'Play / Pause synchronized preview' },
  { key: 'I', action: 'Set Start Point (In) at playhead' },
  { key: 'O', action: 'Set End Point (Out) at playhead' },
  { key: 'C', action: 'Cut Clip from selected In / Out range' },
  { key: 'S', action: 'Split timeline segment at playhead' },
  { key: 'Left / Right', action: 'Step backward / forward 1 frame' },
  { key: 'Shift + Left / Right', action: 'Jump backward / forward 5 seconds' },
  { key: 'Ctrl/Cmd + Z', action: 'Undo last timeline or layout action' },
  { key: 'Ctrl/Cmd + Shift + Z', action: 'Redo action' },
  { key: 'Delete / Backspace', action: 'Delete selected timeline segment' },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0B0E16] shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Keyboard className="w-4 h-4 text-violet-400" />
            <h2 id="shortcuts-title" className="font-display text-base font-semibold text-white">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="divide-y divide-white/[0.06] px-6 py-2">
          {SHORTCUTS.map((item) => (
            <div key={item.key} className="py-3 flex items-center justify-between gap-4 text-xs">
              <span className="text-slate-300">{item.action}</span>
              <kbd className="px-2.5 py-1 rounded bg-[#141926] border border-white/10 font-mono text-[11px] text-sky-300 whitespace-nowrap shrink-0">
                {item.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-white/[0.08] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-white/10 hover:bg-white/15 text-white transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
