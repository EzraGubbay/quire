// Headless parity check for the vendored Moodle parser, run against the agent's saved fixture.
// It requires the COMPILED CommonJS output (dist/engine/moodle.js) — proving the TS→CJS port actually
// loads via `require` at runtime (node-html-parser included), not merely that it typechecks — and
// asserts the same expectations as the original tools/lemida-agent/test/moodle.test.js.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { parseMoodleCourse, parsePluginfileLinks, filenameFrom, isAuthWall, decideLoggedIn } = require(
  path.join(__dirname, '..', 'dist', 'engine', 'moodle.js'),
);
const { mapSameSite, normalizeCdpCookies, parseDevToolsActivePort } = require(
  path.join(__dirname, '..', 'dist', 'engine', 'brave-login.js'),
);

const fixture = readFileSync(
  path.join(__dirname, '..', '..', '..', 'tools', 'lemida-agent', 'fixtures', 'course.html'),
  'utf8',
);
const base = 'https://lemida.biu.ac.il/course/view.php?id=9';

// 1) every activity with its section + module type (mirrors the original unit test)
const items = parseMoodleCourse(fixture, base);
assert.equal(items.length, 5, `expected 5 activities, got ${items.length}`);

const lecture = items.find((i) => i.href.includes('resource/view.php?id=101'));
assert.equal(lecture.name, 'הרצאה 1 - מבוא לקורס');
assert.equal(lecture.moduleType, 'mod_resource');
assert.equal(lecture.sectionTitle, 'הרצאות');

const folder = items.find((i) => i.href.includes('folder/view.php?id=102'));
assert.equal(folder.moduleType, 'mod_folder');
assert.equal(folder.sectionTitle, 'הרצאות');

const rec = items.find((i) => i.href.includes('resource/view.php?id=201'));
assert.equal(rec.sectionTitle, 'תרגולים');

const hw = items.find((i) => i.href.includes('assign/view.php?id=301'));
assert.equal(hw.moduleType, 'mod_assign');
assert.equal(hw.sectionTitle, 'שיעורי בית');

// 2) all hrefs resolved to absolute
assert.ok(items.every((i) => i.href.startsWith('https://lemida.biu.ac.il/')));

// 3) course-index merge (file only present in the left drawer)
const idxHtml = `
  <div class="courseindex" role="tree">
    <div class="courseindex-section" data-for="section">
      <span class="courseindex-section-title">הרצאות</span>
      <div class="courseindex-item">
        <a class="courseindex-link" href="https://lemida.biu.ac.il/mod/resource/view.php?id=3297801">CPU Architecture</a>
      </div>
    </div>
  </div>`;
const cpu = parseMoodleCourse(idxHtml, base).find((i) => i.href.includes('id=3297801'));
assert.ok(cpu, 'course-index resource should be found');
assert.equal(cpu.name, 'CPU Architecture');
assert.equal(cpu.moduleType, 'mod_resource');
assert.equal(cpu.sectionTitle, 'הרצאות');

// 4) pluginfile links skip the zip-download control
const links = parsePluginfileLinks(
  `<a href="https://lemida.biu.ac.il/pluginfile.php/123/mod_folder/content/0/lec1.pdf">lec1.pdf</a>
   <a href="/mod/folder/download.php?id=5">Download folder</a>
   <a href="https://lemida.biu.ac.il/pluginfile.php/123/mod_folder/content/0/lec2.pdf">lec2.pdf</a>`,
  'https://lemida.biu.ac.il/',
);
assert.equal(links.length, 2);

// 5) filenameFrom + isAuthWall
assert.equal(
  filenameFrom('https://x/pluginfile.php/1/a.pdf', 'attachment; filename="Lecture 1.pdf"'),
  'Lecture 1.pdf',
);
assert.equal(filenameFrom('https://x/pluginfile.php/1/Intro%20to%20AI.pdf'), 'Intro to AI.pdf');
assert.ok(isAuthWall('https://lemida.biu.ac.il/login/index.php'));
assert.ok(isAuthWall('https://login.microsoftonline.com/x'));
assert.ok(!isAuthWall('https://lemida.biu.ac.il/course/view.php?id=9'));

