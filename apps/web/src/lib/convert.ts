/**
 * Document conversion through a Gotenberg service (headless LibreOffice + Chromium), when GOTENBERG_URL is set.
 * Callers degrade when it is not: decks keep their .pptx with an "Add rendering" prompt, tests offer a print view.
 */

export class ConvertUnavailable extends Error {
  constructor(message = 'Document conversion is not configured (GOTENBERG_URL)') {
    super(message);
    this.name = 'ConvertUnavailable';
  }
}

export const convertConfigured = (): boolean => Boolean(process.env.GOTENBERG_URL);

function endpoint(path: string): string {
  const base = process.env.GOTENBERG_URL;
  if (!base) throw new ConvertUnavailable();
  return `${base.replace(/\/$/, '')}${path}`;
}

async function post(path: string, form: FormData, timeoutMs: number): Promise<Uint8Array> {
  const url = endpoint(path);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ConvertUnavailable(`Conversion service unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Conversion failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Office document (pptx, docx, …) → PDF via LibreOffice. */
export async function officeToPdf(
  data: Uint8Array,
  fileName: string,
  timeoutMs = 180_000,
): Promise<Uint8Array> {
  const form = new FormData();
  form.append('files', new Blob([data as BlobPart]), fileName);
  return post('/forms/libreoffice/convert', form, timeoutMs);
}

export interface HtmlToPdfOptions {
  /** Extra files referenced relatively from index.html (scripts, fonts). */
  assets?: { name: string; data: Uint8Array | string; type?: string }[];
  /** JS expression Chromium waits for before printing, e.g. "window.__ready === true". */
  waitForExpression?: string;
  paperWidth?: number;
  paperHeight?: number;
  margin?: number;
  timeoutMs?: number;
}

/** HTML → PDF via Chromium. A4 portrait by default, sizes in inches as Gotenberg expects. */
export async function htmlToPdf(html: string, opts: HtmlToPdfOptions = {}): Promise<Uint8Array> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  for (const a of opts.assets ?? []) {
    form.append(
      'files',
      new Blob([a.data as BlobPart], { type: a.type ?? 'application/octet-stream' }),
      a.name,
    );
  }
  form.append('paperWidth', String(opts.paperWidth ?? 8.27));
  form.append('paperHeight', String(opts.paperHeight ?? 11.69));
  const m = String(opts.margin ?? 0.6);
  form.append('marginTop', m);
  form.append('marginBottom', m);
  form.append('marginLeft', m);
  form.append('marginRight', m);
  form.append('printBackground', 'true');
  if (opts.waitForExpression) form.append('waitForExpression', opts.waitForExpression);
  return post('/forms/chromium/convert/html', form, opts.timeoutMs ?? 120_000);
}

/** Reachability for /api/health. */
export async function convertHealth(): Promise<'up' | 'down' | 'unset'> {
  if (!convertConfigured()) return 'unset';
  try {
    const res = await fetch(endpoint('/health'), { signal: AbortSignal.timeout(3000) });
    return res.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}
