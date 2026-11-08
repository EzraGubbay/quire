import { expect, type Page, test } from '@playwright/test';

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

test('mind map: add node opens a placeholder, and Tab/Enter add child/sibling', async ({ page }) => {
  const slug = await createCourse(page, `E2E mindmap ${Date.now()}`);
  await page.goto(`/c/${slug}/mindmap`);
  await hydrated(page);

  const input = page.getByRole('textbox', { name: 'Node label' });
  const nodes = page.getByTestId('mindmap-node');

  await test.step('adding a node opens an empty box with a placeholder, not pre-filled text', async () => {
    await page.getByRole('button', { name: 'Add a root node' }).click();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(''); // the fix: empty, so there is nothing to erase
    await expect(input).toHaveAttribute('placeholder', /\S/); // a placeholder stands in for the old text
    await input.fill('AI');
    await input.press('Enter');
    await expect(nodes.filter({ hasText: 'AI' })).toBeVisible();
  });

  await test.step('Tab adds a child (also an empty placeholder box)', async () => {
    await page.keyboard.press('Tab');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('');
    await input.fill('Search');
    await input.press('Enter');
    await expect(nodes.filter({ hasText: 'Search' })).toBeVisible();
  });

  await test.step('Enter adds a sibling', async () => {
    await page.keyboard.press('Enter');
    await expect(input).toBeVisible();
    await input.fill('Logic');
    await input.press('Enter');
    await expect(nodes.filter({ hasText: 'Logic' })).toBeVisible();
  });

  // Three authored nodes now exist (AI, and its two children Search + Logic).
  await expect(nodes).toHaveCount(3);
});
