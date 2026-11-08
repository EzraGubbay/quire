import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const samplePdf = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

/** React is live (clicks before hydration are dropped, noticeably on a dev server). */
const hydrated = (page: Page) => page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });

async function createCourse(page: Page, name: string) {
  await page.goto('/courses');
  await hydrated(page);
  await page.getByRole('button', { name: 'New course' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create course' }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+\/overview$/);
  const slug = page.url().match(/\/c\/([^/]+)\//)?.[1];
  if (!slug) throw new Error('no course slug');
  return slug;
}

test('move a deck to another lecture from the list', async ({ page }) => {
  const slug = await createCourse(page, `E2E move ${Date.now()}`);

  // Drop a deck → it becomes a lecture (numbered 1) and redirects to that lecture.
  await page.goto(`/c/${slug}/lectures`);
  await hydrated(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Add decks' }).click(),
  ]);
  await chooser.setFiles(samplePdf);
  await page.waitForURL(new RegExp(`/c/${slug}/lectures/[^/]+$`), { timeout: 30_000 });

  // Add a second, empty lecture (its number is whatever the dialog pre-fills — the next one).
  await page.goto(`/c/${slug}/lectures`);
  await hydrated(page);
  await page.getByRole('button', { name: 'Lecture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const targetNum = await dialog.getByLabel('Number').inputValue();
  // Creating a lecture redirects to its (empty) detail page; go back to the list to do the move.
  await dialog.getByRole('button', { name: /Create lecture/ }).click();
  await page.waitForURL(new RegExp(`/c/${slug}/lectures/[^/]+$`), { timeout: 30_000 });
  await page.goto(`/c/${slug}/lectures`);
  await hydrated(page);

  const list = page.getByTestId('lectures-list');
  const targetRow = page.getByTestId('session-row').filter({ hasText: `Lecture ${targetNum}` });
  await expect(targetRow).toContainText('no files');

  // Move the only deck (under the first lecture) into the empty lecture.
  await list
    .getByRole('button', { name: /^Move / })
    .first()
    .click();
  await dialog.getByRole('radio', { name: new RegExp(`Lecture ${targetNum}\\b`) }).check();
  await dialog.getByTestId('move-deck-go').click();

  // The deck now lives under the formerly empty lecture.
  await expect(targetRow).toContainText('1 file');
});
