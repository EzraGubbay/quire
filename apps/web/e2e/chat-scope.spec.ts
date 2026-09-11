import { expect, test } from '@playwright/test';

// Mock provider (AI_MOCK=1): deterministic answers; MOCK_FAIL_ONCE / MOCK_FAIL_ALWAYS simulate OpenAI 500s.
test('chat: ask reuses the last chat, doc mentions, per-document chats, retry and light-model fallback', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Scope ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/overview$/);
  const slug = page.url().match(/\/p\/([^/]+)\//)?.[1] as string;

  // A Markdown document to talk about.
  await page.goto(`/p/${slug}/documents`);
  await page.getByRole('button', { name: 'Add document' }).click();
  await page.getByRole('tab', { name: 'New Markdown' }).click();
  await page.getByLabel('Title').fill('Routing summary');
  await page.getByRole('button', { name: 'Create document' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  const docUrl = page.url();

  // Ask from the document: no chat is created until a question is sent.
  const askDoc = page.getByTitle('Ask the AI about this document');
  await askDoc.click();
  const dialog = page.getByRole('dialog', { name: 'Ask' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Chat', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await page.goto(`/p/${slug}/chat?doc=${docUrl.split('/').pop()}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Chats about “Routing summary”');
  await expect(page.getByText('No chats about this document yet.')).toBeVisible();

  // First question from the document creates the chat; reopening Ask lands on it.
  await page.goto(docUrl);
  await askDoc.click();
  await dialog.getByLabel('Question').fill('What does this document say about routing?');
  await dialog.getByLabel('Question').press('Enter');
  await expect(dialog.getByTestId('chat-message').nth(1)).toContainText('Mock answer', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await askDoc.click();
  await expect(dialog.getByTestId('chat-message').nth(1)).toContainText('Mock answer', { timeout: 20_000 });
  await expect(dialog.getByLabel('Chat', { exact: true })).toContainText('What does this document say');
  // New chat from the panel switches to an empty one; the switcher lists both.
  await dialog.getByRole('button', { name: 'New chat' }).click();
  await expect(dialog.getByTestId('chat-message')).toHaveCount(0);
  await expect(dialog.getByLabel('Chat', { exact: true }).locator('option')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // Per-row downloads: the Markdown document comes back as a .md attachment.
  const dl = await page.request.get(
    `/api/projects/${slug}/documents/${docUrl.split('/').pop()}/file?download=1`,
  );
  expect(dl.headers()['content-disposition']).toContain('attachment');
  expect(dl.headers()['content-disposition']).toContain('.md');
  expect(await dl.text()).toContain('# Routing summary');

  // Documents page: the row's chat button opens that document's chats.
  await page.goto(`/p/${slug}/documents`);
  // The page opens in Active Reading; the new document is unread, so switch to All documents.
  await page.getByRole('button', { name: /^All documents/ }).click();
  await page.getByRole('link', { name: 'Chats about Routing summary' }).click();
  await page.waitForURL(/\/chat\?doc=/);
  await expect(page.locator('[class*="itemTitle"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByText('about:')).toContainText('Routing summary');

  // Main chat: doc. opens the document picker at the caret; the pick is written as [[Title]].
  await page.goto(`/p/${slug}/chat`);
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  const q = page.getByLabel('Question');
  await q.click();
  await page.keyboard.type('Compare doc.Rout');
  await expect(page.getByRole('listbox', { name: 'Documents' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(q).toHaveValue('Compare [[Routing summary]]');
  await page.keyboard.type(' with my notes');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-message').nth(1)).toContainText('Mock answer', { timeout: 20_000 });

  // A provider 500 that keeps failing shows a plain explanation and a Retry button.
  await q.fill('MOCK_FAIL_ALWAYS what now');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-error')).toContainText('OpenAI had a server error', {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('chat-error')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('chat-message')).toHaveCount(4);
  // A 500 that passes on the second attempt is answered by the light model without the user noticing.
  await q.fill(`MOCK_FAIL_ONCE tell me more ${Date.now()}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-message').nth(5)).toContainText('Mock answer', { timeout: 20_000 });
  await expect(page.getByTestId('chat-message').nth(5)).toContainText('light model');
});
