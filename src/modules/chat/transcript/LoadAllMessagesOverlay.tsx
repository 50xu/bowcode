import { useTranslation } from 'react-i18next';

const loadAllOverlayAnimationStyle = `
@keyframes loadAllOverlayAutoFade {
  0%, 80% { opacity: 1; }
  100% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .load-all-overlay-auto-fade {
    animation: none !important;
  }
}
`;

type LoadAllMessagesOverlayProps = {
  showLoadAllOverlay: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  totalMessages: number;
  onLoadAllMessages: () => void;
};

/**
 * Rendered by chat's ChatMessagesPane to offer loading a long session's full
 * history when only the most recent page has been fetched.
 */
export default function LoadAllMessagesOverlay({
  showLoadAllOverlay,
  isLoadingAllMessages,
  loadAllJustFinished,
  totalMessages,
  onLoadAllMessages,
}: LoadAllMessagesOverlayProps) {
  const { t } = useTranslation('chat');

  // The overlay occupies no layout height and leaves a same-sized placeholder
  // when hidden: it appears at the top of the transcript and fades out 2.5s
  // later, and an in-flow element coming and going above the reader's position
  // shifts the whole transcript on engines without scroll anchoring (iOS).
  if (!showLoadAllOverlay && !isLoadingAllMessages && !loadAllJustFinished) {
    return <div aria-hidden className="mt-0! h-0" />;
  }

  return (
    <div
      className={`pointer-events-none sticky top-2 z-20 mt-0! flex h-0 items-start justify-center overflow-visible ${!isLoadingAllMessages ? 'load-all-overlay-auto-fade' : ''}`}
      style={!isLoadingAllMessages ? { animation: 'loadAllOverlayAutoFade 2500ms ease forwards' } : undefined}
    >
      <style>{loadAllOverlayAnimationStyle}</style>
      {loadAllJustFinished ? (
        <div className="flex items-center space-x-2 rounded-full bg-green-600 px-4 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-green-500">
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
          <span>{t('session.messages.allLoaded')}</span>
        </div>
      ) : (
        <button
          className="pointer-events-auto flex items-center space-x-2 rounded-full bg-blue-600 px-4 py-1.5 text-xs font-medium text-white shadow-lg transition-all duration-200 hover:scale-105 hover:bg-blue-700 disabled:cursor-wait disabled:opacity-75 dark:bg-blue-500 dark:hover:bg-blue-600"
          onClick={onLoadAllMessages}
          disabled={isLoadingAllMessages}
        >
          {isLoadingAllMessages && (
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          )}
          <span>
            {isLoadingAllMessages
              ? t('session.messages.loadingAll')
              : <>{t('session.messages.loadAll')} {totalMessages > 0 && `(${totalMessages})`}</>}
          </span>
        </button>
      )}
    </div>
  );
}
