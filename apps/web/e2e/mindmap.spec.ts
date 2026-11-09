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

  await test.step('the node fits its label, and the rename box grows as you type', async () => {
    const ai = nodes.filter({ hasText: 'AI' }).first();
    const narrow = (await ai.boundingBox())?.width ?? 0;

    // Open the rename box on an existing node (select → Rename), then watch it widen with the text. Clicking
    // the node also opens the note drawer (whose title field shares the "Node label" name), so scope the
    // rename input to the canvas.
    const renameBox = page.getByTestId('mindmap-canvas').getByRole('textbox', { name: 'Node label' });
    await ai.click();
    await ai.getByRole('button', { name: 'Rename' }).click();
    await expect(renameBox).toBeVisible();
    await renameBox.fill('X');
    const boxShort = (await renameBox.boundingBox())?.width ?? 0;
    await renameBox.fill('Parallel Systems and Inference');
    const boxLong = (await renameBox.boundingBox())?.width ?? 0;
    expect(boxLong).toBeGreaterThan(boxShort + 20); // the input grew to fit what's typed
    await renameBox.press('Enter');

    // The saved node is now sized to its label — not collapsed to the ~52px minimum that shredded the text.
    const wide = nodes.filter({ hasText: 'Parallel' }).first();
    const wideW = (await wide.boundingBox())?.width ?? 0;
    expect(wideW).toBeGreaterThan(90);
    expect(wideW).toBeGreaterThan(narrow);
  });
});
