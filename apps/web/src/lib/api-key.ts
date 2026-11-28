import { bearerMatches } from '@/core/identity/caller';

/** The only path the research key authenticates. Exact match: never a prefix. */
export { RESEARCH_MCP_PATH } from '@/core/identity/caller';

/** True when an Authorization header carries the configured QUIRE_API_KEY. An unset or empty key never matches. */
export function isApiKeyAuthorization(header: string | null): boolean {
  return bearerMatches(header, process.env.QUIRE_API_KEY);
}

/**
 * True when an Authorization header carries the configured QUIRE_RESEARCH_API_KEY. An unset or empty key never
 * matches. Deliberately separate from isApiKeyAuthorization so requireSession (Server Actions) never accepts it.
 */
export function isResearchApiKeyAuthorization(header: string | null): boolean {
  return bearerMatches(header, process.env.QUIRE_RESEARCH_API_KEY);
}
