import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';

import { createSessionRetentionRouter } from './session-retention.routes.js';
import { createSessionRetentionService } from './session-retention.service.js';

/**
 * Tells every open client that sessions disappeared from the active lists
 * without a user action, so sidebars refetch instead of showing rows that no
 * longer exist. Only ids travel; clients re-read through authenticated routes.
 */
function announceSessionsRemoved(sessionIds: string[], action: 'archived' | 'deleted'): void {
  const frame = JSON.stringify({
    kind: 'sessions_removed',
    sessionIds,
    action,
    reason: 'retention',
    timestamp: new Date().toISOString(),
  });
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) {
      return;
    }
    try {
      client.send(frame);
    } catch (error) {
      console.error('[SessionRetention] Failed to announce removed sessions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

const sessionRetentionService = createSessionRetentionService({
  config: appConfigDb,
  findInactiveSessions: (query) => {
    const { sessions, total } = sessionsDb.findInactiveSessions(query);
    return {
      total,
      sessions: sessions.map((row) => ({
        sessionId: row.session_id,
        provider: row.provider,
        title: row.custom_name?.trim() || row.session_id,
        projectPath: row.project_path,
        projectName: row.custom_project_name?.trim() || null,
        isArchived: Boolean(row.isArchived),
        lastActivity: row.last_activity,
      })),
    };
  },
  // Runs, background work and external Claude CLI holders (idle ones too):
  // the same list the sidebar uses for its activity indicators.
  listBusySessionIds: async () =>
    (await sessionsService.listRunningSessions()).map((entry) => entry.sessionId),
  isSessionBusy: (sessionId) =>
    chatRunRegistry.isProcessing(sessionId) || providerRuntimeService.hasBackgroundWork(sessionId),
  // Exactly what the sidebar's Archive and permanent Delete call, so disk and
  // database effects match the manual actions.
  archiveSession: async (sessionId) => {
    await sessionsService.deleteOrArchiveSessionById(sessionId);
  },
  deleteSession: (sessionId) =>
    sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true }),
  announceSessionsRemoved,
});

/** Session Retention router assembled for the authenticated server mount. */
export const sessionRetentionRoutes = createSessionRetentionRouter(sessionRetentionService);

/** Used by the server entrypoint to start the hourly cleanup once sessions are indexed. */
export function initializeSessionRetention(): void {
  sessionRetentionService.start();
}

/** Used by the server entrypoint to stop the cleanup timer on shutdown. */
export function closeSessionRetention(): void {
  sessionRetentionService.stop();
}
