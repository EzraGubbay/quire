import { expect, test } from '@playwright/test';

test('sources: add with snapshot, filter by type, edit, delete', async ({ page, baseURL }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Sources ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();

  // Add with a URL the app itself serves; title is taken from the page.
  await page.getByRole('button', { name: 'Add source' }).click();
  await page.getByLabel('URL').fill(`${baseURL}/settings`);
  await page.getByLabel('Tags').fill('tooling, quire');
  await page.getByLabel('Description').fill('The settings page, as a test source.');
  await page.getByRole('button', { name: 'Add source', exact: true }).last().click();
  const card = page.getByTestId('source-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Quire');
  await expect(card).toContainText('snapshot');
  await expect(card).toContainText('#tooling');

  // A book without URL.
  await page.getByRole('button', { name: 'Add source' }).click();
  await page.getByLabel('Title').fill('Pattern Recognition and Machine Learning');
  await page.getByLabel('Type').selectOption('book');
  await page.getByRole('button', { name: 'Add source', exact: true }).last().click();
  await expect(page.getByTestId('source-card')).toHaveCount(2);

  // Filter by type.
  await page.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.getByTestId('source-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Any type' }).click();

  // Edit the book, then delete it.
  await page.getByRole('button', { name: 'Edit Pattern Recognition and Machine Learning' }).click();
  await page.getByLabel('Description').fill('Bishop 2006.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Bishop 2006.')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete Pattern Recognition and Machine Learning' }).click();
  await expect(page.getByTestId('source-card')).toHaveCount(1);
});
