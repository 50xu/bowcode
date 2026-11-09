import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Badge, Button, Dialog, DialogContent, DialogTitle, Input, Select } from '@/shared/ui';
import type { AgentProvider, ProviderAgentCreatePayload, ProviderAgentDefinition } from '@/shared/types';
import { useProviderAgents } from '@/modules/provider-agents/hooks/useProviderAgents';
import { SettingsCard, SettingsRow, SettingsSection } from '@/modules/settings';
import { cn } from '@/shared/utils';

// Matches the shared Input so text areas sit beside inputs without a different background or border.
const TEXTAREA_CLASS_NAME = 'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring';

type Props = { provider: AgentProvider; workspaces: Array<{ name: string; path: string }> };
type AgentRowProps = {
  agent: ProviderAgentDefinition;
  onEdit: (agent: ProviderAgentDefinition) => void;
  onDelete: (agent: ProviderAgentDefinition) => void;
};
type CreateEditorProps = {
  form: ProviderAgentCreatePayload;
  workspacePath: string;
  onChange: (form: ProviderAgentCreatePayload) => void;
};
type RawEditorProps = { content: string; onChange: (content: string) => void };

const emptyForm = (): ProviderAgentCreatePayload => ({
  scope: 'user',
  name: '',
  description: '',
  model: '',
  instructions: '',
});

function AgentRow({ agent, onEdit, onDelete }: AgentRowProps) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex items-center gap-3 px-4 py-2.5" title={agent.filePath}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="truncate text-sm">{agent.name}</strong>
          {agent.model && <Badge variant="outline">{agent.model}</Badge>}
        </div>
        <p className="truncate text-xs text-muted-foreground">{agent.description}</p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button size="icon" variant="ghost" aria-label={t('providerAgents.edit')} onClick={() => onEdit(agent)}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label={t('providerAgents.delete')} onClick={() => onDelete(agent)}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function CreateEditor({ form, workspacePath, onChange }: CreateEditorProps) {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">{t('providerAgents.fields.name')}</span>
          <Input
            value={form.name}
            placeholder="code-reviewer"
            onChange={(event) => onChange({ ...form, name: event.target.value })}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">{t('providerAgents.scope')}</span>
          <Select
            className="w-full"
            value={form.scope}
            onChange={(event) => onChange({ ...form, scope: event.target.value as 'user' | 'project' })}
          >
            <option value="user">{t('providerAgents.user')}</option>
            {workspacePath && <option value="project">{t('providerAgents.project')}</option>}
          </Select>
        </label>
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-foreground">{t('providerAgents.fields.description')}</span>
        <Input
          value={form.description}
          onChange={(event) => onChange({ ...form, description: event.target.value })}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-foreground">{t('providerAgents.fields.model')}</span>
        <Input
          value={form.model}
          onChange={(event) => onChange({ ...form, model: event.target.value })}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-foreground">{t('providerAgents.fields.instructions')}</span>
        <textarea
          className={cn('min-h-40 resize-y', TEXTAREA_CLASS_NAME)}
          value={form.instructions}
          onChange={(event) => onChange({ ...form, instructions: event.target.value })}
        />
      </label>
    </div>
  );
}

