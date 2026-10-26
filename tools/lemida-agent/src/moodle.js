// Pure parsing of Moodle (Lemida) pages. No network, no browser — so it is unit-testable against saved
// HTML fixtures. The live agent feeds it `page.content()`. Targets the standard Boost course layout.
import { parse } from 'node-html-parser';

/** Collapse whitespace and drop Moodle's visually-hidden " File"/" Folder" suffixes. */
export function clean(text) {
  return (text ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Resolve a possibly-relative href against the page URL. */
export function absolute(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

/** Moodle activity module type: from the `modtype_x` class, else from `/mod/x/` in the href. */
export function moduleTypeOf(activityEl, href) {
  const cls = activityEl?.getAttribute?.('class') ?? '';
  const m = cls.match(/modtype_(\w+)/);
  if (m) return `mod_${m[1]}`;
  const h = href.match(/\/mod\/(\w+)\//);
  return h ? `mod_${h[1]}` : '';
}

const SECTION_HEADING = '.sectionname, h3.sectionname, [data-for="section_title"], h3, h4';
// Moodle 4.x renders activities as <div class="activity …">; older/other modules use <li class="activity">.
const ACTIVITY = 'li.activity, div.activity, [data-region="activity"], li.activity-wrapper';
const MOD_LINK = 'a[href*="/mod/"]';

/**
 * Course-page activities as { name, href, moduleType, sectionTitle }, de-duplicated by href.
 * Walks each section so every activity carries the heading it sat under (often Hebrew).
 */
export function parseMoodleCourse(html, baseUrl = 'https://lemida.biu.ac.il/') {
  const root = parse(html);
  const out = [];
  const seen = new Set();
  const push = (el, sectionTitle) => {
    const a = el.querySelector(MOD_LINK);
    if (!a) return;
    const href = absolute(a.getAttribute('href'), baseUrl);
    if (!href || seen.has(href)) return;
    seen.add(href);
    const nameEl = el.querySelector('.instancename') ?? a;
    // Moodle appends a visually-hidden " File"/" Folder"/… label inside the name; drop it.
    for (const hidden of nameEl.querySelectorAll('.accesshide, .visually-hidden, .sr-only')) hidden.remove();
    out.push({
      name: clean(nameEl.text),
      href,
      moduleType: moduleTypeOf(el, href),
      sectionTitle,
    });
  };

  let sections = root.querySelectorAll('li.section, li[id^="section-"], [data-for="section"]');
  if (sections.length === 0) sections = root.querySelectorAll('.course-section');
  if (sections.length > 0) {
    for (const section of sections) {
      const heading = section.querySelector(SECTION_HEADING);
      const sectionTitle = clean(heading?.text);
      for (const act of section.querySelectorAll(ACTIVITY)) push(act, sectionTitle);
    }
  }
  // Fallback: a theme we didn't recognise — scan every activity, no section context.
  if (out.length === 0) {
    for (const act of root.querySelectorAll(ACTIVITY)) push(act, '');
  }

  // The course-index drawer lists every activity flat (grouped by section), including files inside
  // collapsed Moodle-4.5 subsections that never render in the main content region. Merge those in.
  const idx = root.querySelector('.courseindex') ?? root;
  for (const section of idx.querySelectorAll('.courseindex-section')) {
    const t = section.querySelector(
      '.courseindex-section-title, [data-for="section_item"], .courseindex-name',
    );
    // Drop the expand/collapse toggle and hidden labels so the heading isn't prefixed with UI text.
    if (t)
      for (const x of t.querySelectorAll('button, svg, .accesshide, .visually-hidden, .sr-only')) x.remove();
    const sectionTitle = clean(t?.text);
    for (const a of section.querySelectorAll('a[href*="/mod/"]')) {
      const href = absolute(a.getAttribute('href'), baseUrl);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push({ name: clean(a.text), href, moduleType: moduleTypeOf(a, href), sectionTitle });
    }
  }
  return out;
}

/** pluginfile download links on a folder or assignment page, as absolute URLs (de-duplicated). */
export function parsePluginfileLinks(html, baseUrl) {
  const root = parse(html);
  const urls = [];
  const seen = new Set();
  for (const a of root.querySelectorAll('a[href*="/pluginfile.php/"]')) {
    const href = absolute(a.getAttribute('href'), baseUrl);
    // Skip the "download folder as zip" control; we pull the individual files.
    if (/folder\/download\.php/.test(href)) continue;
    if (href && !seen.has(href)) {
      seen.add(href);
      urls.push(href);
    }
  }
  return urls;
}

/** The first pluginfile/embedded file link on a mod/resource page that shows a download instead of the file. */
export function parseResourceWorkaround(html, baseUrl) {
  const [first] = parsePluginfileLinks(html, baseUrl);
  if (first) return first;
  const root = parse(html);
  const obj = root.querySelector('object[data], iframe[src*="/pluginfile.php/"], embed[src]');
  const src = obj?.getAttribute('data') ?? obj?.getAttribute('src');
  return src ? absolute(src, baseUrl) : '';
}

/** A readable file name from a Content-Disposition header or, failing that, the URL's last segment. */
export function filenameFrom(url, contentDisposition) {
  if (contentDisposition) {
    const star = contentDisposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].replace(/"/g, '').trim());
      } catch {
        /* fall through */
      }
    }
    const plain = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (plain?.[1]) return plain[1].trim();
  }
  try {
    const path = new URL(url).pathname;
    const seg = path.split('/').filter(Boolean).pop() ?? 'file';
    return decodeURIComponent(seg);
  } catch {
    return 'file';
  }
}

/** URLs under these paths on the Lemida host mean the session is gone / a bot wall. */
const AUTH_WALL = [/\/login\//i, /login\.microsoftonline\.com/i, /perfdrive\.com/i, /validate\.perfdrive/i];
export function isAuthWall(url) {
  return AUTH_WALL.some((re) => re.test(url ?? ''));
}
