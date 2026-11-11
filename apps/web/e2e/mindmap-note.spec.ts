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

test('mind map: a node note renders by default (math typeset) and Edit toggles the source editor', async ({
  page,
}) => {
  const slug = await createCourse(page, `E2E mindmap note ${Date.now()}`);
  await page.goto(`/c/${slug}/mindmap`);
  await hydrated(page);

  // Add a root node to attach the note to.
  await page.getByRole('button', { name: 'Add a root node' }).click();
  const label = page.getByRole('textbox', { name: 'Node label' });
  await label.fill('Integrals');
  await label.press('Enter');
  const node = page.getByTestId('mindmap-node').filter({ hasText: 'Integrals' }).first();

  // Click the node to open the note drawer. An empty note opens in the editor; type a note with math.
  await node.click();
  const panel = page.getByTestId('mindmap-note-panel');
  await expect(panel).toBeVisible();
  const noteEditor = panel.locator('.cm-content');
  await noteEditor.click();
  await page.keyboard.type('Euler: $e^{i\\pi}+1=0$');
  await expect(panel.locator('[data-status="saved"]')).toBeVisible(); // autosaved

  // Switch to the rendered view: math is typeset, no raw source editor.
  await panel.getByRole('button', { name: 'Finish editing note' }).click();
  const rendered = page.getByTestId('mindmap-note-rendered');
  await expect(rendered).toBeVisible();
  await expect(rendered.locator('mjx-container')).toBeVisible();
  await expect(panel.locator('.cm-content')).toHaveCount(0);

  // Edit toggles back to the source editor with the note text intact.
  await panel.getByRole('button', { name: 'Edit note' }).click();
  await expect(panel.locator('.cm-content')).toBeVisible();
  await expect(panel.locator('.cm-content')).toContainText('e^{i\\pi}+1=0');
});
