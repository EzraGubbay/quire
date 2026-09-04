import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

test('debug mode records viewer events and errors, visible in Settings', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/settings');
  const toggle = page.getByRole('checkbox', { name: /Debug mode/ });
  if (!(await toggle.isChecked())) await toggle.check();
  await expect(page.getByText('Debug mode on')).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Debug ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);
  await page.getByRole('link', { name: 'Documents', exact: true }).click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByLabel('PDF file').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Add PDF' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
  // A deliberate error and a console warning are captured too.
  await page.evaluate(() => {
    console.warn('debug-spec warning');
    setTimeout(() => {
      throw new Error('debug-spec thrown');
    }, 0);
  });
  await page.waitForTimeout(2500);
  await page.goto('/settings');

  const res = await request.get(`${baseURL}/api/client-log?limit=500`);
  expect(res.ok()).toBeTruthy();
  const rows = (await res.json()) as {
    source: string;
    message: string;
    level: string;
    data?: { page?: number };
  }[];
  expect(rows.some((r) => r.source === 'viewer' && r.message === 'document loaded')).toBe(true);
  expect(rows.some((r) => r.source === 'viewer' && r.message === 'render page' && r.data?.page === 1)).toBe(
    true,
  );
  expect(rows.some((r) => r.level === 'error' && r.message.includes('debug-spec thrown'))).toBe(true);
  expect(rows.some((r) => r.level === 'warn' && r.message.includes('debug-spec warning'))).toBe(true);

  await expect(page.getByTestId('debug-sessions')).toBeVisible();
  await expect(page.getByTestId('debug-log')).toContainText('document loaded');

  // Leave debug off for other specs.
  await page.getByRole('checkbox', { name: /Debug mode/ }).uncheck();
  await expect(page.getByText('Debug mode off')).toBeVisible();
});
