import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const pdf = readFileSync(fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url)));
const LONG_TITLE =
  'Integration of Planning with Recognition for Responsive Interaction Using Classical Planners';

// iPad portrait: the narrowest tablet layout. Real iPads report several touch points; Playwright's touch
// emulation reports one, which the client would classify as desktop.
test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true, deviceScaleFactor: 2 });

test('tablet reader: the layout follows the viewport; the annotations panel never leaves the screen', async ({
  page,
  context,
  baseURL,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }));
  await context.addCookies([
    { name: 'quire.platform', value: 'tablet', url: baseURL ?? 'http://localhost:3000' },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(`Tablet ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add document' }).click();
  await page
    .getByLabel('PDF file')
    .setInputFiles({ name: `${LONG_TITLE}.pdf`, mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('button', { name: 'Add PDF' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(page.locator('.textLayer span').first()).toBeVisible();

  const noOverflow = async () => {
    const m = await page.evaluate(() => {
      const main = document.querySelector('.quire-main') as HTMLElement;
      const aside = document.querySelector('aside[aria-label="Annotations"]') as HTMLElement;
      const over: string[] = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.right > window.innerWidth + 1)
          over.push(
            `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} ${Math.round(b.left)}–${Math.round(b.right)}`,
          );
      }
      return {
        width: window.innerWidth,
        mainScroll: main.scrollWidth,
        mainClient: main.clientWidth,
        asideRight: Math.round(aside.getBoundingClientRect().right),
        asideWidth: Math.round(aside.getBoundingClientRect().width),
        over: over.slice(0, 12),
      };
    });
    expect(m.over, 'elements past the right edge of the viewport').toEqual([]);
    expect(m.mainScroll).toBe(m.mainClient);
    expect(m.asideRight).toBeLessThanOrEqual(m.width);
    return m;
  };

  // Tablets start with the panel collapsed to a rail; the long title truncates instead of widening the bar.
  const collapsed = await noOverflow();
  expect(collapsed.asideWidth).toBe(44);
  await expect(page.getByRole('button', { name: 'Show annotations' })).toBeVisible();
  const title = page.locator('[class*="barTitle"]');
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // Expanded, the panel takes its full width from the viewer, still inside the viewport. The width animates;
  // meanwhile the panel clips its contents rather than letting them spill past the edge.
  await page.getByRole('button', { name: 'Show annotations' }).click();
  const aside = page.getByRole('complementary', { name: 'Annotations' });
  await expect(aside).toHaveCSS('width', '360px');
  const expanded = await noOverflow();
  expect(expanded.asideWidth).toBe(360);
  await expect(page.getByLabel('Search annotations')).toBeVisible();

  // Below the laptop breakpoint the open panel is a slide-over: the viewer keeps its width underneath.
  const viewerWidth = await page
    .getByTestId('pdf-viewer')
    .evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(viewerWidth).toBe(834);
});