function RawEditor({ content, onChange }: RawEditorProps) {
  const { t } = useTranslation('settings');
  return (
    <textarea
      aria-label={t('providerAgents.content')}
      className={cn('min-h-80 resize-y font-mono', TEXTAREA_CLASS_NAME)}
      value={content}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Rendered by the Settings agents category to manage one provider's native agent definitions. */
export function ProviderAgents({ provider, workspaces }: Props) {
  const { t } = useTranslation('settings');
  // Identifies the workspace whose project-scope agents are currently visible and editable.
  const [workspacePath, setWorkspacePath] = useState(workspaces[0]?.path || '');
  const { agents, error, loading, refresh, create, read, update, remove } = useProviderAgents(provider, workspacePath);
  // Chooses whether the dialog edits an existing native file or creates a new one.
  const [editing, setEditing] = useState<ProviderAgentDefinition | null>(null);
  // Controls the create/edit dialog independently of the selected record.
  const [open, setOpen] = useState(false);
  // Holds the requested new agent fields until creation succeeds or is canceled.
  const [form, setForm] = useState<ProviderAgentCreatePayload>(emptyForm);
  // Holds the unmodified file syntax for raw editing, including optional metadata.
  const [content, setContent] = useState('');
  // Shows validation and transport errors in the dialog where the action occurred.
  const [actionError, setActionError] = useState<string | null>(null);
  // Prevents duplicate submissions while a file operation is in progress.
  const [busy, setBusy] = useState(false);

  const beginCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setActionError(null);
    setOpen(true);
  };

  const beginEdit = async (agent: ProviderAgentDefinition) => {
    setActionError(null);
    try {
      const file = await read(agent);
      setContent(file.content);
      setEditing(agent);
      setOpen(true);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const save = async () => {
    setBusy(true);
    setActionError(null);
    try {
      if (editing) {
        await update(editing, content);
      } else {
        await create({ ...form, workspacePath: form.scope === 'project' ? workspacePath : undefined });
      }
      setOpen(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async (agent: ProviderAgentDefinition) => {
    if (!window.confirm(t('providerAgents.confirmDelete', { name: agent.name }))) {
      return;
    }
    try {
      await remove(agent);
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('providerAgents.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('providerAgents.subtitle', { provider })}</p>
        </div>
        <Button size="sm" onClick={beginCreate}>
          <Plus className="h-4 w-4" />
          {t('providerAgents.new')}
        </Button>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          {t('providerAgents.refresh')}
        </Button>
      </div>
      {workspaces.length > 0 && (
        <SettingsCard>
          <SettingsRow label={t('providerAgents.workspace')}>
            <Select
              aria-label={t('providerAgents.workspace')}
              className="w-48"
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.path} value={workspace.path}>{workspace.name}</option>
              ))}
            </Select>
          </SettingsRow>
        </SettingsCard>
      )}
      {(error || (!open && actionError)) && <p role="alert" className="text-sm text-destructive">{error || actionError}</p>}
      {loading && <p className="text-sm text-muted-foreground">{t('providerAgents.loading')}</p>}
      {(['user', ...(workspacePath ? ['project'] : [])] as Array<'user' | 'project'>).map((scope) => {
        const scopedAgents = agents.filter((agent) => agent.scope === scope);
        return (
          <SettingsSection key={scope} title={`${t(`providerAgents.${scope}`)} (${scopedAgents.length})`}>
            <SettingsCard divided>
              {scopedAgents.length === 0 && (
                <p className="px-4 py-3 text-sm text-muted-foreground">{t('providerAgents.empty')}</p>
              )}
              {scopedAgents.map((agent) => (
                <AgentRow
                  key={agent.filePath}
                  agent={agent}
                  onEdit={(selected) => void beginEdit(selected)}
                  onDelete={(selected) => void deleteAgent(selected)}
                />
              ))}
            </SettingsCard>
          </SettingsSection>
        );
      })}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          // Settings is itself a z-[9999] modal; the default z-50 would open this behind it.
          wrapperClassName="z-[10000]"
          className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden p-0"
        >
          <DialogTitle>{t(editing ? 'providerAgents.editTitle' : 'providerAgents.new')}</DialogTitle>
          {/* DialogTitle is screen-reader only, so the visible header is drawn here (same layout as the Skills dialog). */}
          <div className="shrink-0 border-b border-border/60 px-5 py-4">
            <div className="text-base font-medium text-foreground">
              {t(editing ? 'providerAgents.editTitle' : 'providerAgents.new')}
            </div>
            <div className="mt-1 truncate text-sm text-muted-foreground" title={editing?.filePath}>
              {editing ? editing.filePath : t('providerAgents.subtitle', { provider })}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {editing
              ? <RawEditor content={content} onChange={setContent} />
              : <CreateEditor form={form} workspacePath={workspacePath} onChange={setForm} />}
            {actionError && <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p>}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-5 py-3">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {t('providerAgents.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
