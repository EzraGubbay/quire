import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { filenameFrom, isAuthWall, parseMoodleCourse, parsePluginfileLinks } from '../src/moodle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => readFile(path.join(here, '..', 'fixtures', 'course.html'), 'utf8');

test('parses every activity with its section and module type', async () => {
  const items = parseMoodleCourse(await fixture(), 'https://lemida.biu.ac.il/course/view.php?id=9');
  assert.equal(items.length, 5);

  const lecture = items.find((i) => i.href.includes('resource/view.php?id=101'));
  assert.equal(lecture.name, 'הרצאה 1 - מבוא לקורס'); // visually-hidden " קובץ" stripped
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
});

test('resolves relative hrefs to absolute', async () => {
  const items = parseMoodleCourse(await fixture(), 'https://lemida.biu.ac.il/course/view.php?id=9');
  assert.ok(items.every((i) => i.href.startsWith('https://lemida.biu.ac.il/')));
});

test('parsePluginfileLinks finds files and skips the zip-download control', () => {
  const html = `
    <a href="https://lemida.biu.ac.il/pluginfile.php/123/mod_folder/content/0/lec1.pdf">lec1.pdf</a>
    <a href="/mod/folder/download.php?id=5">Download folder</a>
    <a href="https://lemida.biu.ac.il/pluginfile.php/123/mod_folder/content/0/lec2.pdf">lec2.pdf</a>`;
  const links = parsePluginfileLinks(html, 'https://lemida.biu.ac.il/');
  assert.equal(links.length, 2);
  assert.ok(links[0].endsWith('lec1.pdf'));
});

test('filenameFrom prefers Content-Disposition then the URL', () => {
  assert.equal(
    filenameFrom('https://x/pluginfile.php/1/a.pdf', 'attachment; filename="Lecture 1.pdf"'),
    'Lecture 1.pdf',
  );
  assert.equal(filenameFrom('https://x/pluginfile.php/1/Intro%20to%20AI.pdf'), 'Intro to AI.pdf');
});

test('isAuthWall flags login, Microsoft and Radware URLs', () => {
  assert.ok(isAuthWall('https://lemida.biu.ac.il/login/index.php'));
  assert.ok(isAuthWall('https://login.microsoftonline.com/x'));
  assert.ok(isAuthWall('https://validate.perfdrive.com/abc'));
  assert.ok(!isAuthWall('https://lemida.biu.ac.il/course/view.php?id=9'));
});
