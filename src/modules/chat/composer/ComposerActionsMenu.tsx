import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Clock, Paperclip, Plus, SquareSlash } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import { ScheduleMessageOptions } from '@/modules/chat/composer/ScheduleMessageOptions';

type ComposerActionsMenuProps = {
  onAttachFiles: () => void;
  onShowCommands: () => void;
  commandsCount: number;
  /** Scheduling needs something to send; the row is disabled while the box is empty. */
  canSchedule: boolean;
  onSchedule: (scheduledFor: Date) => void;
};

const MENU_WIDTH = 256;

/**
 * The composer's "+" button: the occasional actions (attach, slash commands,
 * send later) behind one control, so the footer keeps a single uncluttered
 * row on a phone. Rendered by chat's ChatComposer at the footer's left edge.
 */
export function ComposerActionsMenu({
  onAttachFiles,
  onShowCommands,
  commandsCount,
  canSchedule,
  onSchedule,
}: ComposerActionsMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<'actions' | 'schedule'>('actions');
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, MENU_WIDTH, 'left');
  const ariaLabel = t('composer.actionsMenu', { defaultValue: 'More actions' });

  const run = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setView('actions');
          setIsOpen((current) => !current);
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground active:scale-95',
          isOpen && 'bg-accent text-foreground',
        )}
      >
        <Plus className={cn('h-5 w-5 transition-transform duration-200', isOpen && 'rotate-45')} />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <div style={{ width: MENU_WIDTH, maxWidth: '100%' }}>
            {view === 'actions' ? (
              <>
                <ComposerMenuItem
                  role="menuitem"
                  icon={<Paperclip className="h-4 w-4" />}
                  label={t('input.attachFiles')}
                  isSelected={false}
                  onSelect={() => run(onAttachFiles)}
                />
                <ComposerMenuItem
                  role="menuitem"
                  icon={<SquareSlash className="h-4 w-4" />}
                  label={t('composer.commands', { defaultValue: 'Commands' })}
                  isSelected={false}
                  trailing={commandsCount > 0 ? (
                    <span className="text-xs tabular-nums text-muted-foreground">{commandsCount}</span>
                  ) : null}
                  onSelect={() => run(onShowCommands)}
                />
                <ComposerMenuSeparator />
                <ComposerMenuItem
                  role="menuitem"
                  icon={<Clock className="h-4 w-4" />}
                  label={t('schedule.heading')}
                  description={canSchedule ? undefined : t('composer.scheduleNeedsText', { defaultValue: 'Type a message first' })}
                  isSelected={false}
                  className={canSchedule ? undefined : 'pointer-events-none opacity-50'}
                  onSelect={() => setView('schedule')}
                />
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setView('actions')}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-primary hover:bg-accent"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  {t('composer.back', { defaultValue: 'Back' })}
                </button>
                <ScheduleMessageOptions onSchedule={(when) => run(() => onSchedule(when))} />
              </>
            )}
          </div>
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
