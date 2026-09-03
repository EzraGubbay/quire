import NextAuth, { type NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';

export const AUTH_MODE = (process.env.AUTH_MODE ?? 'none') as 'none' | 'github';
export const ALLOWED_GITHUB_LOGIN = process.env.ALLOWED_GITHUB_LOGIN ?? '';
export const githubConfigured = Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);

/** True when a GitHub login may use this app: exactly one account, compared case-insensitively. */
export function isAllowedLogin(login: unknown): boolean {
  return (
    typeof login === 'string' &&
    login.length > 0 &&
    login.toLowerCase() === ALLOWED_GITHUB_LOGIN.toLowerCase()
  );
}

const config: NextAuthConfig = {
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
  providers: [GitHub],
  callbacks: {
    signIn({ profile }) {
      return isAllowedLogin(profile?.login);
    },
    jwt({ token, profile }) {
      if (profile?.login) token.login = profile.login;
      return token;
    },
    session({ session, token }) {
      if (typeof token.login === 'string') (session.user as { login?: string }).login = token.login;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
