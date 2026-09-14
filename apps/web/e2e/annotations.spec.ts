import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

test('annotate a PDF: selection popover, quick-add, type change, filter, search, general note', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Anno ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByLabel('PDF file').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Add PDF' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);

  // Wait for the text layer, then select a word by double-clicking it.
  const word = page.locator('.textLayer span').first();
  await expect(word).toBeVisible();
  await word.dblclick();
  await page.getByRole('button', { name: 'Annotate' }).click();

  // A Note card appears with the quote and a focused body.
  const card = page.getByTestId('annotation-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Note');
  await expect(card.locator('text=p.1')).toBeVisible();
  const body = page.getByLabel('Annotation text');
  await expect(body).toBeFocused();
  await body.fill('Why a single sample?');
  await body.press('Control+Enter');
  await expect(card).toContainText('Why a single sample?');
  const docUrl = page.url();

  // Hover reveals a pencil in the card header that opens the editor; Escape leaves it.
  await card.hover();
  await card.getByRole('button', { name: 'Edit annotation' }).click();
  await expect(page.getByLabel('Annotation text')).toBeFocused();
  await page.getByLabel('Annotation text').press('Escape');
  await expect(page.getByLabel('Annotation text')).toHaveCount(0);
  // Double-clicking the quote works too (the first click expands the card and moves the body).
  await card.locator('[class*="quote"]').dblclick();
  await expect(page.getByLabel('Annotation text')).toBeVisible();
  // `[[` offers document titles; the saved body renders the link.
  const title = (await page.locator('[class*="barTitle"]').textContent()) ?? '';
  expect(title).not.toBe('');
  await page.getByLabel('Annotation text').fill('Why a single sample? See [[');
  await page.getByRole('option', { name: title }).click();
  await expect(page.getByLabel('Annotation text')).toHaveValue(`Why a single sample? See [[${title}]]`);
  await page.getByLabel('Annotation text').press('Control+Enter');
  await expect(card.locator('a[data-wikilink]')).toHaveText(title);

  // Change type via the label menu.
  await card.getByRole('button', { name: 'Note' }).click();
  await page.getByRole('option', { name: 'Question' }).click();
  await expect(card.getByRole('button', { name: 'Question' })).toBeVisible();

  // Highlight rendered in the viewer.
  await expect(page.locator('[class*="highlights"] div').first()).toBeVisible();

  // General annotation via +.
  await page.getByRole('button', { name: 'Add a general annotation' }).click();
  await expect(page.getByTestId('annotation-card')).toHaveCount(2);
  await page
    .getByLabel('Annotation text')
    .fill('Overall: **promising** but needs a baseline, since $x^2$ grows.');
  await page.getByLabel('Annotation text').press('Control+Enter');
  // Bodies render as Markdown with math typeset (bold survives, TeX becomes a MathJax container).
  const rendered = page.getByTestId('annotation-card').filter({ hasText: 'promising' });
  await expect(rendered.locator('strong')).toHaveText('promising');
  await expect(rendered.locator('mjx-container')).toHaveCount(1, { timeout: 15_000 });

  // Filter to Question only, then search.
  await page.getByRole('button', { name: 'Question', exact: true }).first().click();
  await expect(page.getByTestId('annotation-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Question', exact: true }).first().click();
  await page.getByLabel('Search annotations').fill('baseline');
  await expect(page.getByTestId('annotation-card')).toHaveCount(1);
  await expect(page.getByTestId('annotation-card').first()).toContainText('baseline');

  // The window itself never scrolls; the viewer is the scroll container, and scroll-to-passage moves it.
  const viewer = page.getByTestId('pdf-viewer');
  await viewer.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await viewer.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await page.getByLabel('Search annotations').fill('');
  await page.getByTestId('annotation-card').first().hover();
  await page.getByRole('button', { name: 'Scroll to this passage' }).click();
  await expect.poll(() => viewer.evaluate((el) => el.scrollTop)).toBeLessThan(100);

  // pdf.js font assets are served (substitute fonts for PDFs that do not embed theirs; CMaps for CID fonts).
  expect((await page.request.get('/pdfjs/standard_fonts/LiberationSans-Regular.ttf')).status()).toBe(200);
  expect((await page.request.get('/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap')).status()).toBe(200);

  // Zoom buttons scale the rendered page relative to fit-width.
  const pageWidth = () => page.locator('[data-page="1"]').evaluate((el) => el.getBoundingClientRect().width);
  const fitted = await pageWidth();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(viewer).toHaveAttribute('data-zoom', '1.25');
  await expect.poll(pageWidth).toBeGreaterThan(fitted * 1.2);
  await page.getByRole('button', { name: 'Fit width' }).click();
  await expect(viewer).toHaveAttribute('data-zoom', '1.00');
  await expect.poll(pageWidth).toBeCloseTo(fitted, 0);

  // Collapse and restore the panel.
  await page.getByRole('button', { name: 'Hide annotations' }).click();
  await expect(page.getByRole('button', { name: 'Show annotations' })).toBeVisible();
  await page.getByRole('button', { name: 'Show annotations' }).click();
  await expect(page.getByLabel('Search annotations')).toBeVisible();

  // The linking annotation is a graph node with one edge to the document; deleting it removes both.
  await page.goto(docUrl.replace(/\/documents\/.*$/, '/notes/graph'));
  await expect(page.getByText(/2 nodes · 1 links/)).toBeVisible();
  await page.goto(docUrl);
  await page
    .getByTestId('annotation-card')
    .first()
    .getByRole('button', { name: 'Delete annotation' })
    .click();
  await expect(page.getByTestId('annotation-card')).toHaveCount(1);
  await page.goto(docUrl.replace(/\/documents\/.*$/, '/notes/graph'));
  await expect(page.getByText(/1 nodes · 0 links/)).toBeVisible();
});
