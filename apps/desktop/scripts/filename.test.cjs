// Unit tests for the electron-free file-name decoder (Lemida Hebrew names, bug 11).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = (f) => path.join(__dirname, '..', 'dist', 'engine', f);
const { filenameFrom, repairLatin1Mojibake } = require(dist('filename.js'));

const URL0 = 'https://lemida.biu.ac.il/pluginfile.php/1/mod_resource/content/0/x.pdf';
const heb = 'תרגול 4.pdf';
// Exactly what Electron's fetch hands the engine: UTF-8 bytes read as Latin-1.
const moj = Buffer.from(heb, 'utf8').toString('latin1');
const enc = encodeURIComponent(heb);

test('Hebrew via filename*', () => {
  assert.equal(filenameFrom(URL0, `attachment; filename*=UTF-8''${enc}`), heb);
});

test('Hebrew mis-decoded as Latin-1 is repaired', () => {
  assert.equal(filenameFrom(URL0, `inline; filename="${moj}"`), heb);
  assert.equal(repairLatin1Mojibake(moj), heb);
});

test('filename* wins over filename', () => {
  assert.equal(filenameFrom(URL0, `attachment; filename="${moj}"; filename*=UTF-8''${enc}`), heb);
});

test('ASCII is unchanged', () => {
  assert.equal(filenameFrom(URL0, 'attachment; filename="Lecture 1.pdf"'), 'Lecture 1.pdf');
  assert.equal(filenameFrom(URL0, 'attachment; filename=plain.pdf'), 'plain.pdf');
});

test('genuine Latin-1 is not corrupted', () => {
  assert.equal(filenameFrom(URL0, 'attachment; filename="café.pdf"'), 'café.pdf');
  assert.equal(repairLatin1Mojibake('café'), 'café');
  const m = Buffer.from('café.pdf', 'utf8').toString('latin1');
  assert.equal(filenameFrom(URL0, `attachment; filename="${m}"`), 'café.pdf');
});

test('quotes and semicolons in quoted names', () => {
  assert.equal(filenameFrom(URL0, 'attachment; filename="a; b \\"c\\".pdf"'), 'a; b "c".pdf');
});

test('percent-encoded plain filename (Moodle Edge form)', () => {
  assert.equal(filenameFrom(URL0, `attachment; filename="${enc}"`), heb);
});

test('filename* with language tag and Latin-1 charset', () => {
  assert.equal(filenameFrom(URL0, "attachment; filename*=iso-8859-1'en'caf%E9.pdf"), 'café.pdf');
});

test('malformed filename* falls back to the URL', () => {
  assert.equal(
    filenameFrom('https://x/p/1/fallback.pdf', "attachment; filename*=UTF-8''%E0%A4%A.pdf"),
    'fallback.pdf',
  );
});

test('missing header uses the URL', () => {
  assert.equal(filenameFrom(`https://lemida.biu.ac.il/pluginfile.php/1/${enc}`), heb);
  assert.equal(filenameFrom(`https://lemida.biu.ac.il/pluginfile.php/1/${enc}`, 'attachment'), heb);
  assert.equal(filenameFrom('https://x/pluginfile.php/1/Intro%20to%20AI.pdf'), 'Intro to AI.pdf');
});

test('URL edge cases', () => {
  assert.equal(filenameFrom('https://x/pluginfile.php/1/100%.pdf'), '100%.pdf');
  assert.equal(filenameFrom('not a url'), 'file');
  assert.equal(filenameFrom('https://x/'), 'file');
});

test('already-Unicode plain value is left alone', () => {
  assert.equal(filenameFrom(URL0, `attachment; filename="${heb}"`), heb);
});

test('moodle.ts re-exports filenameFrom', () => {
  assert.equal(require(dist('moodle.js')).filenameFrom, require(dist('filename.js')).filenameFrom);
});
