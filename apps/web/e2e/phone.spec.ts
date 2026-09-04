import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const tenPages = fileURLToPath(new URL('./fixtures/ten-pages.pdf', import.meta.url));

test.use({ viewport: { width: 428, height: 926 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

test('phone: flags hide authoring features, the viewer releases off-screen pages, theme setting applies', async ({
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
  await viewer.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator('[data-page="10"][data-rendered="true"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator('[data-rendered="true"]').count()).toBeLessThanOrEqual(4);
  await expect(page.locator('[data-page="1"][data-rendered="false"]')).toHaveCount(1);
  // Rendered canvases stay under the phone pixel-ratio cap (1.5x) even on a 3x screen.
  const ratio = await page
    .locator('[data-page="10"] canvas')
    .evaluate((c) => (c as HTMLCanvasElement).width / (c as HTMLCanvasElement).getBoundingClientRect().width);
  expect(ratio).toBeLessThanOrEqual(1.51);
  // No selection popover on phones: the Annotate button never appears after selecting text.
  await expect(page.getByRole('button', { name: 'Annotate' })).toHaveCount(0);

  // Theme setting in Settings applies to the page.
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('.folio')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: 'Light' }).check();
  await expect(page.locator('.folio')).toHaveAttribute('data-theme', 'light');
});
