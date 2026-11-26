import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isApiKeyAuthorization, isResearchApiKeyAuthorization, RESEARCH_MCP_PATH } from './api-key';

describe('isResearchApiKeyAuthorization', () => {
  beforeEach(() => {
    process.env.QUIRE_API_KEY = 'master';
    process.env.QUIRE_RESEARCH_API_KEY = 'qk_r_research';
  });
  afterEach(() => {
    delete process.env.QUIRE_API_KEY;
    delete process.env.QUIRE_RESEARCH_API_KEY;
  });
  it('matches only the research key', () => {
    expect(isResearchApiKeyAuthorization('Bearer qk_r_research')).toBe(true);
    expect(isResearchApiKeyAuthorization('Bearer master')).toBe(false);
    expect(isResearchApiKeyAuthorization(null)).toBe(false);
  });
  it('the master check does not accept the research key', () => {
    expect(isApiKeyAuthorization('Bearer qk_r_research')).toBe(false);
  });
  it('never matches when unset or empty', () => {
    process.env.QUIRE_RESEARCH_API_KEY = '';
    expect(isResearchApiKeyAuthorization('Bearer ')).toBe(false);
    delete process.env.QUIRE_RESEARCH_API_KEY;
    expect(isResearchApiKeyAuthorization('Bearer undefined')).toBe(false);
  });
  it('exposes the exact path', () => {
    expect(RESEARCH_MCP_PATH).toBe('/research/mcp');
  });
});
