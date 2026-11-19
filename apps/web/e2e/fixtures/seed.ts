import { fileURLToPath } from 'node:url';
import { type Browser, expect, type Page } from '@playwright/test';

/** PDFs the other e2e specs already ship; reused so the mobile journey has real bytes to stream. */
export const samplePdf = fileURLToPath(new URL('./sample.pdf', import.meta.url));
export const tenPagesPdf = fileURLToPath(new URL('./ten-pages.pdf', import.meta.url));

export interface SeededCourse {
  /** URL slug — the usual way the mobile API addresses a course. */
  slug: string;
  /** The course's display name, used to find it in `GET /courses`. */
  name: string;
}

/**
 * Create one course that exercises the whole mobile read surface: a lecture deck (PDF), a recitation
 * deck, and a note. It drives the same UI the other e2e specs use (see `courses.spec.ts` /
 * `chat.spec.ts`) rather than a JSON API, because course / session / note creation is UI-only today.
 *
 * It returns just the course identity. The mobile journey discovers file ids and note ids from the
 * mobile endpoints themselves, so this helper stays decoupled from the shapes those endpoints will
 * return (owned by #35 / #37).
 */
export async function seedCourse(browser: Browser): Promise<SeededCourse> {
  const page = await browser.newPage();
  try {
    const name = `Mobile API ${Date.now()}`;
    await page.goto('/courses');
    await page.getByRole('button', { name: 'New course' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Course code').fill('89-999');
    await page.getByLabel('Semester').fill('2027 A');
    await page.getByRole('button', { name: 'Create course' }).click();
    await expect(page).toHaveURL(/\/c\/[^/]+\/overview$/);
    const slug = page.url().match(/\/c\/([^/]+)\//)?.[1];
    if (!slug) throw new Error('seedCourse: could not read the new course slug');

    // A lecture deck and a recitation deck, each a single dropped PDF that redirects to its new session.
    await uploadDeck(page, `/c/${slug}/lectures`, samplePdf);
    await uploadDeck(page, `/c/${slug}/recitations`, tenPagesPdf);

    // A standalone note, so the notes endpoints have something to list and read.
    await page.goto(`/c/${slug}/notes`);
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByLabel('Title').fill('Mobile seed note');
    await page.getByRole('button', { name: 'Create note' }).click();
    await page.waitForURL(/edit=1$/);
    await page.locator('.cm-content').click();
    await page.keyboard.type('Seeded note body for the mobile API journey.');
    await page.getByRole('button', { name: 'Done' }).click();

    return { slug, name };
  } finally {
    await page.close();
  }
}

/** Upload one deck through the list page's file chooser and wait for the redirect to its session. */
async function uploadDeck(page: Page, listUrl: string, file: string): Promise<void> {
  await page.goto(listUrl);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Add decks' }).click(),
  ]);
  await chooser.setFiles(file);
  const escaped = listUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.waitForURL(new RegExp(`${escaped}/[^/]+$`), { timeout: 30_000 });
}
