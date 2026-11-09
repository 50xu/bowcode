import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type {
  ClaudeCredentialsSourceDeps,
  CliVersionProbe,
  ProviderAuthStatus,
  ProviderAuthSubscriptionOverride,
} from '@/shared/types.js';
import {
  probeCliVersion,
  readClaudeOAuthCredentials,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod: string;
  apiProvider?: string;
  email?: string;
};

type ClaudeProviderAuthOptions = {
  runAuthStatus?: () => Promise<unknown | null>;
};

const MISSING_CREDENTIALS_ERROR = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

/**
 * An API-key style credential found in the env or settings.json, plus the
 * user-facing label the settings UI has always shown for it. The labels are
 * kept verbatim so existing consumers of `email` see no change.
 */
type ClaudeApiKeyCredential = Pick<ProviderAuthSubscriptionOverride, 'variable' | 'source'> & {
  label: string;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

export class ClaudeProviderAuth implements IProviderAuth {
  private readonly runAuthStatus: () => Promise<unknown | null>;

  constructor(
    private readonly credentialsSourceDeps?: ClaudeCredentialsSourceDeps,
    options: ClaudeProviderAuthOptions = {},
  ) {
    this.runAuthStatus = options.runAuthStatus ?? (() => this.runCliAuthStatus());
  }

  /**
   * Checks whether the Claude Code CLI that chats run is available on this
   * host, and which version it is.
   */
  checkInstalled(): CliVersionProbe {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    if (!cliPath) {
      // Windows with no resolvable CLI: the SDK falls back to the binary it
      // bundles, so chats still work. Its version is not this CLI's to report.
      return { installed: true, exitCode: null, version: null };
    }
    return probeCliVersion(cliPath);
  }

  /**
   * Returns Claude installation and credential status. The CLI's JSON auth
   * status is authoritative; local credential discovery is a fallback when the
   * CLI cannot provide parseable status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        installedVersion,
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const cliAuthStatus = this.parseAuthStatus(await this.runAuthStatus());
    const credentials = cliAuthStatus
      ? await this.mapCliAuthStatus(cliAuthStatus)
      : await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      installedVersion,
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
      ...(credentials.subscriptionOverride ? { subscriptionOverride: credentials.subscriptionOverride } : {}),
    };
  }

  /** Runs `claude auth status --json`, including JSON emitted with a non-zero exit. */
  private async runCliAuthStatus(): Promise<unknown | null> {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    if (!cliPath) {
      return null;
    }

    return new Promise((resolve) => {
      execFile(cliPath, ['auth', 'status', '--json'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      }, (error, stdout) => {
        if (error && 'killed' in error && error.killed) {
          resolve(null);
          return;
        }
        const output = stdout || (error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
        try {
          const parsed: unknown = JSON.parse(output);
          resolve(readObjectRecord(parsed));
        } catch {
          resolve(null);
        }
      });
    });
  }

  private parseAuthStatus(value: unknown): ClaudeAuthStatus | null {
    const status = readObjectRecord(value);
    if (typeof status?.loggedIn !== 'boolean' || typeof status.authMethod !== 'string') {
      return null;
    }
    return {
      loggedIn: status.loggedIn,
      authMethod: status.authMethod,
      ...(typeof status.apiProvider === 'string' ? { apiProvider: status.apiProvider } : {}),
      ...(typeof status.email === 'string' ? { email: status.email } : {}),
    };
  }

  private async mapCliAuthStatus(status: ClaudeAuthStatus): Promise<ClaudeCredentialsStatus> {
    if (!status.loggedIn) {
      return { authenticated: false, email: null, method: null, error: MISSING_CREDENTIALS_ERROR };
    }
    if (status.authMethod === 'claude.ai') {
      return { authenticated: true, email: status.email ?? null, method: 'credentials_file' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (status.authMethod === 'api_key' || status.authMethod === 'oauth_token') {
      const apiKey = this.findApiKeyCredential(settingsEnv);
      if (apiKey) {
        const credentials: ClaudeCredentialsStatus = {
          authenticated: true,
          email: apiKey.label,
          method: 'api_key',
        };
        const subscription = await this.readCredentialsFile();
        if (subscription.authenticated) {
          credentials.subscriptionOverride = {
            variable: apiKey.variable,
            source: apiKey.source,
            subscriptionEmail: subscription.email,
          };
        }
        return credentials;
      }

      const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
        || readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN);
      if (oauthToken) {
        return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
      }
      return status.authMethod === 'api_key'
        ? { authenticated: true, email: 'API Key Auth', method: 'api_key' }
        : { authenticated: true, email: 'OAuth Token', method: 'environment' };
    }

    return {
      authenticated: true,
      email: status.authMethod || status.apiProvider || 'API Key Auth',
      method: 'api_key',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Finds an API-key style credential in the same order Claude Code checks them:
   * process env first (auth token, then API key), then the settings.json env block.
   */
  private findApiKeyCredential(settingsEnv: Record<string, unknown>): ClaudeApiKeyCredential | null {
    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { variable: 'ANTHROPIC_AUTH_TOKEN', source: 'process_env', label: 'Auth Token' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { variable: 'ANTHROPIC_API_KEY', source: 'process_env', label: 'API Key Auth' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { variable: 'ANTHROPIC_API_KEY', source: 'settings_file', label: 'API Key Auth' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { variable: 'ANTHROPIC_AUTH_TOKEN', source: 'settings_file', label: 'Configured via settings.json' };
    }

    return null;
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const settingsEnv = await this.loadSettingsEnv();

    const apiKey = this.findApiKeyCredential(settingsEnv);
    if (apiKey) {
      const status: ClaudeCredentialsStatus = { authenticated: true, email: apiKey.label, method: 'api_key' };

      // The key wins, but Claude Code says nothing when it does so while a
      // `claude /login` subscription is also signed in — every request is then
      // billed pay-as-you-go to the key (issue #568). Surface the bypassed
      // login so the settings page can warn about it; an expired or missing
      // login is not being bypassed, so it stays silent.
      const subscription = await this.readCredentialsFile();
      if (subscription.authenticated) {
        status.subscriptionOverride = {
          variable: apiKey.variable,
          source: apiKey.source,
          subscriptionEmail: subscription.email,
        };
      }

      return status;
    }

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    return this.readCredentialsFile();
  }

  /**
   * Reads the `claude /login` OAuth session from the macOS Keychain or
   * ~/.claude/.credentials.json and reports whether it is still usable. Shared
   * by the fallback path (when no env credential exists) and by the API-key
   * path (to detect a bypassed login).
   */
  private async readCredentialsFile(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = MISSING_CREDENTIALS_ERROR;

    try {
      const storedCredentials = await readClaudeOAuthCredentials(this.credentialsSourceDeps);
      if (storedCredentials === null) {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: missingCredentialsError,
        };
      }
      const creds = readObjectRecord(storedCredentials) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        // `accessToken` is short-lived (hours). Claude Code renews it silently
        // from `refreshToken` on the next CLI invocation, so an expired access
        // token alongside a live refresh token is still a working login. Before
        // this check, a still-signed-in account read as "login has expired"
        // until something else happened to run the CLI — which is why opening
        // the Shell tab and coming back made Settings flip to Connected.
        const refreshToken = readOptionalString(oauth?.refreshToken);
        const refreshTokenExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
          ? oauth.refreshTokenExpiresAt
          : undefined;
        if (refreshToken && (!refreshTokenExpiresAt || Date.now() < refreshTokenExpiresAt)) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }
}
