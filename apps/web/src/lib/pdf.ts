// Server-side PDF text extraction with pdf.js (legacy build runs in Node without a DOM).

export interface ExtractedPdf {
  pageCount: number;
  pages: string[];
  /** From the PDF info dictionary, when present. */
  title?: string;
  author?: string;
}

interface TextItem {
  str: string;
  hasEOL?: boolean;
}

export async function extractPdf(data: Uint8Array): Promise<ExtractedPdf> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js transfers the buffer to its worker (detaching it), so hand it a copy and keep the caller's bytes intact.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const raw of content.items as TextItem[]) {
      if (!('str' in raw)) continue;
      text += raw.str;
      text += raw.hasEOL ? '\n' : ' ';
    }
    pages.push(
      text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/ {2,}/g, ' ')
        .trim(),
    );
    page.cleanup();
  }
  const meta = (await doc.getMetadata().catch(() => null))?.info as
    | { Title?: string; Author?: string }
    | undefined;
  await doc.destroy();
  const out: ExtractedPdf = { pageCount: doc.numPages, pages };
  if (meta?.Title?.trim()) out.title = meta.Title.trim();
  if (meta?.Author?.trim()) out.author = meta.Author.trim();
  return out;
}

/** A best-effort title from the first page when the PDF has no metadata title: the first non-trivial line. */
export function guessTitle(firstPage: string, fallback: string): string {
  const line = firstPage
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 12 && l.length <= 200 && !/^(arxiv|https?:|doi|abstract)/i.test(l));
  return line ?? fallback;
}
