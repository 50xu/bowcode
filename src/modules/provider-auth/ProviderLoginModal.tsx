import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { TerminalView } from '@/modules/terminal';
import type { LLMProvider } from '@/shared/types';

/**
 * For empty shell instances where no project is provided,
 * we use a default project object to ensure the shell can still function.
 * This prevents errors related to missing project data.
 *
 * `projectId` is set to a well-known sentinel ('default') because the empty
 * shell doesn't correspond to any real project row in the database; any API
 * call that routes through this placeholder must tolerate a missing match.
 */
const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: '',
  path: '',
};

type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  provider?: LLMProvider;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
  isAuthenticated?: boolean;
};

const getProviderCommand = ({
  provider,
  customCommand,
  isAuthenticated: _isAuthenticated,
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated: boolean;
}) => {
  if (customCommand) {
    return customCommand;
  }

  if (provider === 'claude') {
    return 'claude --dangerously-skip-permissions /login';
  }

  if (provider === 'codex') {
    return 'codex login';
  }

  if (provider === 'opencode') {
    return 'opencode auth login';
  }

  return 'claude --dangerously-skip-permissions /login';
};

const getProviderTitle = (provider: LLMProvider) => {
  if (provider === 'claude') return 'Claude CLI Login';
  if (provider === 'codex') return 'Codex CLI Login';
  if (provider === 'opencode') return 'OpenCode CLI Login';
  return 'Claude CLI Login';
};

/** Used by the onboarding and settings modules to run a provider's CLI login command in an embedded shell. */
export default function ProviderLoginModal({
  isOpen,
  onClose,
  provider = 'claude',
  customCommand,
  isAuthenticated = false,
}: ProviderLoginModalProps) {
  const { t } = useTranslation();
  if (!isOpen) {
    return null;
  }

  const command = getProviderCommand({ provider, customCommand, isAuthenticated });
  const title = getProviderTitle(provider);

  return (
    <div
      data-escape-layer
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 max-md:items-stretch max-md:justify-stretch"
    >
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={t('common:misc.closeLoginModal')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <p className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300">Run in terminal: <code>{command}</code></p>
        <div className="min-h-0 flex-1 overflow-hidden">
          <TerminalView projectPath={DEFAULT_PROJECT_FOR_EMPTY_SHELL.path} />
        </div>
      </div>
    </div>
  );
}
