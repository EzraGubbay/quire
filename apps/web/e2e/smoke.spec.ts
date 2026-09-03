import { expect, test } from '@playwright/test';

test('health endpoint reports the database', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toMatchObject({ ok: true, db: 'up' });
});

test('home page renders the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('button', { name: /switch to (dark|light) mode/i })).toBeVisible();
});
