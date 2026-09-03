import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

test('annotate a PDF: selection popover, quick-add, type change, filter, search, general note', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Anno ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByLabel('PDF file').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Add PDF' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);

  // Wait for the text layer, then select a word by double-clicking it.
  const word = page.locator('.textLayer span').first();
  await expect(word).toBeVisible();
  await word.dblclick();
  await page.getByRole('button', { name: 'Annotate' }).click();

  // A Note card appears with the quote and a focused body.
  const card = page.getByTestId('annotation-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Note');
  await expect(card.locator('text=p.1')).toBeVisible();
  const body = page.getByLabel('Annotation text');
  await expect(body).toBeFocused();
  await body.fill('Why a single sample?');
  await body.press('Control+Enter');
  await expect(card).toContainText('Why a single sample?');

  // Change type via the label menu.
  await card.getByRole('button', { name: 'Note' }).click();
  await page.getByRole('option', { name: 'Question' }).click();
  await expect(card.getByRole('button', { name: 'Question' })).toBeVisible();

  // Highlight rendered in the viewer.
  await expect(page.locator('[class*="highlights"] div').first()).toBeVisible();

  // General annotation via +.
  await page.getByRole('button', { name: 'Add a general annotation' }).click();
  await expect(page.getByTestId('annotation-card')).toHaveCount(2);
  await page.getByLabel('Annotation text').fill('Overall: promising but needs a baseline.');
  await page.getByLabel('Annotation text').press('Control+Enter');

  // Filter to Question only, then search.
  await page.getByRole('button', { name: 'Question', exact: true }).first().click();
  await expect(page.getByTestId('annotation-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Question', exact: true }).first().click();
  await page.getByLabel('Search annotations').fill('baseline');
  await expect(page.getByTestId('annotation-card')).toHaveCount(1);
  await expect(page.getByTestId('annotation-card').first()).toContainText('baseline');

  // Collapse and restore the panel.
  await page.getByRole('button', { name: 'Hide annotations' }).click();
  await expect(page.getByRole('button', { name: 'Show annotations' })).toBeVisible();
  await page.getByRole('button', { name: 'Show annotations' }).click();
  await expect(page.getByLabel('Search annotations')).toBeVisible();
});
