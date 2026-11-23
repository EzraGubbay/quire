// The process-wide transport for the current config: one `fcmTransport` (so its access-token cache is shared) or the
// logging fake under PUSH_TRANSPORT=fake. Null when push is disabled.
import { type PushConfig, pushConfig } from './config';
import { fakeTransport, fcmTransport, type PushTransport } from './transport';

const g = globalThis as unknown as { __quirePushTransport?: PushTransport };

export function currentTransport(config: PushConfig = pushConfig()): PushTransport | null {
  if (!config.enabled) return null;
  g.__quirePushTransport ??=
    config.transport === 'fake' ? fakeTransport({ log: true }) : fcmTransport(config);
  return g.__quirePushTransport;
}
