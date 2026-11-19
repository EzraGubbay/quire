'use client';

import { Button } from '@ezragubbay/folio';
import { useState, useTransition } from 'react';
import {
  createPairingOfferAction,
  type PairingOffer,
  revokeDeviceAction,
} from '@/app/actions/mobile-devices';
import type { DeviceView } from '@/lib/mobile/pairing-ui';
import s from './settings.module.css';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');

export function MobileDevicesPanel({ devices }: { devices: DeviceView[] }) {
  const [pending, start] = useTransition();
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className={s.section}>
      <h2 className={s.h2}>Mobile devices</h2>
      <p className={s.help}>
        Pair the Quire Android app: generate a code, then scan the QR or type the code in the app. Codes are
        single-use and expire after 10 minutes.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                setOffer(await createPairingOfferAction(window.location.origin));
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not create a pairing code');
              }
            })
          }
        >
          Pair a device
        </Button>
        {error && <span className={s.help}>{error}</span>}
      </div>
      {offer && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            data-testid="pairing-qr"
            style={{ width: 168, height: 168, background: '#fff' }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated server-side by qrcode from our own URI
            dangerouslySetInnerHTML={{ __html: offer.qrSvg }}
          />
          <div style={{ display: 'grid', gap: 4 }}>
            <code
              data-testid="pairing-code"
              style={{ font: '600 24px / 1 monospace', letterSpacing: '0.12em' }}
            >
              {offer.code}
            </code>
            <span data-testid="pairing-expiry" className={s.help}>
              Expires at {new Date(offer.expiresAt).toLocaleTimeString()}
            </span>
          </div>
        </div>
      )}
      {devices.length === 0 ? (
        <p className={s.help}>No devices paired yet.</p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Device</th>
              <th>Paired</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{fmt(d.createdAt)}</td>
                <td>{fmt(d.lastUsedAt)}</td>
                <td>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => start(async () => revokeDeviceAction(d.id))}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
