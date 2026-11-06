import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cadenceToCron,
  cronToCadence,
  fromTimeInputValue,
  listWeekdayNames,
  toTimeInputValue,
} from '@/modules/schedules/utils/scheduleCadence';
import type { CadencePreset } from '@/modules/schedules/utils/scheduleCadence';
import { api, readApiJson } from '@/shared/api';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type {
  LLMProvider,
  PermissionMode,
  Project,
  ProviderModelsDefinition,
  Schedule,
  ScheduleInput,
} from '@/shared/types';
import { Button, Input } from '@/shared/ui';

/** The cadence choices the form offers: the presets, a one-off time, or a raw cron expression. */
type CadenceMode = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'once' | 'cron';

/** Everything the form edits, kept as one object so a reset or a reopen replaces it in one step. */
type ScheduleDraft = {
  name: string;
  projectId: string;
  provider: LLMProvider;
  model: string;
  effort: string;
  permissionMode: PermissionMode;
  prompt: string;
  mode: CadenceMode;
  everyHours: number;
  time: string;
  dayOfWeek: number;
  runAtLocal: string;
  cron: string;
  timezone: string;
  maxDurationMinutes: number;
};

/** The parts of a provider's capability row the form reads. */
type CapabilityRow = {
  provider: LLMProvider;
  permissionModes: PermissionMode[];
  defaultPermissionMode: PermissionMode;
  supportsEffort: boolean;
};

type ScheduleEditorFormProps = {
  /** The schedule being edited, or null to create one. */
  schedule: Schedule | null;
  /** The sidebar's projects; the schedule's project is picked from these. */
  projects: Project[];
  onCancel: () => void;
  /** Saves the schedule; rejects with the server's reason when it refuses. */
  onSubmit: (input: ScheduleInput) => Promise<void>;
};

const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'opencode'];
const PREVIEW_DEBOUNCE_MS = 350;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

/** "YYYY-MM-DDTHH:mm" in the browser's zone, for a datetime-local input. */
function toLocalDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Finds the sidebar project a schedule's stored path belongs to. */
function findProjectForPath(projects: Project[], projectPath: string): Project | undefined {
  return projects.find((project) => project.fullPath === projectPath || project.path === projectPath);
}

function draftFromSchedule(schedule: Schedule | null, projects: Project[]): ScheduleDraft {
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
  inOneHour.setMinutes(0, 0, 0);
  const base: ScheduleDraft = {
    name: '',
    projectId: projects.length === 1 ? projects[0].projectId : '',
    provider: readSelectedProvider(),
    model: '',
    effort: '',
    permissionMode: 'auto',
    prompt: '',
    mode: 'daily',
    everyHours: 2,
    time: '09:00',
    dayOfWeek: 1,
    runAtLocal: toLocalDateTimeValue(inOneHour),
    cron: '0 9 * * *',
    timezone: browserTimeZone(),
    maxDurationMinutes: 0,
  };
  if (!schedule) return base;

  const draft: ScheduleDraft = {
    ...base,
    name: schedule.name,
    projectId: findProjectForPath(projects, schedule.projectPath)?.projectId ?? '',
    provider: schedule.provider,
    model: schedule.model ?? '',
    effort: schedule.effort ?? '',
    permissionMode: schedule.permissionMode,
    prompt: schedule.prompt,
    timezone: schedule.timezone,
    maxDurationMinutes: schedule.maxDurationMinutes,
  };
  if (schedule.kind === 'once') {
    return { ...draft, mode: 'once', runAtLocal: schedule.runAt ? toLocalDateTimeValue(new Date(schedule.runAt)) : base.runAtLocal };
  }
  const cron = schedule.cronExpression ?? '';
  const cadence = cronToCadence(cron);
  switch (cadence.type) {
    case 'hourly':
      return { ...draft, mode: 'hourly', everyHours: cadence.everyHours, time: toTimeInputValue(0, cadence.minute), cron };
    case 'daily':
    case 'weekdays':
      return { ...draft, mode: cadence.type, time: toTimeInputValue(cadence.hour, cadence.minute), cron };
    case 'weekly':
      return { ...draft, mode: 'weekly', dayOfWeek: cadence.dayOfWeek, time: toTimeInputValue(cadence.hour, cadence.minute), cron };
    case 'custom':
      return { ...draft, mode: 'cron', cron };
  }
}

