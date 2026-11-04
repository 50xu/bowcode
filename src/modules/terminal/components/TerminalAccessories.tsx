import { Keyboard, ChevronDown } from 'lucide-react';

import type { Modifiers } from '@/modules/terminal/utils/terminalInput';

type Props = {
  modifiers: Modifiers;
  onModifier: (key: 'ctrl' | 'alt') => void;
  onKey: (key: string) => void;
  onCopy: () => void;
  onPaste: () => void;
  onHide: () => void;
  onFontSize: (delta: number) => void;
};

const keys = ['Esc', 'Tab', 'Ctrl', 'Alt', '←', '↑', '↓', '→', 'Home', 'End', 'PgUp', 'PgDn', '|', '/', '-', '~', '`', '$', '*'];

/** Rendered by TerminalSession on touch and narrow screens to preserve terminal keyboard focus. */
export function TerminalAccessories({ modifiers, onModifier, onKey, onCopy, onPaste, onHide, onFontSize }: Props) {
  const chip = 'h-9 shrink-0 rounded-md border border-[#262B40] bg-[#1C2033] px-2.5 text-xs text-[#E6E9F0] active:bg-[#262B40]';
  return (
    <div className="-mx-3 -mb-3 shrink-0 border-t border-[#262B40] bg-[#0F1222] pb-[env(safe-area-inset-bottom)] [@media(min-width:768px)_and_(hover:hover)_and_(pointer:fine)]:hidden">
      <div className="flex gap-1.5 overflow-x-auto px-3 py-2 [scrollbar-width:none]" aria-label="Terminal keys">
        {keys.map((key) => (
          <button key={key} type="button" aria-label={key} aria-pressed={key === 'Ctrl' ? modifiers.ctrl !== 'off' : key === 'Alt' ? modifiers.alt !== 'off' : undefined}
            title={key === 'Ctrl' ? `Ctrl: ${modifiers.ctrl}` : key === 'Alt' ? `Alt: ${modifiers.alt}` : undefined}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => key === 'Ctrl' || key === 'Alt' ? onModifier(key.toLowerCase() as 'ctrl' | 'alt') : onKey(key)}
            className={`${chip} ${(key === 'Ctrl' && modifiers.ctrl !== 'off') || (key === 'Alt' && modifiers.alt !== 'off') ? 'border-[#4FD1C5] text-[#4FD1C5]' : ''}`}>{key}</button>
        ))}
        <button type="button" className={chip} onPointerDown={(event) => event.preventDefault()} onClick={onCopy}>Copy</button>
        <button type="button" className={chip} onPointerDown={(event) => event.preventDefault()} onClick={onPaste}>Paste</button>
        <button type="button" className={chip} onPointerDown={(event) => event.preventDefault()} onClick={() => onFontSize(-1)}>A-</button>
        <button type="button" className={chip} onPointerDown={(event) => event.preventDefault()} onClick={() => onFontSize(1)}>A+</button>
        <button type="button" aria-label="Hide keyboard" className={chip} onPointerDown={(event) => event.preventDefault()} onClick={onHide}><span className="flex items-center"><Keyboard size={16} /><ChevronDown size={12} /></span></button>
      </div>
    </div>
  );
}
