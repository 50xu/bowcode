import type { ReactNode } from 'react';

import { cn } from '@/shared/utils';

type SettingsRowProps = {
  label: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /** Wide controls (text fields, selects) drop below the label on phones instead of squeezing it. */
  stacked?: boolean;
};

/** Used by the settings module's appearance, browser-use and tasks tabs to lay out one labelled setting and its control. */
export default function SettingsRow({ label, description, children, className, stacked = false }: SettingsRowProps) {
  return (
    <div
      className={cn(
        'flex justify-between gap-4 px-4 py-3.5',
        stacked ? 'flex-col items-stretch gap-2.5 sm:flex-row sm:items-center sm:gap-4' : 'items-center',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
        )}
      </div>
      <div className={cn('flex-shrink-0', stacked && 'w-full sm:w-72')}>{children}</div>
    </div>
  );
}
