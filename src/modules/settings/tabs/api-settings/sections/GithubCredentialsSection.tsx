import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import type { GithubCredentialItem } from '@/shared/types';

type GithubCredentialsSectionProps = {
  githubCredentials: GithubCredentialItem[];
  showNewGithubForm: boolean;
  showNewTokenPlainText: boolean;
  newGithubName: string;
  newGithubToken: string;
  newGithubDescription: string;
  onShowNewGithubFormChange: (value: boolean) => void;
  onNewGithubNameChange: (value: string) => void;
  onNewGithubTokenChange: (value: string) => void;
  onNewGithubDescriptionChange: (value: string) => void;
  onToggleNewTokenVisibility: () => void;
  onCreateGithubCredential: () => void;
  onCancelCreateGithubCredential: () => void;
  onToggleGithubCredential: (credentialId: string, isActive: boolean) => void;
  onDeleteGithubCredential: (credentialId: string) => void;
};

/** Rendered by CredentialsSettingsTab to list, create and delete stored GitHub credentials. */
export default function GithubCredentialsSection({
  githubCredentials,
  showNewGithubForm,
  showNewTokenPlainText,
  newGithubName,
  newGithubToken,
  newGithubDescription,
  onShowNewGithubFormChange,
  onNewGithubNameChange,
  onNewGithubTokenChange,
  onNewGithubDescriptionChange,
  onToggleNewTokenVisibility,
  onCreateGithubCredential,
  onCancelCreateGithubCredential,
  onToggleGithubCredential,
  onDeleteGithubCredential,
}: GithubCredentialsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 19 4.77 5.07 5.07 0 0 0 18.91 1S17.73.65 15 2.48a13.38 13.38 0 0 0-7 0C5.27.65 4.09 1 4.09 1A5.07 5.07 0 0 0 4 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 8 18.13V22" />
          </svg>
          <h3 className="text-lg font-semibold">{t('apiKeys.github.title')}</h3>
        </div>
        <Button size="sm" onClick={() => onShowNewGithubFormChange(!showNewGithubForm)}>
          <Plus className="mr-1 h-4 w-4" />
          {t('apiKeys.github.addButton')}
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('apiKeys.github.descriptionAlt')}</p>

      {showNewGithubForm && (
        <div className="mb-4 space-y-3 rounded-lg border bg-card p-4">
          <Input
            placeholder={t('apiKeys.github.form.namePlaceholder')}
            value={newGithubName}
            onChange={(event) => onNewGithubNameChange(event.target.value)}
          />

          <div className="relative">
            <Input
              type={showNewTokenPlainText ? 'text' : 'password'}
              placeholder={t('apiKeys.github.form.tokenPlaceholder')}
              value={newGithubToken}
              onChange={(event) => onNewGithubTokenChange(event.target.value)}
              className="pr-10"
            />
            <button
              type="button"
              onClick={onToggleNewTokenVisibility}
              aria-label={showNewTokenPlainText ? t('common:misc.hideToken') : t('common:misc.showToken')}
              className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
            >
              {showNewTokenPlainText ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <Input
            placeholder={t('apiKeys.github.form.descriptionPlaceholder')}
            value={newGithubDescription}
            onChange={(event) => onNewGithubDescriptionChange(event.target.value)}
          />

          <div className="flex gap-2">
            <Button onClick={onCreateGithubCredential}>{t('apiKeys.github.form.addButton')}</Button>
            <Button variant="outline" onClick={onCancelCreateGithubCredential}>
              {t('apiKeys.github.form.cancelButton')}
            </Button>
          </div>

          <a
            href="https://github.com/settings/tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-primary hover:underline"
          >
            {t('apiKeys.github.form.howToCreate')}
          </a>
        </div>
      )}

      <div className="space-y-2">
        {githubCredentials.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">{t('apiKeys.github.empty')}</p>
        ) : (
          githubCredentials.map((credential) => (
            <div key={credential.id} className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex-1">
                <div className="font-medium">{credential.credential_name}</div>
                {credential.description && (
                  <div className="text-xs text-muted-foreground">{credential.description}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('apiKeys.github.added')} {new Date(credential.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={credential.is_active ? 'outline' : 'secondary'}
                  onClick={() => onToggleGithubCredential(credential.id, credential.is_active)}
                >
                  {credential.is_active ? t('apiKeys.status.active') : t('apiKeys.status.inactive')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDeleteGithubCredential(credential.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
