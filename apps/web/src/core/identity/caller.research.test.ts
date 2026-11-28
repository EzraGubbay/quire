// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bearerMatches, isResearchMcpRequest, RESEARCH_MCP_PATH } from './caller';

const req = (pathname: string, headers: Record<string, string> = {}) => ({
  pathname,
  headers: new Headers(headers),
});

describe('RESEARCH_MCP_PATH', () => {
  it('is the exact research MCP path', () => {
    expect(RESEARCH_MCP_PATH).toBe('/research/mcp');
  });
});

describe('isResearchMcpRequest', () => {
  it.each(['GET', 'POST', 'DELETE', 'PUT', 'HEAD'])('accepts /research/mcp for any method (%s)', (method) => {
    // The function takes no method: a request-like carrying one is accepted all the same.
    expect(isResearchMcpRequest({ ...req('/research/mcp'), method } as never)).toBe(true);
  });

  it.each([
    '/research/mcp/',
    '/research/mcp/x',
    '/research/mcpx',
    '/research',
    '/Research/mcp',
    '/research//mcp',
    '/mcp',
    '',
  ])('rejects %j', (pathname) => {
    expect(isResearchMcpRequest(req(pathname))).toBe(false);
  });

  it('rejects /research/mcp carrying a next-action header', () => {
    expect(isResearchMcpRequest(req('/research/mcp', { 'next-action': '0'.repeat(40) }))).toBe(false);
  });
});

describe('bearerMatches', () => {
  it('accepts exactly `Bearer <key>`', () => {
    expect(bearerMatches('Bearer k', 'k')).toBe(true);
  });

  it.each<[string | null, string | undefined]>([
    ['bearer k', 'k'],
    ['k', 'k'],
    ['Bearer  k', 'k'],
    ['Bearer k ', 'k'], // raw string: the pure function does not trim (the Headers API does)
    [null, 'k'],
    ['Bearer ', ''],
    ['Bearer ', undefined],
    ['Bearer undefined', undefined],
    ['', 'k'],
  ])('rejects header %j with key %j', (header, key) => {
    expect(bearerMatches(header, key)).toBe(false);
  });
});
