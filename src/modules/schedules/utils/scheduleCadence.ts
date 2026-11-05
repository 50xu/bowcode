import type { TFunction } from 'i18next';

import type { Schedule } from '@/shared/types';

/**
 * A recurring cadence as the editor's presets describe it. Each preset maps to
 * exactly one five-field cron expression; `custom` carries any other
 * expression verbatim (the "advanced" field).
 */
export type CadencePreset =
  | { type: 'hourly'; everyHours: number; minute: number }
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'weekdays'; hour: number; minute: number }
  | { type: 'weekly'; dayOfWeek: number; hour: number; minute: number }
  | { type: 'custom'; cron: string };

const NUMBER = '(\\d{1,2})';

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The cron expression a preset stands for. Used by the schedule editor when saving and previewing. */
export function cadenceToCron(cadence: CadencePreset): string {
  switch (cadence.type) {
    case 'hourly':
      return cadence.everyHours <= 1
        ? `${cadence.minute} * * * *`
        : `${cadence.minute} */${cadence.everyHours} * * *`;
    case 'daily':
      return `${cadence.minute} ${cadence.hour} * * *`;
    case 'weekdays':
      return `${cadence.minute} ${cadence.hour} * * 1-5`;
    case 'weekly':
      return `${cadence.minute} ${cadence.hour} * * ${cadence.dayOfWeek}`;
    case 'custom':
      return cadence.cron.trim();
  }
}

/**
 * Reads a cron expression back into the preset that produces it, or `custom`
 * when no preset does. Used by the schedule editor to reopen a saved schedule
 * on the right preset, and by the list to describe it.
 */
export function cronToCadence(cron: string): CadencePreset {
  const expression = cron.trim().replace(/\s+/g, ' ');

  let match = new RegExp(`^${NUMBER} \\* \\* \\* \\*$`).exec(expression);
  if (match && inRange(Number(match[1]), 0, 59)) {
    return { type: 'hourly', everyHours: 1, minute: Number(match[1]) };
  }

  match = new RegExp(`^${NUMBER} \\*/${NUMBER} \\* \\* \\*$`).exec(expression);
  if (match && inRange(Number(match[1]), 0, 59) && inRange(Number(match[2]), 2, 23)) {
    return { type: 'hourly', everyHours: Number(match[2]), minute: Number(match[1]) };
  }

  match = new RegExp(`^${NUMBER} ${NUMBER} \\* \\* (\\*|1-5|[0-6])$`).exec(expression);
  if (match && inRange(Number(match[1]), 0, 59) && inRange(Number(match[2]), 0, 23)) {
    const minute = Number(match[1]);
    const hour = Number(match[2]);
    if (match[3] === '*') return { type: 'daily', hour, minute };
    if (match[3] === '1-5') return { type: 'weekdays', hour, minute };
    return { type: 'weekly', dayOfWeek: Number(match[3]), hour, minute };
  }

  return { type: 'custom', cron: expression };
}

/** A weekday name (0 = Sunday) in the given locale. */
function weekdayName(dayOfWeek: number, locale: string | undefined): string {
  // 2023-01-01 was a Sunday.
  const date = new Date(Date.UTC(2023, 0, 1 + dayOfWeek, 12));
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date);
}

/** A local date and time for display. */
export function formatScheduleDateTime(iso: string | null, locale?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * A short human description of when a schedule fires ("Weekdays at 09:00").
 * Used by the schedules panel's list rows.
 */
export function describeScheduleCadence(
  schedule: Pick<Schedule, 'kind' | 'cronExpression' | 'runAt' | 'timezone'>,
  t: TFunction,
  locale?: string,
): string {
  if (schedule.kind === 'once') {
    return t('cadence.onceAt', { time: formatScheduleDateTime(schedule.runAt, locale) });
  }
  const cadence = cronToCadence(schedule.cronExpression ?? '');
  switch (cadence.type) {
    case 'hourly':
      return cadence.everyHours <= 1
        ? t('cadence.everyHour', { minute: pad(cadence.minute) })
        : t('cadence.everyNHours', { count: cadence.everyHours, minute: pad(cadence.minute) });
    case 'daily':
      return t('cadence.dailyAt', { time: `${pad(cadence.hour)}:${pad(cadence.minute)}` });
    case 'weekdays':
      return t('cadence.weekdaysAt', { time: `${pad(cadence.hour)}:${pad(cadence.minute)}` });
    case 'weekly':
      return t('cadence.weeklyAt', {
        day: weekdayName(cadence.dayOfWeek, locale),
        time: `${pad(cadence.hour)}:${pad(cadence.minute)}`,
      });
    case 'custom':
      return t('cadence.custom', { cron: cadence.cron });
  }
}

/** "HH:MM" from hour and minute, for a time input's value. */
export function toTimeInputValue(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** Hour and minute from a time input's "HH:MM" value; midnight when unreadable. */
export function fromTimeInputValue(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map(Number);
  return {
    hour: inRange(hour, 0, 23) ? hour : 0,
    minute: inRange(minute, 0, 59) ? minute : 0,
  };
}

/** Weekday names in order from Sunday (0) to Saturday (6), for the weekly preset's select. */
export function listWeekdayNames(locale?: string): string[] {
  return Array.from({ length: 7 }, (_, day) => weekdayName(day, locale));
}
