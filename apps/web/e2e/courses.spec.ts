import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const samplePdf = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url));

async function createCourse(page: Page, name: string) {
  await page.goto('/courses');
  await page.getByRole('button', { name: 'New course' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Course code').fill('89-123');
  await page.getByLabel('Semester').fill('2027 A');
  await page.getByLabel('Links').fill('Moodle | https://example.edu/moodle');
  await page.getByRole('button', { name: 'Create course' }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+\/overview$/);
  const slug = page.url().match(/\/c\/([^/]+)\//)?.[1];
  if (!slug) throw new Error('no course slug');
  return slug;
}

/** React is live (clicks before that are dropped during hydration, noticeably on a dev server). */
const hydrated = (page: Page) => page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });

test('two sides: / remembers the last side, the switch moves between them', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/research$/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await hydrated(page);
  await page.getByRole('radio', { name: 'Courses' }).click();
  await expect(page).toHaveURL(/\/courses$/);
  await expect(page.getByRole('heading', { name: 'Courses' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/courses$/);
  await hydrated(page);
  await page.getByRole('radio', { name: 'Research' }).click();
  await expect(page).toHaveURL(/\/research$/);
});

test('course lifecycle: create, archive with undo, lectures, notes, synthesis, homework, tests', async ({
  page,
}) => {
  const name = `E2E course ${Date.now()}`;
  const slug = await createCourse(page, name);

  await test.step('overview and tabs', async () => {
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('89-123 · 2027 A')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Moodle' })).toBeVisible();
    for (const tab of ['Lectures', 'Recitations', 'Homework', 'Tests', 'Documents', 'Notes', 'Chat']) {
      await expect(page.getByLabel('Sections').getByRole('link', { name: tab, exact: true })).toBeVisible();
    }
    // Research-only pages are not found for a course (streamed, so the status is 200 and the body says so);
    // the /p prefix redirects to /c.
    await page.goto(`/c/${slug}/experiments`);
    await expect(page.getByText(/could not be found/i)).toBeVisible();
    await page.goto(`/p/${slug}/overview`);
    await expect(page).toHaveURL(new RegExp(`/c/${slug}/overview$`));
  });

  await test.step('archive and unarchive from the Courses home', async () => {
    await page.goto('/courses');
    await expect(page.getByRole('link', { name })).toBeVisible();
    await page.getByRole('button', { name: `Archive ${name}` }).click();
    const toast = page.getByTestId('toast');
    await expect(toast).toContainText(`Archived ${name}`);
    await expect(page.getByRole('link', { name })).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('link', { name })).toBeVisible();
    await page.getByRole('button', { name: `Archive ${name}` }).click();
    await expect(page.getByRole('link', { name })).toHaveCount(0);
    await page
      .getByTestId('archived-section')
      .getByRole('button', { name: /Archived/ })
      .click();
    await expect(page.getByRole('link', { name })).toBeVisible();
    await page.getByRole('button', { name: `Unarchive ${name}` }).click();
    await page
      .getByTestId('archived-section')
      .getByRole('button', { name: /Archived/ })
      .click();
    await expect(page.getByRole('link', { name })).toBeVisible();
  });

  await test.step('note folders: Raw and Synthesized exist', async () => {
    await page.goto(`/c/${slug}/notes`);
    const tree = page.getByTestId('notes-folders');
    await expect(tree.getByRole('button', { name: /Raw/ })).toBeVisible();
    await expect(tree.getByRole('button', { name: /Synthesized/ })).toBeVisible();
  });

  await test.step('drop a deck on Lectures and take a note beside it', async () => {
    await page.goto(`/c/${slug}/lectures`);
    await expect(page.getByRole('heading', { name: 'Lectures', exact: true })).toBeVisible();
    // Through the button's file chooser (rather than setInputFiles on the hidden input) so the page is hydrated
    // before the change event fires. A single dropped file redirects to its new lecture.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Add decks' }).click(),
    ]);
    await chooser.setFiles(samplePdf);
    await Promise.race([
      page.waitForURL(new RegExp(`/c/${slug}/lectures/[^/]+$`), { timeout: 30_000 }),
      page
        .getByTestId('drop-error')
        .waitFor({ timeout: 30_000 })
        .then(async () => {
          throw new Error(`drop failed: ${await page.getByTestId('drop-error').innerText()}`);
        }),
    ]);
    await expect(page.getByTestId('session-page')).toBeVisible();
    await expect(page.getByTestId('pdf-viewer')).toBeVisible();
    const pane = page.getByTestId('session-note-pane');
    await expect(pane).toBeVisible();
    const editor = pane.locator('.cm-content');
    await editor.click();
    await page.keyboard.type('Race condition: two threads touch shared state without a lock.');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Alt+t');
    await page.keyboard.type('Associative reductions parallelise.');
    await expect(editor).toContainText('**Theorem:** Associative reductions parallelise.');
    await pane.getByRole('button', { name: /Cite slide/ }).click();
    await expect(editor).toContainText('#1]]');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('Why does ==associativity== matter?');
    await expect(editor).toContainText('**Question:** Why does ==associativity== matter?');
    // Live formatting decorates the raw source in place: the bold label reads bold, ==highlight== tints its content.
    await expect(pane.locator('.cm-md-strong').first()).toHaveText('Theorem:');
    await expect(pane.locator('.cm-md-mark')).toHaveText('associativity');
    await expect(pane.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 });
    // Ask from the deck sends the note along with the slides; the mock answer says so and cites the note.
    await page.getByTitle('Ask the AI about this document').click();
    const ask = page.getByRole('dialog', { name: 'Ask' });
    await expect(ask.getByTestId('ask-note-context')).toContainText('lecture note');
    await ask.getByLabel('Question').fill('What is a race condition?');
    await ask.getByLabel('Question').press('Enter');
    await expect(ask.getByTestId('chat-message').nth(1)).toContainText('was in context', { timeout: 20_000 });
    await expect(ask.locator('a[href*="/notes/"]')).toContainText('Lecture 1');
    await page.keyboard.press('Escape');
    // The deck shows up in Documents and the note under Raw.
    await page.goto(`/c/${slug}/notes`);
    await page.getByTestId('notes-folders').getByRole('button', { name: /Raw/ }).click();
    await expect(page.getByRole('link', { name: /^Lecture 1/ })).toBeVisible();
  });

  await test.step('edit a lecture’s title and date', async () => {
    await page.goto(`/c/${slug}/lectures`);
    const list = page.getByTestId('lectures-list');
    await list.getByRole('button', { name: /^Edit/ }).first().click();
    const dlg = page.locator('dialog[open]');
    await dlg.getByLabel('Title').fill('Edited topic');
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(list.getByText('Edited topic')).toBeVisible();
    // Leave the page on the Notes/Raw view the next step expects.
    await page.goto(`/c/${slug}/notes`);
    await page.getByTestId('notes-folders').getByRole('button', { name: /Raw/ }).click();
  });

  await test.step('synthesize the raw note (AI_MOCK)', async () => {
    await page.getByRole('link', { name: /^Lecture 1/ }).click();
    await expect(page.locator('strong.term-label[data-kind="question"]')).toBeVisible();
    await expect(page.locator('mark', { hasText: 'associativity' })).toBeVisible();
    await page.getByRole('button', { name: 'Synthesize', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('synthesis-estimate')).toContainText('$', { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Synthesize', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${slug}/notes/`));
    // Generating state resolves to the mock body; the page polls itself.
    await expect(page.locator('strong.term-label[data-kind="definition"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('synth-lines')).toContainText('Synthesized from');
    await expect(page.locator('.callout, blockquote').first()).toBeVisible();
    await page
      .getByTestId('notes-folders')
      .getByRole('button', { name: /Synthesized/ })
      .click();
    await expect(page.locator('[data-status="ready"]').first()).toBeVisible();
  });

  await test.step('homework: assignment, checklist, grade', async () => {
    await page.goto(`/c/${slug}/homework`);
    await page.getByRole('button', { name: 'Assignment' }).click();
    await page.getByLabel('Title').fill('OpenMP reductions');
    await page.getByLabel('Questions').fill('Q1\nQ2');
    await page.getByRole('button', { name: 'Create assignment' }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${slug}/homework/[^/]+$`));
    const questions = page.getByTestId('assignment-question');
    await expect(questions).toHaveCount(2);
    const first = questions.first().getByRole('button', { name: /To do|Working|Done|Stuck/ });
    await first.click();
    await expect(first).toHaveText('Working');
    await first.click();
    await expect(first).toHaveText('Done');
    await expect(page.getByText('1/2 done')).toBeVisible();
    await page.getByLabel('Score').fill('88');
    await page.getByLabel('Score').blur();
    await expect(page.getByLabel('Status')).toHaveValue('graded', { timeout: 10_000 });
    await page.goto(`/c/${slug}/homework`);
    await expect(page.getByText('Graded')).toBeVisible();
    await page.goto(`/c/${slug}/overview`);
    await expect(page.getByRole('heading', { name: 'Due next' })).toBeVisible();
  });

  await test.step('tests: weekly test, mark, re-read list (AI_MOCK)', async () => {
    await page.goto(`/c/${slug}/tests`);
    await expect(page.getByTestId('practice-count')).toContainText('0/5');
    await expect(page.getByRole('button', { name: 'Tri-weekly test' })).toBeDisabled();
    await page.getByRole('button', { name: 'Weekly test', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('test-estimate')).toContainText('about $', { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Generate' }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${slug}/tests/[^/]+$`));
    const questions = page.getByTestId('test-question');
    await expect(questions).toHaveCount(2, { timeout: 30_000 });
    await questions.first().getByRole('button', { name: 'Reveal answer' }).click();
    await expect(page.getByTestId('model-answer')).toBeVisible();
    await questions.nth(0).getByRole('radio', { name: 'Fail' }).click();
    await questions.nth(1).getByRole('radio', { name: 'Pass' }).click();
    await expect(questions.nth(1)).toHaveAttribute('data-result', 'pass', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Finish marking' }).click();
    await expect(page.getByText(/Marked: 3 \/ 5 points/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('reread-list')).toBeVisible({ timeout: 30_000 });
    await page.goto(`/c/${slug}/overview`);
    await expect(page.getByTestId('reread-list')).toBeVisible();
  });
});
