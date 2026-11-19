import { exchangePairingCode } from '@/lib/mobile/auth';
import { clientIp, pairLimiter } from '@/lib/mobile/rate-limit';
import { fail, ok } from '@/lib/mobile/respond';
import { PairRequest } from '@/lib/mobile/schema';

export const dynamic = 'force-dynamic';

/** PUBLIC: exchange a single-use pairing code for a per-device token. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (pairLimiter.blocked(ip))
    return fail('rate_limited', 'Too many failed pairing attempts; try again later');
  const body = PairRequest.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    pairLimiter.fail(ip);
    return fail('invalid_request', 'Expected { code: 8 alphanumeric characters, deviceName }');
  }
  const paired = await exchangePairingCode(body.data.code, body.data.deviceName);
  if (!paired) {
    pairLimiter.fail(ip);
    return fail('invalid_request', 'Invalid, expired or already used pairing code');
  }
  return ok(paired);
}
