import { fail, ok } from './respond';
import { ERROR_CODES, ErrorEnvelope } from './schema';

describe('ok', () => {
  it('returns the data as JSON with status 200 by default', async () => {
    const res = ok({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('honours an explicit status', async () => {
    const res = ok({ id: 'x' }, 201);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'x' });
  });

  it('serialises arrays at the top level', async () => {
    expect(await ok([1, 2]).json()).toEqual([1, 2]);
  });
});

describe('fail', () => {
  it('builds the exact { error: { code, message } } envelope', async () => {
    const res = fail('not_found', 'No such course', 404);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'No such course' } });
  });

  it.each(ERROR_CODES)('emits a valid envelope for code %s', async (code) => {
    const body = await fail(code, 'm', 400).json();
    expect(ErrorEnvelope.safeParse(body).success).toBe(true);
    expect(body.error.code).toBe(code);
  });

  it('defaults the HTTP status from the code when omitted', () => {
    expect(fail('unauthorized', 'x').status).toBe(401);
    expect(fail('not_found', 'x').status).toBe(404);
    expect(fail('invalid_request', 'x').status).toBe(400);
    expect(fail('rate_limited', 'x').status).toBe(429);
    expect(fail('ai_unavailable', 'x').status).toBe(503);
    expect(fail('internal', 'x').status).toBe(500);
  });
});
