import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/shared/utils';

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** Used by settings, provider-agents and mcp forms for consistently styled native choices. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <span className={cn('relative inline-flex w-full items-center', className)}>
      <select
        ref={ref}
        className="flex h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-9 py-1 text-sm shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 size-4 text-muted-foreground" />
    </span>
  ),
);

Select.displayName = 'Select';
