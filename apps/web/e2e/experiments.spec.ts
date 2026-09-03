import { expect, test } from '@playwright/test';

test('experiments: runs reported through the API show up with metrics, logs, and observations', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Exp ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/p\/([^/]+)\/overview$/);
  const slug = page.url().match(/\/p\/([^/]+)\//)?.[1] as string;

  // What the Python client does.
  const created = await request.post(`${baseURL}/api/projects/${slug}/runs`, {
    data: { experiment: 'routed-32k', name: 'lambda-0.1', params: { lambda: 0.1, seq: 32768 } },
  });
  expect(created.status()).toBe(201);
  const { id: runId, experimentId } = await created.json();
  for (let step = 0; step < 5; step++) {
    const r = await request.post(`${baseURL}/api/projects/${slug}/runs/${runId}/metrics`, {
      data: { metrics: { loss: 1 / (step + 1), ppl: 20 - step }, step },
    });
    expect(r.ok()).toBeTruthy();
  }
  await request.post(`${baseURL}/api/projects/${slug}/runs/${runId}/logs`, {
    data: { lines: [{ message: 'epoch 1 done' }, { level: 'warn', message: 'lr clipped' }] },
  });
  const fin = await request.post(`${baseURL}/api/projects/${slug}/runs/${runId}/finish`, {
    data: { status: 'done', metrics: { final_ppl: 12.4 } },
  });
  expect(fin.ok()).toBeTruthy();
  const bad = await request.post(`${baseURL}/api/projects/${slug}/runs/${runId}/metrics`, {
    data: { nope: 1 },
  });
  expect(bad.status()).toBe(400);

  // UI: experiments list → experiment → run.
  await page.getByRole('link', { name: 'Experiments', exact: true }).click();
  await page.getByRole('link', { name: 'routed-32k' }).click();
  await page.waitForURL(new RegExp(`/experiments/${experimentId}$`));
  await expect(page.getByRole('cell', { name: 'done' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'final_ppl' })).toBeVisible();
  await page.getByRole('link', { name: 'lambda-0.1' }).click();
  await page.waitForURL(new RegExp(`/runs/${runId}$`));
  await expect(page.getByRole('img', { name: 'loss over steps' })).toBeVisible();
  await expect(page.getByText('lr clipped')).toBeVisible();
  await expect(page.locator('dt', { hasText: 'final_ppl' })).toBeVisible();

  // Observation with math.
  await page
    .getByLabel('New observation')
    .fill('Loss flattens after step 3; $\\lambda H(q)$ looks too small.');
  await page.getByRole('button', { name: 'Add observation' }).click();
  await expect(page.getByText('Loss flattens after step 3')).toBeVisible();

  // Manual run from the UI.
  await page.getByRole('link', { name: 'routed-32k' }).click();
  await page.getByRole('button', { name: 'New run' }).click();
  await page.getByLabel('Name').fill('manual-baseline');
  await page.getByLabel('Params').fill('lambda=0\nseq=32768');
  await page.getByRole('button', { name: 'Create run' }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'manual-baseline' })).toBeVisible();
  await expect(page.getByText('lambda')).toBeVisible();
});
