import { expect, test } from '@playwright/test';

test('a global macro defined in settings typesets in a note', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Math macros' })).toBeVisible();
  const name = `Qm${Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
  await page
    .getByLabel('Add macros, one per line')
    .fill(`\\newcommand{\\${name}}{\\mathbb{E}_{q}}\n\\${name}two[1]: \\lVert #1 \\rVert`);
  await page.getByRole('button', { name: 'Add macros' }).click();
  await expect(page.getByText('2 saved.')).toBeVisible();
  await expect(page.locator('code', { hasText: `\\${name}two[1]` })).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Macros ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByLabel('Title').fill('Macro check');
  await page.getByRole('button', { name: 'Create note' }).click();
  await page.waitForURL(/edit=1$/);
  await page.locator('.cm-content').click();
  await page.keyboard.type(`Expectation $\\${name}[x]$ and norm $\\${name}two{v}$.`);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForURL(/\/notes\/macro-check$/);
  const body = page.locator('[class*="markdown-view"]').first();
  await expect(body.locator('mjx-container')).toHaveCount(2);
  // MathJax renders unknown macros as red error text; a defined macro produces none.
  await expect(body.locator('mjx-merror, [data-mjx-error]')).toHaveCount(0);

  // Delete the two macros again to keep the global set clean.
  await page.goto('/settings');
  await page.getByRole('button', { name: `Delete macro ${name}two` }).click();
  await page.getByRole('button', { name: `Delete macro ${name}` }).click();
  await expect(page.locator('code', { hasText: `\\${name}` })).toHaveCount(0);
});
