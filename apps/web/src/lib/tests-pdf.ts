// Renders a generated test to an A4 PDF through the conversion service's Chromium: Markdown → HTML, MathJax (SVG)
// typeset inside the page, then print. Throws ConvertUnavailable when no service is configured.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { htmlToPdf } from './convert';
import { storeFile } from './files';
import { renderMarkdown } from './markdown';

export interface TestPdfInput {
  projectId: string;
  testId: string;
  title: string;
  courseName: string;
  questions: { n: number; body: string; points: number }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function testHtml(
  input: Omit<TestPdfInput, 'projectId' | 'testId'>,
  mathjaxSrc: string,
): Promise<string> {
  const bodies = await Promise.all(input.questions.map((q) => renderMarkdown(q.body)));
  const total = input.questions.reduce((n, q) => n + q.points, 0);
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(input.title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 11.5pt/1.5 "Source Serif 4", Georgia, "Times New Roman", serif; color: #1f1b16; max-width: 100%; }
  header { border-bottom: 1px solid #999; padding-bottom: 8px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  h1 { font-size: 17pt; margin: 0; }
  .meta { font: 10pt system-ui, sans-serif; color: #555; }
  .q { break-inside: avoid; margin: 0 0 22px; }
  .q h2 { font: 600 11.5pt system-ui, sans-serif; margin: 0 0 6px; display: flex; justify-content: space-between; }
  .q h2 .pts { color: #666; font-weight: 500; }
  .q p { margin: 0 0 8px; }
  .q pre { font: 9.5pt/1.4 "IBM Plex Mono", Menlo, monospace; background: #f3f1ec; padding: 8px 10px; border-radius: 4px; white-space: pre-wrap; }
  .q code { font: 9.5pt "IBM Plex Mono", Menlo, monospace; }
  .q table { border-collapse: collapse; margin: 6px 0; } .q td, .q th { border: 1px solid #bbb; padding: 3px 8px; }
  .space { height: 7em; border-bottom: 1px dotted #bbb; margin-top: 6px; }
  [dir="auto"] { unicode-bidi: plaintext; }
  mjx-container[display="true"] { margin: 6px 0; }
</style>
</head>
<body>
<header><h1>${esc(input.title)}</h1><div class="meta">${esc(input.courseName)} · ${date} · ${total} points</div></header>
${input.questions
  .map(
    (q, i) =>
      `<section class="q"><h2><span>Question ${q.n}</span><span class="pts">${q.points} pt${q.points === 1 ? '' : 's'}</span></h2>${bodies[i]}<div class="space"></div></section>`,
  )
  .join('\n')}
<script>
  window.MathJax = { tex: { inlineMath: [['$','$'],['\\\\(','\\\\)']], displayMath: [['$$','$$'],['\\\\[','\\\\]']] },
    startup: { pageReady: () => MathJax.startup.defaultPageReady().then(() => { window.__mjxDone = true; }) } };
</script>
<script src="${mathjaxSrc}"></script>
</body>
</html>`;
}

/** Stores the PDF at <project>/tests/<testId>.pdf and returns the relative path. */
export async function renderTestPdf(input: TestPdfInput): Promise<string> {
  const mathjax = await readFile(path.join(process.cwd(), 'public', 'mathjax', 'tex-svg.js')).catch(() =>
    readFile(path.join(process.cwd(), 'apps', 'web', 'public', 'mathjax', 'tex-svg.js')),
  );
  const html = await testHtml(input, 'tex-svg.js');
  const pdf = await htmlToPdf(html, {
    assets: [{ name: 'tex-svg.js', data: new Uint8Array(mathjax), type: 'text/javascript' }],
    waitForExpression: 'window.__mjxDone === true',
    timeoutMs: 180_000,
  });
  return storeFile(input.projectId, `tests/${input.testId}`, 'pdf', pdf);
}
