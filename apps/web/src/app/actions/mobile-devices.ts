'use server';

import { revalidatePath } from 'next/cache';
import QRCode from 'qrcode';
import { createPairingCode } from '@/lib/mobile/auth';
import { currentWebLogin, revokeOwnedDevice } from '@/lib/mobile/devices';
import { buildPairingUri } from '@/lib/mobile/pairing-ui';
import { requireSession } from '@/lib/require-session';

export interface PairingOffer {
  code: string;
  expiresAt: string;
  qrSvg: string;
}

/** Mint a one-time pairing code for the signed-in user and render its `quire://pair` QR as inline SVG. */
export async function createPairingOfferAction(origin: string): Promise<PairingOffer> {
  await requireSession();
  const login = await currentWebLogin();
  if (!login) throw new Error('Sign in to pair a device');
  const { code, expiresAt } = await createPairingCode(login);
  const qrSvg = await QRCode.toString(buildPairingUri(origin, code), {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
  });
  return { code, expiresAt: expiresAt.toISOString(), qrSvg };
}

export async function revokeDeviceAction(id: string): Promise<void> {
  await requireSession();
  const login = await currentWebLogin();
  if (!login) throw new Error('Sign in to manage devices');
  await revokeOwnedDevice(login, id);
  revalidatePath('/settings');
}
