import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isApiKeyAuthorization } from './api-key';

describe('isApiKeyAuthorization', () => {
  const prev = process.env.QUIRE_API_KEY;
  beforeEach(() => {
    process.env.QUIRE_API_KEY = 'k';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.QUIRE_API_KEY;
    else process.env.QUIRE_API_KEY = prev;
  });

  it('accepts the exact bearer', () => {
    expect(isApiKeyAuthorization('Bearer k')).toBe(true);
  });
  it('rejects a wrong, missing or malformed header', () => {
    expect(isApiKeyAuthorization('Bearer x')).toBe(false);
    expect(isApiKeyAuthorization(null)).toBe(false);
    expect(isApiKeyAuthorization('k')).toBe(false);
    expect(isApiKeyAuthorization('bearer k')).toBe(false);
  });
  it('never matches when the key is empty or unset', () => {
    process.env.QUIRE_API_KEY = '';
    expect(isApiKeyAuthorization('Bearer ')).toBe(false);
    expect(isApiKeyAuthorization('')).toBe(false);
    delete process.env.QUIRE_API_KEY;
    expect(isApiKeyAuthorization('Bearer ')).toBe(false);
    expect(isApiKeyAuthorization('Bearer undefined')).toBe(false);
  });
});
