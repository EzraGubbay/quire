// Pure helpers for the Settings → Mobile devices panel (safe to import from client components).

export interface DeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `quire://pair?server=<origin>&code=<code>` — the URI the Android app's QR scanner understands. */
export function buildPairingUri(origin: string, code: string): string {
  const server = encodeURIComponent(origin.replace(/\/+$/, ''));
  return `quire://pair?server=${server}&code=${encodeURIComponent(code)}`;
}

/** Active devices only, newest first, with no token material. */
export function shapeDevices(
  rows: {
    id: string;
    deviceName: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }[],
): DeviceView[] {
  return rows
    .filter((r) => !r.revokedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => ({
      id: r.id,
      name: r.deviceName,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    }));
}
