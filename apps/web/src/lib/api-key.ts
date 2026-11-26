/** True when an Authorization header carries the configured QUIRE_API_KEY. An unset or empty key never matches. */
export function isApiKeyAuthorization(header: string | null): boolean {
  const key = process.env.QUIRE_API_KEY;
  if (!key) return false;
  return header === `Bearer ${key}`;
}
