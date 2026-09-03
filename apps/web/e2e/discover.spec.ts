import { expect, test } from '@playwright/test';

test('discover: search, ranked candidates, add one as a paper record', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Discover ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);
  await page.getByRole('link', { name: 'Documents', exact: true }).click();
  await page.getByRole('link', { name: 'Discover' }).click();
  await page.waitForURL(/\/discover$/);
  await page.getByLabel('What are you looking for?').fill('sparse attention routing');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('candidate')).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByText('ranked by the light model')).toBeVisible();
  await page
    .getByTestId('candidate')
    .first()
    .getByRole('button', { name: /Add paper/ })
    .click();
  await expect(page.getByTestId('candidate').first().getByRole('link', { name: 'Added · open' })).toBeVisible(
    { timeout: 20_000 },
  );
  await page.getByTestId('candidate').first().getByRole('link', { name: 'Added · open' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(page.locator('[class*="barTitle"]')).toContainText('Attention Is All You Need');
  // Searching again marks it as already in the project.
  await page.goto(page.url().replace(/\/documents\/.*$/, '/discover'));
  await page.getByLabel('What are you looking for?').fill('sparse attention routing');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('candidate').first()).toContainText('Already in this project', {
    timeout: 20_000,
  });
});
