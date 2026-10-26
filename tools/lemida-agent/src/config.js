// Configuration from the environment (load a .env with `node --env-file-if-exists=.env`, as the npm
// scripts do). Only QUIRE_BASE_URL is strictly required; QUIRE_API_KEY is required against the deployed
// Pi (it is optional when Quire runs locally with AUTH_MODE=none).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const base = (process.env.QUIRE_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('QUIRE_BASE_URL is required (e.g. https://quire.ezragubbay.com)');
  return {
    agentDir,
    baseUrl: base,
    apiKey: process.env.QUIRE_API_KEY ?? '',
    loginUrl: process.env.LEMIDA_LOGIN_URL ?? 'https://lemida.biu.ac.il/login/index.php',
    homeUrl: process.env.LEMIDA_HOME_URL ?? 'https://lemida.biu.ac.il/my/',
    profileDir: process.env.LEMIDA_PROFILE_DIR ?? path.join(agentDir, '.profile'),
    pollMs: Number(process.env.LEMIDA_POLL_MS ?? 5000),
    probeMs: Number(process.env.LEMIDA_PROBE_MS ?? 3_600_000),
    loginTimeoutMs: Number(process.env.LEMIDA_LOGIN_TIMEOUT_MS ?? 300_000),
    // Honest, ordinary desktop UA; we never impersonate the Moodle mobile app.
    userAgent:
      process.env.LEMIDA_USER_AGENT ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}
