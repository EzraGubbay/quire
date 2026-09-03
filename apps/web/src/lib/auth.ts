// Cloudflare Access verification. In production every request carries a Cf-Access-Jwt-Assertion header
// signed by the team's Access certs; we verify it against the application's AUD tag.
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

const mode = process.env.AUTH_MODE ?? 'none';
const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
const aud = process.env.CF_ACCESS_AUD;

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export interface Identity {
  email?: string;
  /** Present for service-token requests. */
  serviceToken?: string;
}

export async function verifyAccess(headers: Headers): Promise<Identity | null> {
  if (mode === 'none') return { email: 'dev@localhost' };
  if (!teamDomain || !aud)
    throw new Error('AUTH_MODE=cloudflare requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD');
  const token = headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  jwks ??= createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: teamDomain, audience: aud });
    return identityFrom(payload);
  } catch {
    return null;
  }
}

function identityFrom(p: JWTPayload): Identity {
  const email = typeof p.email === 'string' ? p.email : undefined;
  const common = typeof p.common_name === 'string' ? p.common_name : undefined;
  const out: Identity = {};
  if (email) out.email = email;
  if (common) out.serviceToken = common;
  return out;
}
