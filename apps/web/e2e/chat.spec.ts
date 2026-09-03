import { expect, test } from '@playwright/test';

// Runs against the mock provider (AI_MOCK=1 on the server): deterministic answers and embeddings.
test('chat: ask a question, get a cited answer from indexed notes; ask-about-document; spend recorded', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Chat ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);

  // A note gets indexed on save.
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByLabel('Title').fill('Routing posterior');
  await page.getByRole('button', { name: 'Create note' }).click();
  await page.waitForURL(/edit=1$/);
  await page.locator('.cm-content').click();
  await page.keyboard.type(
    'The routing posterior matches the attention distribution when the bound is tight.',
  );
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForURL(/\/notes\/routing-posterior$/);

  // Chat tab: new thread, ask, streamed answer with a citation chip.
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await page.getByLabel('Question').fill('When does the routing posterior match attention?');
  await page.keyboard.press('Enter');
  const answer = page.getByTestId('chat-message').nth(1);
  await expect(answer).toContainText('Mock answer', { timeout: 20_000 });
  await expect(answer.getByRole('link', { name: /\[1\]/ })).toBeVisible();
  await expect(answer).toContainText('Routing posterior');
  // Thread renamed from the first question.
  await expect(page.locator('[class*="itemTitle"]').first()).toContainText('When does the routing posterior');

  // Ask slide-over from the app bar.
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Question').fill('Summarise the project');
  await dialog.getByLabel('Question').press('Enter');
  await expect(dialog.getByTestId('chat-message').nth(1)).toContainText('Mock answer', { timeout: 20_000 });
  await page.keyboard.press('Escape');

  // Spend shows up in settings.
  await page.goto('/settings');
  await expect(page.getByTestId('spend')).toContainText('answer');
  await expect(page.getByTestId('spend')).toContainText('embed');
});