/** The cron expression the draft's cadence stands for, or null for a one-off. */
function draftCron(draft: ScheduleDraft): string | null {
  const { hour, minute } = fromTimeInputValue(draft.time);
  let preset: CadencePreset;
  switch (draft.mode) {
    case 'once':
      return null;
    case 'cron':
      return draft.cron.trim();
    case 'hourly':
      preset = { type: 'hourly', everyHours: draft.everyHours, minute };
      break;
    case 'daily':
      preset = { type: 'daily', hour, minute };
      break;
    case 'weekdays':
      preset = { type: 'weekdays', hour, minute };
      break;
    case 'weekly':
      preset = { type: 'weekly', dayOfWeek: draft.dayOfWeek, hour, minute };
      break;
  }
  return cadenceToCron(preset);
}

function formatInZone(iso: string, timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString(locale);
  }
}

const FIELD_CLASS = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring';
const LABEL_CLASS = 'mb-1 block text-xs font-medium text-muted-foreground';

/** Rendered by this module's SchedulesDialog to create or edit one schedule. */
export default function ScheduleEditorForm({ schedule, projects, onCancel, onSubmit }: ScheduleEditorFormProps) {
  const { t, i18n } = useTranslation('schedules');
  // The values being edited; seeded from the schedule (or defaults) once per open.
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFromSchedule(schedule, projects));
  // The capability matrix, which decides the permission modes offered per provider.
  const [capabilities, setCapabilities] = useState<Partial<Record<LLMProvider, CapabilityRow>>>({});
  // The model catalog of the provider it was read for; ignored once the provider changes until the new one arrives.
  const [modelCatalog, setModelCatalog] = useState<{ provider: LLMProvider; models: ProviderModelsDefinition } | null>(null);
  // The next fires the server computed for the current cron expression, or why it refused it.
  const [preview, setPreview] = useState<{ nextRuns: string[]; error: string | null } | null>(null);
  // True while a save is in flight, so the button cannot submit twice.
  const [isSaving, setIsSaving] = useState(false);
  // The server's (or the form's) reason the last save failed.
  const [saveError, setSaveError] = useState<string | null>(null);

  const update = (patch: Partial<ScheduleDraft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const timeZones = useMemo(() => listTimeZones(), []);
  const weekdays = useMemo(() => listWeekdayNames(i18n.language), [i18n.language]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await readApiJson<{ data: { providers: CapabilityRow[] } }>(await api.providers.capabilities());
        if (cancelled) return;
        const byProvider: Partial<Record<LLMProvider, CapabilityRow>> = {};
        for (const row of body.data?.providers ?? []) byProvider[row.provider] = row;
        setCapabilities(byProvider);
      } catch (error) {
        console.error('Failed to load provider capabilities:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const provider = draft.provider;
    void (async () => {
      try {
        const body = await readApiJson<{ data: { models: ProviderModelsDefinition } }>(await api.providers.models(provider));
        if (!cancelled && body.data?.models) setModelCatalog({ provider, models: body.data.models });
      } catch (error) {
        console.error('Failed to load models:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.provider]);

  // Never `plan`: a plan waits for an approval nobody is there to give.
  const permissionModes = useMemo<PermissionMode[]>(
    () => (capabilities[draft.provider]?.permissionModes ?? (['default', 'auto', 'acceptEdits', 'bypassPermissions'] as PermissionMode[]))
      .filter((mode) => mode !== 'plan'),
    [capabilities, draft.provider],
  );

  const models = modelCatalog?.provider === draft.provider ? modelCatalog.models : null;

  // The mode actually used: the chosen one when the provider offers it,
  // otherwise auto when offered, else the provider's own default.
  const providerDefaultMode = capabilities[draft.provider]?.defaultPermissionMode;
  const permissionMode: PermissionMode = permissionModes.includes(draft.permissionMode)
    ? draft.permissionMode
    : permissionModes.includes('auto')
      ? 'auto'
      : providerDefaultMode && permissionModes.includes(providerDefaultMode) ? providerDefaultMode : permissionModes[0];

  const selectedModel = models?.OPTIONS.find((option) => option.value === (draft.model || models.DEFAULT));
  const effortValues = capabilities[draft.provider]?.supportsEffort === false ? [] : selectedModel?.effort?.values ?? [];

  const cron = draftCron(draft);
  useEffect(() => {
    if (!cron) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const body = await readApiJson<{ data: { nextRuns: string[] } }>(await api.schedules.preview(cron, draft.timezone));
          if (!cancelled) setPreview({ nextRuns: body.data?.nextRuns ?? [], error: null });
        } catch (error) {
          if (!cancelled) setPreview({ nextRuns: [], error: error instanceof Error ? error.message : String(error) });
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cron, draft.timezone]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.projectId) {
      setSaveError(t('editor.projectRequired'));
      return;
    }
    let runAt: string | null = null;
    if (draft.mode === 'once') {
      const parsed = new Date(draft.runAtLocal);
      if (Number.isNaN(parsed.getTime())) {
        setSaveError(t('editor.runAtRequired'));
        return;
      }
      runAt = parsed.toISOString();
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSubmit({
        name: draft.name.trim(),
        projectId: draft.projectId,
        provider: draft.provider,
        model: draft.model || null,
        effort: draft.effort || null,
        permissionMode,
        prompt: draft.prompt,
        kind: draft.mode === 'once' ? 'once' : 'cron',
        cronExpression: cron,
        runAt,
        timezone: draft.timezone.trim() || 'UTC',
        maxDurationMinutes: draft.maxDurationMinutes,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-name">{t('editor.name')}</label>
          <Input id="schedule-name" value={draft.name} onChange={(event) => update({ name: event.target.value })}
            placeholder={t('editor.namePlaceholder')} required maxLength={200} />
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-project">{t('editor.project')}</label>
          <select id="schedule-project" className={FIELD_CLASS} value={draft.projectId} required
            onChange={(event) => update({ projectId: event.target.value })}>
            <option value="" disabled>{t('editor.projectPlaceholder')}</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>{project.displayName}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL_CLASS} htmlFor="schedule-provider">{t('editor.provider')}</label>
            <select id="schedule-provider" className={FIELD_CLASS} value={draft.provider}
              onChange={(event) => update({ provider: event.target.value as LLMProvider, model: '', effort: '' })}>
              {PROVIDERS.map((provider) => <option key={provider} value={provider}>{t(`providers.${provider}`)}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="schedule-model">{t('editor.model')}</label>
            <select id="schedule-model" className={FIELD_CLASS} value={draft.model}
              onChange={(event) => update({ model: event.target.value, effort: '' })}>
              <option value="">{t('editor.defaultModel')}</option>
              {models?.OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              {draft.model && models && !models.OPTIONS.some((option) => option.value === draft.model) && (
                <option value={draft.model}>{draft.model}</option>
              )}
            </select>
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="schedule-effort">{t('editor.effort')}</label>
            <select id="schedule-effort" className={FIELD_CLASS} value={draft.effort} disabled={effortValues.length === 0}
              onChange={(event) => update({ effort: event.target.value })}>
              <option value="">{t('editor.defaultEffort')}</option>
              {effortValues.map((value) => <option key={value.value} value={value.value}>{value.value}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="schedule-permission">{t('editor.permissionMode')}</label>
            <select id="schedule-permission" className={FIELD_CLASS} value={permissionMode}
              onChange={(event) => update({ permissionMode: event.target.value as PermissionMode })}>
              {permissionModes.map((mode) => <option key={mode} value={mode}>{t(`permissionModes.${mode}`)}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-prompt">{t('editor.prompt')}</label>
          <textarea id="schedule-prompt" className={`${FIELD_CLASS} h-28 resize-y py-2`} value={draft.prompt} required
            onChange={(event) => update({ prompt: event.target.value })} placeholder={t('editor.promptPlaceholder')} />
        </div>

        <fieldset className="space-y-3">
          <legend className={LABEL_CLASS}>{t('editor.cadence')}</legend>
          <select aria-label={t('editor.cadence')} className={FIELD_CLASS} value={draft.mode}
            onChange={(event) => update({ mode: event.target.value as CadenceMode })}>
            {(['hourly', 'daily', 'weekdays', 'weekly', 'once', 'cron'] as CadenceMode[]).map((mode) => (
              <option key={mode} value={mode}>{t(`editor.modes.${mode}`)}</option>
            ))}
          </select>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            {draft.mode === 'hourly' && (
              <>
                <span>{t('editor.every')}</span>
                <Input type="number" min={1} max={23} className="w-20" value={draft.everyHours} aria-label={t('editor.hours')}
                  onChange={(event) => update({ everyHours: Math.min(23, Math.max(1, Number(event.target.value) || 1)) })} />
                <span>{t('editor.hoursAtMinute')}</span>
                <Input type="number" min={0} max={59} className="w-20" aria-label={t('editor.minute')}
                  value={fromTimeInputValue(draft.time).minute}
                  onChange={(event) => update({ time: toTimeInputValue(0, Math.min(59, Math.max(0, Number(event.target.value) || 0))) })} />
              </>
            )}
            {draft.mode === 'weekly' && (
              <select aria-label={t('editor.day')} className={`${FIELD_CLASS} w-auto`} value={draft.dayOfWeek}
                onChange={(event) => update({ dayOfWeek: Number(event.target.value) })}>
                {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
              </select>
            )}
            {(draft.mode === 'daily' || draft.mode === 'weekdays' || draft.mode === 'weekly') && (
              <Input type="time" className="w-32" aria-label={t('editor.time')} value={draft.time}
                onChange={(event) => update({ time: event.target.value })} />
            )}
            {draft.mode === 'once' && (
              <Input type="datetime-local" className="w-56" aria-label={t('editor.runAt')} value={draft.runAtLocal}
                onChange={(event) => update({ runAtLocal: event.target.value })} />
            )}
            {draft.mode === 'cron' && (
              <div className="w-full">
                <Input className="font-mono" aria-label={t('editor.cronExpression')} value={draft.cron}
                  placeholder="0 9 * * 1-5" onChange={(event) => update({ cron: event.target.value })} />
                <p className="mt-1 text-xs text-muted-foreground">{t('editor.cronHelp')}</p>
              </div>
            )}
          </div>

          {draft.mode !== 'once' && (
            <div>
              <label className={LABEL_CLASS} htmlFor="schedule-timezone">{t('editor.timezone')}</label>
              <Input id="schedule-timezone" list="schedule-timezones" value={draft.timezone}
                onChange={(event) => update({ timezone: event.target.value })} />
              <datalist id="schedule-timezones">
                {timeZones.map((zone) => <option key={zone} value={zone} />)}
              </datalist>
            </div>
          )}

          {cron && (
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs" aria-live="polite">
              <p className="mb-1 font-medium text-muted-foreground">{t('editor.preview')}</p>
              {preview?.error ? (
                <p className="text-destructive">{preview.error}</p>
              ) : preview ? (
                <ul className="space-y-0.5">
                  {preview.nextRuns.map((fire) => <li key={fire}>{formatInZone(fire, draft.timezone, i18n.language)}</li>)}
                </ul>
              ) : (
                <p className="text-muted-foreground">{t('editor.previewLoading')}</p>
              )}
            </div>
          )}
        </fieldset>

        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-max-duration">{t('editor.maxDuration')}</label>
          <Input id="schedule-max-duration" type="number" min={0} max={1440} className="w-32" value={draft.maxDurationMinutes}
            onChange={(event) => update({ maxDurationMinutes: Math.max(0, Math.min(1440, Number(event.target.value) || 0)) })} />
          {draft.maxDurationMinutes === 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('editor.maxDurationUnlimitedWarning')}</p>
          )}
        </div>

        {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>{t('editor.cancel')}</Button>
        <Button type="submit" size="sm" disabled={isSaving}>
          {schedule ? t('editor.save') : t('editor.create')}
        </Button>
      </div>
    </form>
  );
}
