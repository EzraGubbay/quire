import { expect, test } from '@playwright/test';

test('mind map: build a forest, collapse, attach a node note, persist, and delete a subtree', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Mindmap ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);

  await page.getByRole('link', { name: 'Mind map', exact: true }).click();
  await page.waitForURL(/\/mindmap$/);

  // Empty state → add the first root.
  await expect(page.getByText('Your mind map is empty.')).toBeVisible();
  await page.getByRole('button', { name: 'Add a root node' }).click();
  const nodes = page.getByTestId('mindmap-node');
  await nodes.getByLabel('Node label').fill('Decision theory');
  await nodes.getByLabel('Node label').press('Enter');
  await expect(nodes.getByText('Decision theory')).toBeVisible();

  // The root is selected → add a child from its toolbar.
  await page.getByRole('button', { name: 'Add child' }).click();
  await page.getByTestId('mindmap-node').getByLabel('Node label').fill('Utility');
  await page.getByTestId('mindmap-node').getByLabel('Node label').press('Enter');
  await expect(nodes).toHaveCount(2);

  // Collapse the root → the child is hidden; expand → it is back.
  await page.getByRole('button', { name: 'Collapse' }).click();
  await expect(nodes).toHaveCount(1);
  await page.getByRole('button', { name: /Expand/ }).click();
  await expect(nodes).toHaveCount(2);

  // Open the child's note, write in it (wiki links are off), and let it autosave.
  await page.getByRole('button', { name: /Utility/ }).click();
  const panel = page.getByTestId('mindmap-note-panel');
  await expect(panel).toBeVisible();
  await panel.locator('.cm-content').click();
  await page.keyboard.type('Expected utility = sum of p(outcome) * u(outcome).');
  // Wait for the autosave to actually land (status pill → saved), not the substring inside "Unsaved".
  await expect(panel.locator('[data-status="saved"]')).toBeVisible({ timeout: 5000 });
  const url = page.url();

  // Persistence: a COLD fresh browser context (no router cache, no service worker yet) reads straight from the
  // server, so the forest and the node note must come back from the database exactly as built.
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.setViewportSize({ width: 1400, height: 900 });
  await p2.goto(url);
  await expect(p2.getByTestId('mindmap-node')).toHaveCount(2);
  const utility = p2.getByTestId('mindmap-node').filter({ hasText: 'Utility' });
  await expect(utility.getByLabel('has note')).toBeVisible();
  await utility.getByRole('button', { name: /Utility/ }).click();
  const reopened = p2.getByTestId('mindmap-note-panel');
  await expect(reopened).toBeVisible();
  await expect(reopened.locator('.cm-content')).toContainText('Expected utility', { timeout: 10000 });

  // Delete the root → its whole subtree goes with it (DB cascade), back to the empty state.
  await p2.getByRole('button', { name: /Decision theory/ }).click();
  await p2
    .getByTestId('mindmap-node')
    .filter({ hasText: 'Decision theory' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await p2.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(p2.getByText('Your mind map is empty.')).toBeVisible();
  await fresh.close();
});
