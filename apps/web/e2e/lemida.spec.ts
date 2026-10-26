import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

const basePdf = readFileSync(fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url)));
/** Distinct-but-valid PDF bytes (trailing bytes after %%EOF are ignored) so each import hashes differently. */
const variant = (tag: string) => Buffer.concat([basePdf, Buffer.from(`\n% quire-e2e ${tag}\n`)]);

const hydrated = (page: Page) => page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });

async function createCourse(page: Page, name: string): Promise<string> {
  await page.goto('/courses');
  await page.getByRole('button', { name: 'New course' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create course' }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+\/overview$/);
  const slug = page.url().match(/\/c\/([^/]+)\//)?.[1];
  if (!slug) throw new Error('no course slug');
  return slug;
}

async function importFile(
  request: APIRequestContext,
  slug: string,
  fields: { fileName: string; buffer: Buffer; sectionTitle?: string; moduleType?: string },
) {
  const res = await request.post(`/api/projects/${slug}/lemida/import`, {
    multipart: {
      file: { name: fields.fileName, mimeType: 'application/pdf', buffer: fields.buffer },
      fileName: fields.fileName,
      ...(fields.sectionTitle ? { sectionTitle: fields.sectionTitle } : {}),
      ...(fields.moduleType ? { moduleType: fields.moduleType } : {}),
    },
  });
  expect(res.ok(), `import ${fields.fileName}: ${res.status()}`).toBeTruthy();
  return res.json();
}

test('lemida import: classify + place, dedupe, and resolve a review item', async ({ page, request }) => {
  const name = `E2E lemida ${Date.now()}`;
  const slug = await createCourse(page, name);

  await test.step('a Moodle-section lecture becomes a lecture session', async () => {
    const r = await importFile(request, slug, {
      fileName: 'Lecture 1 - Intro.pdf',
      buffer: variant('lec'),
      sectionTitle: 'הרצאות',
      moduleType: 'mod_resource',
    });
    expect(r.detectedKind).toBe('lecture');
    expect(r.status).toBe('imported');
    await page.goto(`/c/${slug}/lectures`);
    await expect(page.getByText('Intro')).toBeVisible();
  });

  await test.step('a Moodle assignment activity becomes homework', async () => {
    const r = await importFile(request, slug, {
      fileName: 'תרגיל בית 1.pdf',
      buffer: variant('hw'),
      moduleType: 'mod_assign',
    });
    expect(r.detectedKind).toBe('homework');
    expect(r.status).toBe('imported');
    await page.goto(`/c/${slug}/homework`);
    await expect(page.getByText('תרגיל בית 1')).toBeVisible();
  });

  await test.step('the same bytes are skipped as a duplicate', async () => {
    const r = await importFile(request, slug, {
      fileName: 'Lecture 1 - Intro (copy).pdf',
      buffer: variant('lec'),
      sectionTitle: 'הרצאות',
      moduleType: 'mod_resource',
    });
    expect(r.duplicate).toBe(true);
  });

  await test.step('an unrecognised file lands in the review queue and can be re-filed', async () => {
    const r = await importFile(request, slug, { fileName: 'misc-notes.pdf', buffer: variant('unk') });
    expect(r.detectedKind).toBe('unknown');
    expect(r.status).toBe('needs_review');

    await page.goto('/courses/lemida');
    await hydrated(page);
    const review = page.getByTestId('lemida-review');
    await expect(review.getByText('misc-notes.pdf')).toBeVisible();
    await page.getByRole('button', { name: 'Recitation', exact: true }).first().click();
    await expect(page.getByTestId('lemida-review').getByText('misc-notes.pdf')).toHaveCount(0);
    // It now shows up as a recitation session (empty title ⇒ "Recitation 1").
    await page.goto(`/c/${slug}/recitations`);
    await expect(page.getByText('Recitation 1')).toBeVisible();
  });
});

test('lemida panel: map a course to its Lemida page', async ({ page }) => {
  const name = `E2E map ${Date.now()}`;
  await createCourse(page, name);

  await page.goto('/courses/lemida');
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'Lemida sync' })).toBeVisible();
  await page.getByLabel('Course', { exact: true }).selectOption({ label: name });
  await page
    .getByPlaceholder('https://lemida.biu.ac.il/course/view.php?id=…')
    .fill('https://lemida.biu.ac.il/course/view.php?id=4242');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();
});
