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
  const headings: Record<string, string> = {
    Documents: 'All documents',
    Notes: 'Notes',
    Sources: 'Sources',
    Experiments: 'Experiments',
    Chat: 'Chat',
  };
  for (const [tab, heading] of Object.entries(headings)) {
    await page.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await page.goto('/');
  await expect(page.getByRole('link', { name })).toBeVisible();
});
