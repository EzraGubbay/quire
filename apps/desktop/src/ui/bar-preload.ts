// Preload for the sign-in helper panel (bar.html). Exposes only the few channels the panel needs; the panel is
// a local trusted file, so these channels are never reachable from the Pi-served Quire page (whose preload
// exposes a different, smaller surface).
import { contextBridge, ipcRenderer } from 'electron';

export interface LemidaBarApi {
  status(): Promise<{ available: boolean; hasUsername: boolean; hasPassword: boolean; hasTotp: boolean }>;
  currentTotp(): Promise<{ code: string; secondsRemaining: number } | null>;
  fill(field: 'auto' | 'username' | 'password' | 'totp'): Promise<{ filled: boolean; step?: string }>;
  openSettings(): Promise<void>;
}

const api: LemidaBarApi = {
  status: () => ipcRenderer.invoke('lemida-creds:status'),
  currentTotp: () => ipcRenderer.invoke('lemida-creds:current-totp'),
  fill: (field) => ipcRenderer.invoke('lemida-fill', { field }),
  openSettings: () => ipcRenderer.invoke('lemida-creds:open-settings'),
};

contextBridge.exposeInMainWorld('lemidaBar', api);
