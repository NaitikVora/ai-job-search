const DEFAULT_DAEMON = 'http://127.0.0.1:47831';

export interface Pairing {
  token: string;
  daemonUrl: string;
}

export async function loadPairing(): Promise<Pairing> {
  const stored = await chrome.storage.local.get(['token', 'daemonUrl']);
  return {
    token: typeof stored.token === 'string' ? stored.token : '',
    daemonUrl: typeof stored.daemonUrl === 'string' && stored.daemonUrl ? stored.daemonUrl : DEFAULT_DAEMON,
  };
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await chrome.storage.local.set({
    token: pairing.token,
    daemonUrl: pairing.daemonUrl.replace(/\/+$/, '') || DEFAULT_DAEMON,
  });
}

export { DEFAULT_DAEMON };
