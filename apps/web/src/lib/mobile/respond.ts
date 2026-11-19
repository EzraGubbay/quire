// Response helpers for every /api/mobile/v1 handler: `ok` for success bodies, `fail` for the error envelope.
import { ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from './schema';

/** JSON success response. */
export function ok<T>(data: T, status = 200): Response {
  return Response.json(data, { status });
}

/** Error envelope `{ error: { code, message } }`; status defaults from the code (see ERROR_STATUS). */
export function fail(code: ErrorCode, message: string, status: number = ERROR_STATUS[code]): Response {
  const body: ErrorEnvelope = { error: { code, message } };
  return Response.json(body, { status });
}
