import { expect, test } from '@playwright/test';

test('notes: create, edit with a wiki link, follow it to create the target, see backlinks, promote', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Notes ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);
  await page.getByRole('link', { name: 'Notes', exact: true }).click();

  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByLabel('Title').fill('Routing entropy');
  await page.getByRole('button', { name: 'Create note' }).click();
  await page.waitForURL(/\/notes\/routing-entropy\?edit=1$/);
  await page.locator('.cm-content').click();
  await page.keyboard.type('Entropy of the router posterior; relates to [[ELBO tightness]] and $H(q)$.');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForURL(/\/notes\/routing-entropy$/);
  await expect(page.locator('[class*="markdown-view"] mjx-container').first()).toBeVisible();
  await expect(page.getByText('Unresolved links')).toBeVisible();

  // Following the dangling link creates the note and opens it in edit mode.
  await page.locator('a[data-wikilink="ELBO tightness"]').click();
  await page.waitForURL(/\/notes\/elbo-tightness\?edit=1$/);
  await page.locator('.cm-content').click();
  await page.keyboard.type('The bound is tight when the variational posterior equals the true posterior.');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForURL(/\/notes\/elbo-tightness$/);
  await expect(page.getByRole('link', { name: 'Routing entropy' }).first()).toBeVisible();

  // Graph shows both notes and their link.
  await page.getByRole('link', { name: 'Graph' }).click();
  await page.waitForURL(/\/notes\/graph$/);
  await expect(page.getByText(/2 nodes · 1 links/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Routing entropy/ })).toBeVisible();
  await page.goBack();

  // Search in the rail.
  await page.getByLabel('Search notes').fill('routing');
  await expect(page.locator('[class*="itemTitle"]')).toHaveCount(1);

  // Promote to a document.
  await page.getByRole('button', { name: 'Promote to document' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(page.locator('[class*="barTitle"]')).toContainText('ELBO tightness');
});
