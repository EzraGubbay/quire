// Helpers for JSON route handlers used by the Python client.
import type { z } from 'zod';
import { getProjectBySlug } from './projects';

export function json(data: unknown, init: number | ResponseInit = 200): Response {
  return Response.json(data, typeof init === 'number' ? { status: init } : init);
}

export function apiError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function readJson<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, res: apiError('Body must be JSON') };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return {
      ok: false,
      res: apiError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')),
    };
  return { ok: true, data: parsed.data };
}

export async function projectFromSlug(slug: string) {
  const project = await getProjectBySlug(slug);
  return project ?? null;
}
