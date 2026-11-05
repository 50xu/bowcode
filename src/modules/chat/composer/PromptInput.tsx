import * as React from 'react';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Button, Tooltip } from '@/shared/ui';

/* ─── Context ────────────────────────────────────────────────────── */

type PromptInputStatus = 'ready' | 'submitted' | 'streaming' | 'error';

type PromptInputContextValue = {
  status: PromptInputStatus;
};

const PromptInputContext = React.createContext<PromptInputContextValue | null>(null);

/** Read by PromptInputSubmit, which is only ever rendered inside PromptInput. */
const usePromptInput = () => {
  const context = React.useContext(PromptInputContext);
  if (!context) {
    throw new Error('PromptInput components must be used within PromptInput');
  }
  return context;
};

/* ─── PromptInput (root form) ────────────────────────────────────── */

export type PromptInputProps = {
  status?: PromptInputStatus;
} & React.FormHTMLAttributes<HTMLFormElement>;

/** Composer form shell, used by ChatComposer. */
export const PromptInput = React.forwardRef<HTMLFormElement, PromptInputProps>(
  ({ className, status = 'ready', children, ...props }, ref) => {
    const contextValue = React.useMemo(() => ({ status }), [status]);

    return (
      <PromptInputContext.Provider value={contextValue}>
        <form
          ref={ref}
          data-slot="prompt-input"
          className={cn(
            'relative min-w-0 overflow-hidden rounded-[20px] hairline bg-card transition-colors focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/15',
            className
          )}
          {...props}
        >
          {children}
        </form>
      </PromptInputContext.Provider>
    );
  }
);
PromptInput.displayName = 'PromptInput';

/* ─── PromptInputHeader ──────────────────────────────────────────── */

/** Attachment/queue row above the composer textarea, used by ChatComposer. */
export const PromptInputHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-header"
    className={cn('px-3 pt-3', className)}
    {...props}
  />
));
PromptInputHeader.displayName = 'PromptInputHeader';

/* ─── PromptInputBody ────────────────────────────────────────────── */

/** Wrapper around the composer textarea, used by ChatComposer. */
export const PromptInputBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-body"
    className={cn('relative', className)}
    {...props}
  />
));
PromptInputBody.displayName = 'PromptInputBody';

/* ─── PromptInputTextarea ────────────────────────────────────────── */

/** Auto-growing message textarea, used by ChatComposer. */
export const PromptInputTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    // One line when empty (the HTML default is two); it auto-grows as you type.
    rows={1}
    data-slot="prompt-input-textarea"
    className={cn(
      'chat-input-placeholder block max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-4 py-2 text-base leading-6 text-foreground placeholder-muted-foreground/50 focus:outline-hidden sm:max-h-[300px] sm:text-sm',
      className
    )}
    {...props}
  />
));
PromptInputTextarea.displayName = 'PromptInputTextarea';

/* ─── PromptInputFooter ──────────────────────────────────────────── */

/** Row below the composer textarea, used by ChatComposer. */
export const PromptInputFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-footer"
    className={cn('flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5 sm:px-3', className)}
    {...props}
  />
));
PromptInputFooter.displayName = 'PromptInputFooter';

/* ─── PromptInputTools ───────────────────────────────────────────── */

/** Left-hand tool cluster in the composer footer, used by ChatComposer. */
export const PromptInputTools = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-tools"
    className={cn('flex items-center gap-1', className)}
    {...props}
  />
));
PromptInputTools.displayName = 'PromptInputTools';

/* ─── PromptInputButton ──────────────────────────────────────────── */

export type PromptInputButtonTooltip = {
  content: React.ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
};

export type PromptInputButtonProps = {
  tooltip?: PromptInputButtonTooltip;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Icon button in the composer footer, used by ChatComposer and VoiceInputButton. */
export const PromptInputButton = React.forwardRef<HTMLButtonElement, PromptInputButtonProps>(
  ({ className, tooltip, children, ...props }, ref) => {
    const button = (
      <Button
        ref={ref}
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-9 w-9 shrink-0 rounded-full [&_svg]:size-4', className)}
        {...props}
      >
        {children}
      </Button>
    );

    if (tooltip) {
      return (
        <Tooltip
          content={
            tooltip.shortcut ? (
              <span className="flex items-center gap-1.5">
                {tooltip.content}
                <kbd className="rounded bg-white/20 px-1 text-[10px]">{tooltip.shortcut}</kbd>
              </span>
            ) : (
              tooltip.content
            )
          }
          position={tooltip.side ?? 'top'}
        >
          {button}
        </Tooltip>
      );
    }

    return button;
  }
);
PromptInputButton.displayName = 'PromptInputButton';

/* ─── PromptInputSubmit ──────────────────────────────────────────── */

export type PromptInputSubmitProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Send/stop button of the composer, used by ChatComposer. */
export const PromptInputSubmit = React.forwardRef<HTMLButtonElement, PromptInputSubmitProps>(
  ({ className, children, ...props }, ref) => {
    // The status comes from the PromptInput root, which is the only place it is set.
    const { status } = usePromptInput();
    const isActive = status === 'submitted' || status === 'streaming';

    return (
      <Button
        ref={ref}
        type={isActive ? 'button' : 'submit'}
        variant="default"
        size="icon"
        className={cn('h-9 w-9 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted-foreground disabled:text-primary-foreground disabled:opacity-100', className)}
        {...props}
      >
        {children ?? (isActive ? (
          <SquareIcon className="h-3.5 w-3.5 fill-current" />
        ) : (
          <ArrowUpIcon className="h-5 w-5" strokeWidth={2.5} />
        ))}
      </Button>
    );
  }
);
PromptInputSubmit.displayName = 'PromptInputSubmit';

