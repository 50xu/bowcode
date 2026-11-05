// sessionRetentionRoutes: mounted by the server entrypoint under /api/session-retention.
// initializeSessionRetention / closeSessionRetention: the server entrypoint
// starts the hourly inactive-session cleanup after the initial session index
// scan and stops it on shutdown.
export {
  closeSessionRetention,
  initializeSessionRetention,
  sessionRetentionRoutes,
} from './session-retention.module.js';
