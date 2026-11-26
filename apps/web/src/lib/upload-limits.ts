/** Shared by the background-upload route handlers; stays under next.config's 100 MB body ceilings. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Markdown (note / document) uploads from the mobile API. */
export const MAX_NOTE_UPLOAD_BYTES = 2 * 1024 * 1024;
export const DECK_EXT = /\.(pdf|pptx?|key|odp)$/i;

export const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

/** Pulls the single `file` field out of a multipart body and validates it. */
export async function readUploadFile(req: Request): Promise<{ file: File; form: FormData } | Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'Could not read the upload.' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return json({ error: 'Choose a file.' }, 400);
  if (!DECK_EXT.test(file.name))
    return json({ error: 'Only PDF, PPTX, KEY or ODP files are accepted.' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: `${file.name} is larger than 100 MB.` }, 413);
  return { file, form };
}
