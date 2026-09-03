/** True when a GitHub login may use this app: exactly one account, compared case-insensitively. */
export function isAllowedLogin(login: unknown, allowed = process.env.ALLOWED_GITHUB_LOGIN ?? ''): boolean {
  return (
    typeof login === 'string' &&
    login.length > 0 &&
    allowed.length > 0 &&
    login.toLowerCase() === allowed.toLowerCase()
  );
}
