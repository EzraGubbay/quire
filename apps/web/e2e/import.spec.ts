import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

test('import a paper from a direct PDF link', async ({ page, baseURL }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Import ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: 'Documents' }).click();

  // Upload once so the app itself can serve a PDF URL, then import from that URL.
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByLabel('PDF file').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Add PDF' }).click();
  await page.waitForURL(/\/documents\/([0-9a-f-]{36})$/);
  const slug = page.url().match(/\/p\/([^/]+)\//)?.[1];
  const docId = page.url().split('/').pop();
  const pdfUrl = `${baseURL}/api/projects/${slug}/documents/${docId}/file`;

  await page.getByRole('link', { name: 'Documents' }).first().click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByRole('tab', { name: 'arXiv / DOI / link' }).click();
  await page.getByLabel('Reference').fill(pdfUrl);
  await expect(page.getByText('Direct link: the PDF is downloaded and read')).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  expect(page.url().split('/').pop()).not.toBe(docId);
  await expect(page.locator('[class*="barTitle"]')).toContainText('Quire fixture');

  // The detector explains an unrecognised reference and disables Add.
  await page.getByRole('link', { name: 'Documents' }).first().click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByRole('tab', { name: 'arXiv / DOI / link' }).click();
  await page.getByLabel('Reference').fill('not a reference');
  await expect(page.getByText('Not recognised yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
});

test('import from arXiv (network)', async ({ page }) => {
  test.skip(!process.env.E2E_NETWORK, 'set E2E_NETWORK=1 to hit arxiv.org');
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`arXiv ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByRole('tab', { name: 'arXiv / DOI / link' }).click();
  await page.getByLabel('Reference').fill('1706.03762');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  await expect(page.locator('[class*="barTitle"]')).toContainText('Attention Is All You Need');
});
