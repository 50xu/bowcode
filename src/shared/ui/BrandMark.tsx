import { cn } from '@/shared/utils';

type BrandMarkProps = {
  /** Tile edge in pixels; the glyph scales with it. */
  size?: number;
  className?: string;
};

/**
 * The Bowcode app icon — a bow with the arrow leaving it, i.e. work sent off to
 * a machine far away. Same drawing as public/logo.svg and the PWA icons.
 * Rendered by the sidebar module's header and the settings module's navigation
 * and About page, so the brand looks identical wherever it shows up.
 */
export function BrandMark({ size = 28, className }: BrandMarkProps) {
  return (
    <span
      className={cn('inline-flex flex-shrink-0 items-center justify-center bg-[#2563eb] text-white shadow-sm', className)}
      style={{ width: size, height: size, borderRadius: size * 0.25 }}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        style={{ width: size * 0.72, height: size * 0.72 }}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 9.5C9 3 21 15 14.5 20.5" />
        <path d="M3.5 9.5L14.5 20.5" strokeWidth={1.3} opacity={0.7} />
        <path d="M6 18L20 4" />
        <path d="M15 4h5v5" />
      </svg>
    </span>
  );
}
