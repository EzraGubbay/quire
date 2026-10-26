// Throwaway diagnostic: load a course page with the saved profile and report what the DOM actually
// contains, at domcontentloaded vs after the network settles. Usage: node src/dump.js <courseUrl>
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { isAuthWall, parseMoodleCourse } from './moodle.js';
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
const page = ctx.pages()[0] ?? (await ctx.newPage());

const counts = (label) =>
  page.evaluate((l) => {
    const n = (sel) => document.querySelectorAll(sel).length;
    return {
      stage: l,
      url: location.href,
      liActivity: n('li.activity'),
      dataActivity: n('[data-region="activity"]'),
      modtype: n('[class*="modtype_"]'),
      modLinks: n('a[href*="/mod/"]'),
      sections: n('li.section, [data-for="section"], .course-section'),
      activityname: n('.activityname'),
      instancename: n('.instancename'),
    };
  }, label);

await page.goto(url, { waitUntil: 'domcontentloaded' });
console.log('authWall(domcontentloaded):', isAuthWall(page.url()));
console.log(JSON.stringify(await counts('domcontentloaded')));
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(1500);
console.log(JSON.stringify(await counts('networkidle')));

const html = await page.content();
await writeFile('/tmp/lemida-course.html', html);
console.log('saved /tmp/lemida-course.html bytes=', html.length);
console.log('parseMoodleCourse found:', parseMoodleCourse(html, page.url()).length);
console.log('first 3:', JSON.stringify(parseMoodleCourse(html, page.url()).slice(0, 3)));
await ctx.close();
