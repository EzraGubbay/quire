import { expect, test } from '@playwright/test';

test('command palette: ⌘K opens, searches notes, runs commands', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Palette ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);

  // New note via the palette command.
  const input = page.getByRole('dialog', { name: 'Command palette' }).getByRole('textbox');
  // Right after a redirect the shell may not have attached its key handler yet; retry the shortcut.
  await expect(async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await expect(input).toBeFocused({ timeout: 700 });
  }).toPass({ timeout: 10_000 });
  await input.fill('new note');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/notes\?new=1$/);
  await page.getByLabel('Title').fill('Straight-through estimator');
  await page.getByRole('button', { name: 'Create note' }).click();
  await page.waitForURL(/edit=1$/);
  await page.locator('.cm-content').click();
  await page.keyboard.type('Bias of the straight-through gradient grows with lambda.');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForURL(/\/notes\/straight-through-estimator$/);

  // Search finds the note by body text; Enter opens it.
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await input.fill('gradient grows');
  await expect(page.getByRole('option', { name: /Straight-through estimator/ })).toBeVisible();
  await page.getByRole('option', { name: /Straight-through estimator/ }).click();
  await page.waitForURL(/\/notes\/straight-through-estimator$/);

  // Escape closes; clicking the app-bar search opens.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await page.getByLabel('Search this project').click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});
