import { useEffect, useState } from 'react';

import { APP_VERSION } from '@/shared/constants';

/** Compare the running self-hosted server version with the installed frontend bundle. */
export function useVersionCheck() {
  // A version mismatch means the installed package changed without restarting the server.
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRestartRequired(data.version !== APP_VERSION);
        }
      } catch {
        // Keep the restart hint off when the health endpoint is unavailable.
      }
    };
    void fetchHealth();
  }, []);

  return { currentVersion: APP_VERSION, restartRequired };
}
