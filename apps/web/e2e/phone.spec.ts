import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const tenPages = fileURLToPath(new URL('./fixtures/ten-pages.pdf', import.meta.url));

test.use({ viewport: { width: 428, height: 926 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

test('phone: flags, immersive reader (bar, zoom, sheets), folder sheet, theme setting', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: 'quire.platform', value: 'phone', url: baseURL ?? 'http://localhost:3000' },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Phone ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/p\/([^/]+)\/overview$/);
  const slug = page.url().match(/\/p\/([^/]+)\//)?.[1] as string;

  // Graph is off on phones: no link in the rail, and the route explains itself.
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Graph' })).toHaveCount(0);
  await page.goto(`/p/${slug}/notes/graph`);
  await expect(page.getByTestId('unavailable')).toContainText('not available on phones');

  // Ten-page PDF: only a window of pages keeps a rendered canvas.
  await page.goto(`/p/${slug}/documents`);
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByLabel('PDF file').setInputFiles(tenPages);
  await page.getByRole('button', { name: 'Add PDF' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  const viewer = page.getByTestId('pdf-viewer');
  await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();

  // Immersive reader: no app bar, a bottom bar with the position, hidden by scrolling and shown by a tap.
  await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
  const chrome = page.getByTestId('reader-chrome');
  await expect(chrome).toHaveAttribute('data-visible', 'true');
  await expect(page.getByTestId('reader-position')).toHaveText('1 / 10');
  await viewer.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(chrome).toHaveAttribute('data-visible', 'false');
  await expect(page.locator('[data-page="10"][data-rendered="true"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator('[data-rendered="true"]').count()).toBeLessThanOrEqual(4);
  await expect(page.locator('[data-page="1"][data-rendered="false"]')).toHaveCount(1);
  await expect(page.getByTestId('reader-position')).toHaveText('10 / 10');
  // Rendered canvases stay under the phone pixel-ratio cap (1.5x) even on a 3x screen.
  const ratio = await page
    .locator('[data-page="10"] canvas')
    .evaluate((c) => (c as HTMLCanvasElement).width / (c as HTMLCanvasElement).getBoundingClientRect().width);
  expect(ratio).toBeLessThanOrEqual(1.51);
  await viewer.tap({ position: { x: 200, y: 300 } });
  await expect(chrome).toHaveAttribute('data-visible', 'true');
  // No selection popover on phones: the Annotate button never appears after selecting text.
  await expect(page.getByRole('button', { name: 'Annotate' })).toHaveCount(0);

  // Double-tap zooms to 2x around the tap; the page grows and the viewer can pan sideways.
  const pageWidth = () => page.locator('[data-page="10"]').evaluate((el) => el.getBoundingClientRect().width);
  const fitted = await pageWidth();
  await viewer.tap({ position: { x: 200, y: 300 } });
  await viewer.tap({ position: { x: 200, y: 300 } });
  await expect(viewer).toHaveAttribute('data-zoom', '2.00');
  await expect.poll(pageWidth).toBeGreaterThan(fitted * 1.9);
  expect(await viewer.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await viewer.tap({ position: { x: 200, y: 300 } });
  await viewer.tap({ position: { x: 200, y: 300 } });
  await expect(viewer).toHaveAttribute('data-zoom', '1.00');

  // Annotations live in a bottom sheet; + adds a general note.
  await viewer.tap({ position: { x: 200, y: 300 } });
  await expect(chrome).toHaveAttribute('data-visible', 'true');
  await page.getByRole('button', { name: /^Annotations, / }).click();
  const sheet = page.getByTestId('annotations-sheet');
  await expect(sheet).toHaveAttribute('data-open', 'true');
  await page.getByRole('button', { name: 'Add a general annotation' }).click();
  await expect(page.getByTestId('annotation-card')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveAttribute('data-open', 'false');
  // The More sheet holds status, Ask and Delete.
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByTestId('more-sheet')).toHaveAttribute('data-open', 'true');
  await page.getByRole('button', { name: 'done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'done', exact: true })).toHaveAttribute(
    'data-active',
    'true',
  );
  await page.keyboard.press('Escape');

  // Documents tab: the folder rail becomes a bar that opens a folder sheet.
  await page.getByRole('link', { name: 'Back to documents' }).click();
  await page.waitForURL(/\/documents$/);
  await expect(page.getByRole('complementary', { name: 'Folders' })).toHaveCount(0);
  await page.getByTestId('folder-bar').click();
  const folderSheet = page.getByTestId('folder-sheet');
  await expect(folderSheet).toHaveAttribute('data-open', 'true');
  await folderSheet.getByRole('button', { name: /^Unfiled/ }).click();
  await expect(folderSheet).toHaveAttribute('data-open', 'false');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Unfiled');
  await expect(page.getByTestId('folder-bar')).toContainText('Unfiled');

  // Theme setting in Settings applies to the page.
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('.folio')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: 'Light' }).check();
  await expect(page.locator('.folio')).toHaveAttribute('data-theme', 'light');
});
