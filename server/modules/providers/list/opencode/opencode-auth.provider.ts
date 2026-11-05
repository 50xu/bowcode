import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';
import {
  probeCliVersion,
  readOpenCodeConfiguredProviderIds,
  readOpenCodeCredentials,
} from '@/shared/utils.js';

type OpenCodeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];

export class OpenCodeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the OpenCode CLI is available to the server process, and
   * which version it is. Unlike the other CLIs it has always needed a clean
   * `--version` exit to count as installed.
   */
  checkInstalled(): CliVersionProbe {
    const probe = probeCliVersion('opencode');
    return { ...probe, installed: probe.exitCode === 0 };
  }

  /**
   * Returns OpenCode CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'opencode',
      installedVersion,
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads OpenCode v2's credential store (the `credential` table of
   * `opencode.db`), then providers declared in the global config, then
   * provider API key environment variables.
   */
  private async checkCredentials(): Promise<OpenCodeCredentialsStatus> {
    const [credential] = readOpenCodeCredentials();
    if (credential) {
      return {
        authenticated: true,
        email: credential.integrationId ? `${credential.integrationId} credentials` : credential.label || null,
        method: 'credentials_store',
      };
    }

    const [configuredProviderId] = await readOpenCodeConfiguredProviderIds();
    if (configuredProviderId) {
      return {
        authenticated: true,
        email: `${configuredProviderId} provider`,
        method: 'config',
      };
    }

    const envCredential = OPENCODE_ENV_CREDENTIAL_KEYS.find((key) => process.env[key]?.trim());
    if (envCredential) {
      return {
        authenticated: true,
        email: envCredential,
        method: 'environment',
      };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'OpenCode not configured',
    };
  }
}
