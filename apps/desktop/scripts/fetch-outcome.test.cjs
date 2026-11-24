const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fo = require(path.join(__dirname, '..', 'dist', 'engine', 'fetch-outcome.js'));

const U = 'https://lemida.biu.ac.il/mod/resource/view.php?id=1';
const raw = (o = {}) => {
  const hops = o.hops ?? [];
  return {
    requestedUrl: U,
    hops,
    finalUrl: hops.length ? hops[hops.length - 1] : U,
    status: 200,
    headers: {},
    body: Buffer.from(''),
    ...o,
  };
};
const html = (s, extra = {}) =>
  raw({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(s), ...extra });

test('200 pdf is a file', () => {
  const r = raw({ headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.7 abc') });
  assert.equal(fo.classifyResponse(r, 'file').kind, 'file');
});

test('bug 1: login hop with a 200 HTML final is login_page (decided from hops)', () => {
  const r = html('<html><body>hi</body></html>', { hops: ['https://lemida.biu.ac.il/login/index.php'] });
  assert.equal(fo.classifyResponse(r, 'file').kind, 'login_page');
});

test('perfdrive hop is bot_page', () => {
  const r = html('<html></html>', { hops: ['https://validate.perfdrive.com/x?ssa=1'] });
  assert.equal(fo.classifyResponse(r, 'file').kind, 'bot_page');
});

test('login form in body is login_page', () => {
  const r = html(
    '<html><form action="https://lemida.biu.ac.il/login/index.php" method="post"></form></html>',
  );
  assert.equal(fo.classifyResponse(r, 'page', 'mod_folder').kind, 'login_page');
});

test('captcha marker in HTML is bot_page', () => {
  assert.equal(fo.classifyResponse(html('<html>Please solve the CAPTCHA</html>'), 'file').kind, 'bot_page');
  assert.equal(fo.classifyResponse(html('<html>perfdrive</html>'), 'file').kind, 'bot_page');
});

test('non-2xx statuses', () => {
  const a = fo.classifyResponse(raw({ status: 403 }), 'file');
  assert.equal(a.kind, 'non_2xx');
  assert.equal(a.status, 403);
  assert.equal(fo.classifyResponse(raw({ status: 500 }), 'file').kind, 'non_2xx');
});

test('304 is not_modified', () => {
  assert.equal(fo.classifyResponse(raw({ status: 304 }), 'file').kind, 'not_modified');
});

test('expect file, plain HTML is html_no_link', () => {
  assert.equal(fo.classifyResponse(html('<html><body>nothing</body></html>'), 'file').kind, 'html_no_link');
});

test('expect page: mod marker is page, otherwise html_no_link', () => {
  const ok = html('<html><body id="page-mod-folder-view"></body></html>');
  assert.equal(fo.classifyResponse(ok, 'page', 'mod_folder').kind, 'page');
  const bad = html('<html><body id="page-x"></body></html>');
  assert.equal(fo.classifyResponse(bad, 'page', 'mod_folder').kind, 'html_no_link');
  const links = html('<html><a href="/pluginfile.php/1/a.pdf">a</a></html>');
  assert.equal(fo.classifyResponse(links, 'page', 'mod_folder').kind, 'page');
});

test('transport errors map through', () => {
  for (const error of ['timeout', 'too_large', 'network_error']) {
    assert.equal(fo.classifyResponse(raw({ status: 0, error }), 'file').kind, error);
  }
});

test('sanitizeSnippet', () => {
  const s1 = fo.sanitizeSnippet(Buffer.from('<input type="hidden" name="logintoken" value="AbC123xyz">'));
  assert.ok(!s1.includes('AbC123xyz'));
  assert.ok(s1.includes('logintoken'));
  assert.ok(fo.sanitizeSnippet(Buffer.from('a?sesskey=abcdef1234&b=1')).includes('sesskey=[redacted]'));
  const tok = 'Q'.repeat(40);
  const s3 = fo.sanitizeSnippet(Buffer.from(`x ${tok} y`));
  assert.ok(!s3.includes(tok));
  assert.ok(s3.includes('[redacted]'));
  const s4 = fo.sanitizeSnippet(Buffer.from([0x01, 0x02, 0x41, 0x00, 0x42, 0xff]));
  assert.match(s4, /^\.\.A\.B\.$/);
  const long = fo.sanitizeSnippet(Buffer.from('hello world '.repeat(100)));
  assert.ok(long.length <= 200);
  assert.match(long, /^[\x20-\x7e]*$/);
  assert.ok(fo.sanitizeSnippet(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3')).startsWith('%PDF-1.7'));
});

test('formatRequestLog has all fields, no secret headers, final from last hop', () => {
  const r = html('<html><head><title>Course: Foo</title></head></html>', {
    hops: ['https://a.example/x', 'https://b.example/y?token=SECRETVALUE1'],
    headers: {
      'content-type': 'text/html',
      'set-cookie': 'MoodleSession=ABCDEFSECRET',
      authorization: 'Bearer ZZZZ',
      etag: '"e1"',
    },
  });
  const line = fo.formatRequestLog('https://lemida/act', r, fo.classifyResponse(r, 'page', 'mod_folder'));
  for (const k of [
    'activity=',
    'url=',
    'final=',
    'status=',
    'type=',
    'len=',
    'disp=',
    'etag=yes',
    'outcome=',
    'head=',
    'title="Course: Foo"',
  ]) {
    assert.ok(line.includes(k), k);
  }
  assert.ok(!/cookie|authorization|ABCDEFSECRET|ZZZZ|SECRETVALUE1/i.test(line));
  assert.ok(line.includes('final=https://b.example/y?token=[redacted]'));
  assert.ok(line.includes('hops=2'));
});

test('redactUrl redacts code/state/token', () => {
  const u = fo.redactUrl('https://x/cb?code=abc123&state=st4te&token=tok&keep=1');
  assert.equal(u, 'https://x/cb?code=[redacted]&state=[redacted]&token=[redacted]&keep=1');
});

test('review 1: signed-in folder page with a perfdrive script and CAPTCHA.pdf link is a page', () => {
  const body =
    '<html><head><script src="https://cdn.perfdrive.com/aperture/x.js"></script></head>' +
    '<body id="page-mod-folder-view" class="path-mod path-mod-folder userloggedin">' +
    '<a href="/pluginfile.php/1/mod_folder/content/3/CAPTCHA.pdf">CAPTCHA.pdf</a> Access denied to others</body></html>';
  assert.equal(fo.classifyResponse(html(body), 'page', 'mod_folder').kind, 'page');
  const chrome = '<html><body class="userloggedin path-course-view">shieldsquare</body></html>';
  assert.equal(fo.classifyResponse(html(chrome), 'page', 'mod_folder').kind, 'html_no_link');
});

test('review 1: genuine bot challenge without Moodle chrome is bot_page', () => {
  const body =
    '<html><head><title>Access Denied</title><script src="https://cdn.perfdrive.com/c.js"></script></head><body>captcha</body></html>';
  assert.equal(fo.classifyResponse(html(body), 'file').kind, 'bot_page');
});

test('review 2: SessionExpired / NotEnrolled messages carry no URL secrets', () => {
  const { SessionExpired, NotEnrolled } = require(path.join(__dirname, '..', 'dist', 'engine', 'errors.js'));
  const u = 'https://login.microsoftonline.com/x/oauth2?state=ST4TEVAL&nonce=N0NCEVAL&code=C0DEVAL&client=1';
  for (const E of [SessionExpired, NotEnrolled]) {
    const m = new E(u).message;
    assert.ok(!/ST4TEVAL|N0NCEVAL|C0DEVAL/.test(m), m);
  }
});

test('review 5: Hebrew survives in titles and snippets, control chars do not', () => {
  const t = fo.pageTitle('<html><title>קורס: מבוא\u0001</title></html>');
  assert.equal(t, 'קורס: מבוא.');
  assert.ok(fo.sanitizeSnippet(Buffer.from('<p>שלום עולם</p>')).includes('שלום עולם'));
});

test('review 6: redaction happens before truncation; JSON pairs and unterminated values redacted', () => {
  const secret = 'ZYXWVUTSRQ';
  const pad = `<div>${'x '.repeat(90)}</div><input type="hidden" value="${secret}${'q'.repeat(30)}">`;
  const out = fo.sanitizeSnippet(Buffer.from(pad));
  assert.ok(!out.includes(secret), out);
  const j = fo.sanitizeSnippet(Buffer.from('<script>{"sesskey":"abcd1234","token":"tok-9","ok":1}</script>'));
  assert.ok(!/abcd1234|tok-9/.test(j), j);
  assert.ok(j.includes('"ok":1'));
  const cut = fo.sanitizeSnippet(Buffer.from(`<input value="${secret}`));
  assert.ok(!cut.includes(secret), cut);
});
