// Preload for the credentials settings dialog (credentials.html). The dialog is write-mostly: it can read
// *status* (which fields are set) and a live code *preview* computed from a secret it passes in, but it never
// reads a stored secret back. Saving hands the fields to main, which encrypts them into the Keychain-backed
// vault.
import { contextBridge, ipcRenderer } from 'electron';

export interface LemidaCredsApi {
  status(): Promise<{ available: boolean; hasUsername: boolean; hasPassword: boolean; hasTotp: boolean }>;
  save(data: {
    username?: string;
    password?: string;
    totpSecret?: string;
  }): Promise<{ ok: boolean; reason?: string }>;
  preview(secret: string): Promise<{ code: string; secondsRemaining: number } | null>;
}

const api: LemidaCredsApi = {
  status: () => ipcRenderer.invoke('lemida-creds:status'),
  save: (data) => ipcRenderer.invoke('lemida-creds:save', data),
  preview: (secret) => ipcRenderer.invoke('lemida-creds:preview-totp', secret),
};

contextBridge.exposeInMainWorld('lemidaCreds', api);
