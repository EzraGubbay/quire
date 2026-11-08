// Preload: the only bridge between the Pi-served Quire page and the desktop shell. Runs with
// contextIsolation on and node integration off, so the page sees exactly `window.quireDesktop` and
// nothing else. The surface is a stub today; Workstream C implements the main-process handlers.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';

export interface QuireDesktopApi {
  /** Ask the shell to open the embedded Lemida sign-in. Resolves once the flow is dismissed. */
  signInToLemida(): Promise<{ ok: boolean; reason?: string }>;
  /** Subscribe to Lemida status pushes from the engine. Returns an unsubscribe function. */
  onLemidaStatus(cb: (status: unknown) => void): () => void;
}

const api: QuireDesktopApi = {
  signInToLemida: () => ipcRenderer.invoke('lemida:sign-in'),
  onLemidaStatus: (cb) => {
    const listener = (_event: IpcRendererEvent, status: unknown) => cb(status);
    ipcRenderer.on('lemida:status', listener);
    return () => {
      ipcRenderer.removeListener('lemida:status', listener);
    };
  },
};

contextBridge.exposeInMainWorld('quireDesktop', api);
