import { expect, test } from '@playwright/test';

/** Settings → Mobile devices: generate code → exchange via API → device listed → revoke → 401. Runs under AUTH_MODE=none. */
test('pair a device from Settings, see it listed, revoke it, and its token stops working', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Mobile devices' })).toBeVisible();

  await page.getByRole('button', { name: 'Pair a device' }).click();
  await expect(page.getByTestId('pairing-code')).toBeVisible();
  const code = (await page.getByTestId('pairing-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{8}$/);
  await expect(page.getByTestId('pairing-qr').locator('svg')).toBeVisible();
  await expect(page.getByTestId('pairing-expiry')).toBeVisible();

  const device = `e2e-phone-${Date.now()}`;
  const paired = await request.post('/api/mobile/v1/auth/pair', { data: { code, deviceName: device } });
  expect(paired.ok()).toBeTruthy();
  const { token } = (await paired.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  expect((await request.get('/api/mobile/v1/me', { headers: auth })).status()).toBe(200);

  await page.reload();
  const row = page.getByRole('row', { name: new RegExp(device) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('row', { name: new RegExp(device) })).toHaveCount(0);

  expect((await request.get('/api/mobile/v1/me', { headers: auth })).status()).toBe(401);
});
