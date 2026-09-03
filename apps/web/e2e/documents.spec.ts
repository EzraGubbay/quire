import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

test.describe('documents', () => {
  test('upload a PDF, see its text, change status, create a folder and a Markdown doc', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New project' }).click();
    const name = `Docs project ${Date.now()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('link', { name: 'Documents' }).click();
    await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();

    // Upload
    await page.getByRole('button', { name: 'Add document' }).click();
    await page.getByLabel('PDF file').setInputFiles(fixture);
    await page.getByRole('button', { name: 'Add PDF' }).click();
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: /Quire fixture/ })).toBeVisible();
    await expect(page.locator('#page-2')).toContainText('Second page of the fixture document');

    // Reading status
    await page.getByRole('button', { name: 'reading', exact: true }).click();
    await expect(page.getByRole('button', { name: 'reading', exact: true })).toHaveAttribute(
      'data-active',
      'true',
    );

    // Back to explorer: the row shows the status
    await page.getByRole('link', { name: 'Documents' }).first().click();
    await expect(page.locator('a', { hasText: 'sparse attention with learned routing' })).toContainText(
      'reading',
    );

    // Folder
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('Name').fill('Surveys');
    await page.getByRole('button', { name: 'Create folder' }).click();
    await expect(page.getByRole('button', { name: /Surveys/ })).toBeVisible();

    // Markdown document
    await page.getByRole('button', { name: 'Add document' }).click();
    await page.getByRole('tab', { name: 'New Markdown' }).click();
    await page.getByLabel('Title').fill('Reading notes');
    await page.getByRole('button', { name: 'Create document' }).click();
    await expect(page.getByRole('heading', { name: 'Reading notes' })).toBeVisible();
  });
});
