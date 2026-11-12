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

test('mind map: ⌘-click multi-selects nodes and Backspace deletes them all after confirm', async ({
  page,
}) => {
  const slug = await createCourse(page, `E2E mindmap multi ${Date.now()}`);
  await page.goto(`/c/${slug}/mindmap`);
  await hydrated(page);

  const nodes = page.getByTestId('mindmap-node');
  const label = page.getByTestId('mindmap-canvas').getByRole('textbox', { name: 'Node label' });

  // Build three sibling nodes: a root plus two siblings added with Enter.
  await page.getByRole('button', { name: 'Add a root node' }).click();
  await label.fill('Alpha');
  await label.press('Enter');
  await expect(nodes.filter({ hasText: 'Alpha' })).toBeVisible();
  await page.keyboard.press('Enter');
  await label.fill('Beta');
  await label.press('Enter');
  await expect(nodes.filter({ hasText: 'Beta' })).toBeVisible();
  await page.keyboard.press('Enter');
  await label.fill('Gamma');
  await label.press('Enter');
  await expect(nodes.filter({ hasText: 'Gamma' })).toBeVisible();
  await expect(nodes).toHaveCount(3);

  const beta = nodes.filter({ hasText: 'Beta' }).first();
  const gamma = nodes.filter({ hasText: 'Gamma' }).first();

  // Select Beta, then ⌘-click Gamma to add it to the selection — both highlight, Alpha does not.
  await beta.getByRole('button', { name: 'Beta' }).click();
  await gamma.getByRole('button', { name: 'Gamma' }).click({ modifiers: ['Meta'] });
  await expect(beta).toHaveAttribute('data-selected', 'true');
  await expect(gamma).toHaveAttribute('data-selected', 'true');
  await expect(nodes.filter({ hasText: 'Alpha' }).first()).not.toHaveAttribute('data-selected', 'true');

  // Backspace asks to delete the group; confirming removes both and leaves Alpha.
  await page.keyboard.press('Backspace');
  await expect(page.getByText('Delete 2 nodes?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(nodes.filter({ hasText: 'Beta' })).toHaveCount(0);
  await expect(nodes.filter({ hasText: 'Gamma' })).toHaveCount(0);
  await expect(nodes).toHaveCount(1);
});
