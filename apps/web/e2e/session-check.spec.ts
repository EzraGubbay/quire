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

async function addLecture(page: Page, slug: string, number: string) {
  await page.goto(`/c/${slug}/lectures`);
  await hydrated(page);
  await page.getByRole('button', { name: 'Lecture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Number').fill(number);
  await dialog.getByRole('button', { name: /Create lecture/ }).click();
  await page.waitForURL(new RegExp(`/c/${slug}/lectures/[^/]+$`), { timeout: 30_000 });
}

test('session check lists a duplicate number and a mismatched deck', async ({ page }) => {
  const slug = await createCourse(page, `E2E session check ${Date.now()}`);

  // A new course has nothing to report.
  await page.goto(`/c/${slug}/settings`);
  await hydrated(page);
  await expect(page.getByTestId('session-check-empty')).toHaveText('No issues found.');

  // Drop a deck: Lecture 1 "sample", holding a deck titled "Lecture 1 — sample".
  await page.goto(`/c/${slug}/lectures`);
  await hydrated(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Add decks' }).click(),
  ]);
  await chooser.setFiles(samplePdf);
  await page.waitForURL(new RegExp(`/c/${slug}/lectures/[^/]+$`), { timeout: 30_000 });

  // A second Lecture 1 (the duplicate) and a Lecture 5.
  await addLecture(page, slug, '1');
  await addLecture(page, slug, '5');

  // Move the deck into Lecture 5; the dialog warns and still moves.
  await page.goto(`/c/${slug}/lectures`);
  await hydrated(page);
  await page
    .getByTestId('lectures-list')
    .getByRole('button', { name: /^Move / })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /Lecture 5\b/ }).check();
  await dialog.getByTestId('move-deck-go').click();
  await expect(dialog.getByTestId('move-deck-warning')).toBeVisible();
  await dialog.getByTestId('move-deck-done').click();

  await page.goto(`/c/${slug}/settings`);
  await hydrated(page);
  const panel = page.getByTestId('session-check');
  await expect(page.getByTestId('session-check-counts')).toContainText('3 problems · 2 notices');
  const group = (kind: string) => panel.locator(`[data-testid="session-check-group"][data-kind="${kind}"]`);
  await expect(group('duplicate_number').getByTestId('session-anomaly')).toContainText(
    'Lecture 1 appears 2 times.',
  );
  const mismatch = group('file_number_mismatch').getByTestId('session-anomaly');
  await expect(mismatch).toContainText('Title "Lecture 1 — sample" names Lecture 1, but it is in');
  await expect(mismatch).toContainText('Lecture 5');
  await expect(group('title_from_other_file').getByTestId('session-anomaly')).toHaveCount(1);
  await expect(group('empty_session').getByTestId('session-anomaly')).toHaveCount(2);
  await expect(panel.getByRole('button')).toHaveCount(0);

  // The all-courses summary links here.
  await page.goto('/settings');
  await hydrated(page);
  const row = page.getByTestId('session-check-summary').locator(`[data-slug="${slug}"]`);
  await expect(row).toContainText('3');
  await expect(row).toContainText('1');
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/settings#session-check$`));
  await expect(panel).toBeVisible();
});
