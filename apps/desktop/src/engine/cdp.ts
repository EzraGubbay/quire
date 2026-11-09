// A tiny Chrome DevTools Protocol client over a WebSocket — just enough to drive the Brave we spawn for the
// Lemida sign-in (list targets, attach to the page, evaluate a snippet, read cookies). This is the same wire
// protocol Playwright speaks under the hood; we hand-roll the handful of calls we need rather than pull in
// Playwright and its bundled Chromium. Commands are id-correlated; events (and session-scoped notifications)
// are ignored.
import WebSocket from 'ws';

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: Error | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      // No Origin header (Node ws omits it), so Chromium's --remote-allow-origins check passes without us
      // having to open the debug endpoint to arbitrary web origins.
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      const client = new CdpClient(ws);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP connect timed out (${wsUrl})`));
      }, timeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(client);
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('message', (data: WebSocket.RawData) => client.onMessage(data.toString()));
      ws.on('close', () => client.onClose());
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // an event / session notification — not awaited here
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
    else p.resolve(msg.result ?? {});
  }

  private onClose(): void {
    this.closedError ??= new Error('CDP connection closed');
    for (const p of this.pending.values()) p.reject(this.closedError);
    this.pending.clear();
  }

  /** Send a CDP command and resolve with its `result`. `sessionId` targets a flat-attached session. */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closing
    }
  }
}
