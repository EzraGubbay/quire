import { expect, test } from '@playwright/test';

test('write a Markdown document with math and a wiki link, then annotate it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Md ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByRole('tab', { name: 'New Markdown' }).click();
  await page.getByLabel('Title').fill('Routing summary');
  await page.getByRole('button', { name: 'Create document' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);

  // Edit: replace the body.
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(/\/edit$/);
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(
    '# Routing summary\n\nThe bound is tight when the router matches the posterior, see [[ELBO tightness]].\n\nInline $\\lambda H(q)$ and display:\n\n$$\\int f(x)\\,dx$$\n',
  );
  await expect(page.locator('[class*="preview"]')).toContainText('router matches the posterior');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Saved/)).toBeVisible();

  // View: rendered, math typeset, wiki link present.
  await page.getByRole('link', { name: 'Done editing' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Routing summary' })).toBeVisible();
  await expect(page.locator('a[data-wikilink="ELBO tightness"]')).toBeVisible();
  await expect(page.locator('mjx-container').first()).toBeVisible();

  // Annotate a selection in the rendered text.
  const para = page.getByText('The bound is tight when', { exact: false });
  await para.dblclick({ position: { x: 24, y: 10 } });
  await page.getByRole('button', { name: 'Annotate' }).click();
  const card = page.getByTestId('annotation-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('“');
  await page.getByLabel('Annotation text').fill('Same condition as the lemma.');
  await page.getByLabel('Annotation text').press('Control+Enter');
  await expect(card).toContainText('Same condition as the lemma.');
  await expect(page.getByTestId('annotation-card')).toHaveCount(1);
});
