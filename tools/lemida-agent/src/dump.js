// Throwaway diagnostic: load a course page with the saved session and report what the parser sees.
// Usage: node --env-file-if-exists=.env src/dump.js <courseUrl>
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { gatherResources } from './browser.js';
import { loadConfig } from './config.js';
import { isAuthWall } from './moodle.js';
import { resolveBrowser } from './which-browser.js';

const url = process.argv[2];
if (!url) throw new Error('usage: node src/dump.js <courseUrl>');
const config = loadConfig();
const b = resolveBrowser(config);
console.log('browser:', b.name);

const ctx = await chromium.launchPersistentContext(config.profileDir, {
  headless: true,
  userAgent: config.userAgent,
  ...(b.executablePath ? { executablePath: b.executablePath } : {}),
  ...(b.channel ? { channel: b.channel } : {}),
});

// Restore the saved session exactly like probe/sync do.
if (existsSync(config.stateFile)) {
  try {
    const state = JSON.parse(await readFile(config.stateFile, 'utf8'));
    if (Array.isArray(state.cookies) && state.cookies.length) {
      await ctx.addCookies(state.cookies);
      console.log('restored', state.cookies.length, 'cookies');
    }
  } catch (e) {
    console.log('state restore failed:', e.message);
  }
} else {
  console.log('no .storage.json — not logged in');
}

const page = ctx.pages()[0] ?? (await ctx.newPage());
const counts = () =>
  page.evaluate(() => {
    const n = (sel) => document.querySelectorAll(sel).length;
    return {
      url: location.href,
      liActivity: n('li.activity'),
      dataActivity: n('[data-region="activity"]'),
      modtype: n('[class*="modtype_"]'),
      modLinks: n('a[href*="/mod/"]'),
      sections: n('li.section, [data-for="section"], .course-section'),
      activityname: n('.activityname'),
    };
  });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(1500);
console.log('authWall:', isAuthWall(page.url()));
console.log('counts:', JSON.stringify(await counts()));

await writeFile('/tmp/lemida-course.html', await page.content());

const resources = await gatherResources(page);
console.log(`\ngatherResources (incl. subsections): ${resources.length} file activities`);
for (const r of resources) console.log(`  [${r.moduleType}] ${r.sectionTitle} :: ${r.name} -> ${r.href}`);
const hit = resources.filter((r) => /cpu|architecture|מעבד|ארכיטקטורה/i.test(r.name));
console.log('\nCPU/architecture matches:', JSON.stringify(hit));
await ctx.close();
