import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

/** Offsets people actually mean when they say "later". */
const QUICK_OFFSETS_MINUTES = [15, 60, 8 * 60, 24 * 60];

/**
 * Turns the picker's `datetime-local` value into an absolute instant.
 *
 * That input carries no zone, and `new Date(value)` reads it in the browser's
 * — which is what the user meant, since they picked it off their own clock.
 * Converting here means the server stores one unambiguous instant, so the
 * schedule does not move if they are on another device when it fires.
 */
function readLocalDateTime(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toLocalInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * The "send later" choices — quick offsets plus a custom date/time. Rendered
 * inside the composer's + menu (ComposerActionsMenu) as its schedule view.
 */
export function ScheduleMessageOptions({ onSchedule }: { onSchedule: (scheduledFor: Date) => void }) {
  const { t } = useTranslation('chat');
  // Seeded an hour out, because a picker that opens on "now" is never what
  // scheduling means.
  const [customValue, setCustomValue] = useState(() => toLocalInputValue(new Date(Date.now() + 3_600_000)));

  return (
    <>
      <ComposerMenuHeading>{t('schedule.heading')}</ComposerMenuHeading>
      {QUICK_OFFSETS_MINUTES.map((minutes) => (
        <ComposerMenuItem
          key={minutes}
          role="menuitem"
          label={t(`schedule.in.${minutes}`)}
          description={new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
          isSelected={false}
          onSelect={() => onSchedule(new Date(Date.now() + minutes * 60_000))}
        />
      ))}

      <ComposerMenuSeparator />
      <div className="px-2.5 pb-1.5">
        <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="schedule-at">
          {t('schedule.customLabel')}
        </label>
        <input
          id="schedule-at"
          type="datetime-local"
          value={customValue}
          onChange={(event) => setCustomValue(event.target.value)}
          className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground"
        />
        <button
          type="button"
          onClick={() => {
            const parsed = readLocalDateTime(customValue);
            if (parsed) onSchedule(parsed);
          }}
          className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t('schedule.confirm')}
        </button>
      </div>
    </>
  );
}
