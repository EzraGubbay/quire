import { expect, test } from '@playwright/test';

test('create a project and walk its tabs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  const name = `E2E project ${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Description').fill('Created by the Playwright smoke test.');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/p\/e2e-project-\d+\/overview$/);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  for (const tab of ['Documents', 'Notes', 'Sources', 'Experiments', 'Chat']) {
    await page.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: tab })).toBeVisible();
  }
  await page.goto('/');
  await expect(page.getByRole('link', { name })).toBeVisible();
});
