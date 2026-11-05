export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerCapabilitiesService: used by Schedules to validate which permission modes a provider accepts.
export { providerCapabilitiesService } from './services/provider-capabilities.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read, and
// by Schedules to allocate the new app session every scheduled run starts in.
export { sessionsService } from './services/sessions.service.js';

// External CLI holders: websocket admission/takeover and scheduled queue waiting.
export {
  findExternalClaudeCliSession,
  findOwnedClaudeCliSessions,
  terminateExternalClaudeCliSession,
  terminateOwnedClaudeCliSession,
} from './services/claude-cli-liveness.service.js';
export type { ExternalClaudeCliSession } from './services/claude-cli-liveness.service.js';

// reapOrphanedOpenCodeServers: used by the server entrypoint at startup to stop
// OpenCode turn servers a killed Bowcode process left running.
export { reapOrphanedOpenCodeServers } from './list/opencode/opencode-runtime.provider.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