// 6) decideLoggedIn — the sign-in detection that decides when the embedded window has succeeded.
const home = 'https://lemida.biu.ac.il/my/';
const NO = { bodyClass: '', hasLogout: false, hasLogin: false, hasAvatar: false };
// Moodle's body class is authoritative, either way.
assert.equal(decideLoggedIn(home, { ...NO, bodyClass: 'path-my userloggedin' }), true, 'userloggedin → in');
assert.equal(
  decideLoggedIn(home, { ...NO, bodyClass: 'notloggedin', hasLogout: true }),
  false,
  'notloggedin → out',
);
// A real sign-in that used to be MISSED: logged-in body class but no logout link in the static DOM.
assert.equal(
  decideLoggedIn(home, { ...NO, bodyClass: 'userloggedin', hasLogin: false }),
  true,
  'userloggedin w/o logout link → in',
);
// Fallbacks when the body class is absent.
assert.equal(decideLoggedIn(home, { ...NO, hasLogout: true }), true, 'logout link, no login link → in');
assert.equal(decideLoggedIn(home, { ...NO, hasAvatar: true }), true, 'user avatar, no login link → in');
assert.equal(
  decideLoggedIn(home, { ...NO, hasLogout: true, hasLogin: true }),
  false,
  'login link present → out',
);
assert.equal(decideLoggedIn(home, NO), false, 'no signals → out');
// An auth wall / 365 redirect is never "in", whatever the DOM says.
assert.equal(
  decideLoggedIn('https://login.microsoftonline.com/x', { ...NO, bodyClass: 'userloggedin' }),
  false,
  'auth wall → out',
);
assert.equal(
  decideLoggedIn('https://lemida.biu.ac.il/login/index.php', { ...NO, hasLogout: true }),
  false,
  'login page → out',
);

// 7) brave-login cookie harvest helpers (the real-browser sign-in path).
// SameSite spellings map CDP → Electron.
assert.equal(mapSameSite('Strict'), 'strict');
assert.equal(mapSameSite('Lax'), 'lax');
assert.equal(mapSameSite('None'), 'no_restriction');
assert.equal(mapSameSite(undefined), 'unspecified');

// normalizeCdpCookies keeps only BIU-host cookies and maps session vs persistent correctly.
const harvested = normalizeCdpCookies([
  {
    name: 'MoodleSession',
    value: 'abc',
    domain: 'lemida.biu.ac.il',
    path: '/',
    secure: true,
    httpOnly: true,
    session: true,
    expires: -1,
  },
  {
    name: '_px3',
    value: 'z',
    domain: '.biu.ac.il',
    path: '/',
    secure: true,
    httpOnly: false,
    session: false,
    expires: 1893456000,
    sameSite: 'None',
  },
  {
    name: 'junk',
    value: 'nope',
    domain: 'tracker.example.com',
    path: '/',
    secure: true,
    httpOnly: false,
    session: false,
    expires: 1893456000,
  },
]);
assert.equal(harvested.length, 2, 'only BIU-host cookies are kept');
const ms = harvested.find((c) => c.name === 'MoodleSession');
assert.ok(ms && ms.expirationDate === undefined, 'session cookie has no expirationDate');
assert.equal(ms.secure, true);
assert.equal(ms.httpOnly, true);
const px = harvested.find((c) => c.name === '_px3');
assert.equal(px.expirationDate, 1893456000, 'persistent cookie keeps its expiry');
assert.equal(px.sameSite, 'no_restriction');
assert.ok(!harvested.some((c) => c.name === 'junk'), 'non-BIU cookie is dropped');

// parseDevToolsActivePort reads the port + browser WS path Chromium writes on launch.
const dbg = parseDevToolsActivePort('54321\n/devtools/browser/abc-123\n');
assert.ok(dbg && dbg.port === 54321 && dbg.wsPath === '/devtools/browser/abc-123');
assert.equal(parseDevToolsActivePort(''), null, 'empty file → null');
assert.equal(parseDevToolsActivePort('not-a-port\n'), null, 'non-numeric port → null');

console.log(
  'smoke-parser: OK — 5 activities, course-index merge, pluginfile, filename, auth-wall, sign-in detection, cookie harvest all match.',
);
