import { memo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Shrink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  /** Sends `/compact` to the session; omitted for providers without it. */
  onCompact?: () => void;
  /** A turn is running — compacting now would only queue behind it. */
  compactDisabled?: boolean;
};

const POPOVER_WIDTH = 260;
const VIEWPORT_MARGIN = 8;

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  // Thresholds sit where rounding would carry into the next unit, so 9,960 reads "10K", not "10.0K".
  if (value >= 999_500) {
    return `${(value / 1_000_000).toFixed(value >= 9_950_000 ? 0 : 1)}M`;
  }

  if (value >= 9_950) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toneFor = (percent: number | null) => {
  if (percent === null) return 'text-primary';
  if (percent >= 85) return 'text-red-500';
  if (percent >= 60) return 'text-amber-500';
  return 'text-emerald-500';
};

function UsageRing({ percent, className }: { percent: number | null; className?: string }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const filled = percent === null ? 0 : Math.min(percent, 100) / 100;
  return (
    <svg viewBox="0 0 18 18" className={cn('h-4 w-4 -rotate-90', className)} aria-hidden>
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${circumference * filled} ${circumference}`}
      />
    </svg>
  );
}

/**
 * Rendered by chat's ChatComposer: a context-window meter whose popover
 * shows how full the context is and offers to compact it.
 */
function TokenUsageSummary({ usage, onCompact, compactDisabled = false }: TokenUsageSummaryProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, POPOVER_WIDTH);

  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  const totalTokens = readUsageNumber(usage?.total);
  const cacheReadTokens = readUsageNumber(usage?.cacheReadTokens);
  const cacheWriteTokens = readUsageNumber(usage?.cacheCreationTokens);
  // A window smaller than what is in use is a stale default, not a reading.
  const percent = totalTokens > usedTokens && usedTokens > 0
    ? Math.round((usedTokens / totalTokens) * 100)
    : null;
  const tone = toneFor(percent);

  const details = [
    { label: t('tokenUsage.cacheRead', { defaultValue: 'Cache read' }), value: cacheReadTokens },
    { label: t('tokenUsage.cacheWrite', { defaultValue: 'Cache write' }), value: cacheWriteTokens },
    { label: t('tokenUsage.output', { defaultValue: 'Output' }), value: outputTokens },
  ].filter((row) => row.value > 0);

  // Left-aligned to the trigger (it sits at the composer's left edge), clamped
  // into the viewport so it never runs off a phone screen.
  const [left, setLeft] = useState(VIEWPORT_MARGIN);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) {
            setLeft(Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)));
          }
          setIsOpen((current) => !current);
        }}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className={cn('inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', isOpen && 'bg-accent text-foreground')}
        title={t('misc.tokensUsed', { count: usedTokens })}
        aria-label={t('misc.showTokenUsage')}
      >
        <UsageRing percent={percent} className={tone} />
        <span className="font-medium tabular-nums">
          {percent !== null ? `${percent}%` : formatTokenCount(usedTokens)}
        </span>
      </button>

      {isOpen && anchor && createPortal(
        <div
          ref={menuRef}
          role="dialog"
          aria-label={t('tokenUsage.title', { defaultValue: 'Context' })}
          className="fixed z-[100] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
          style={{ left, bottom: anchor.bottom, width: POPOVER_WIDTH, maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)` }}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t('tokenUsage.title', { defaultValue: 'Context' })}
            </span>
            {percent !== null && (
              <span className={cn('text-sm font-semibold tabular-nums', tone)}>{percent}%</span>
            )}
          </div>

          {percent !== null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full bg-current transition-[width]', tone)}
                style={{ width: `${Math.min(percent, 100)}%` }}
              />
            </div>
          )}

          <p className="mt-2 text-sm tabular-nums text-foreground">
            {percent !== null
              ? t('tokenUsage.ofWindow', {
                defaultValue: '{{used}} of {{total}} tokens',
                used: formatTokenCount(usedTokens),
                total: formatTokenCount(totalTokens),
              })
              : t('tokenUsage.inContext', {
                defaultValue: '{{used}} tokens in context',
                used: formatTokenCount(usedTokens),
              })}
          </p>

          {details.length > 0 && (
            <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              {details.map((row) => `${row.label} ${formatTokenCount(row.value)}`).join(' · ')}
            </p>
          )}

          {onCompact && (
            <>
              <div className="my-2.5 h-px bg-border" aria-hidden />
              <button
                type="button"
                disabled={compactDisabled || usedTokens === 0}
                onClick={() => {
                  onCompact();
                  setIsOpen(false);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Shrink className="h-3.5 w-3.5" aria-hidden />
                {t('tokenUsage.compact', { defaultValue: 'Compact conversation' })}
              </button>
              <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
                {compactDisabled
                  ? t('tokenUsage.compactBusy', { defaultValue: 'Available when the current turn finishes.' })
                  : t('tokenUsage.compactHint', { defaultValue: 'Summarizes earlier turns to free up context.' })}
              </p>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
