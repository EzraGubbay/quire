// Deterministic semantic typing for a file pulled from Lemida (Moodle). Phase 1 uses only the file name,
// the Moodle section heading it sat under, and the Moodle module type — no LLM. Every result records which
// signal decided it and a confidence, so Phase 2 can measure deterministic coverage and learn new rules.
import type { LemidaKind } from '@quire/shared';
import { parseSessionFilename } from '@/lib/sessions';

export interface ClassifyInput {
  fileName: string;
  /** Moodle section heading the resource sat under (often Hebrew), when known. */
  sectionTitle?: string;
  /** Moodle module type: mod_resource, mod_folder, mod_assign, mod_url, mod_page, … */
  moduleType?: string;
  /** First page of a PDF, when the caller extracted it; a weak tiebreaker only. */
  firstPageSnippet?: string;
}

export interface Classification {
  kind: LemidaKind;
  number?: number;
  title?: string;
  /** 0..1; higher means a stronger, more specific signal fired. */
  confidence: number;
  /** Which signal(s) decided it, e.g. "module:mod_assign" or "section:הרצאה+file:lecture". */
  rule: string;
}

/**
 * Keyword patterns per kind, checked against the file name and the section heading. Hebrew has no case,
 * and `\b` is ASCII-only in JS, so Latin words use `\b` and Hebrew words are matched literally. Order is
 * priority: homework before recitation (so "תרגיל בית" wins over the bare "תרגיל"), exam before lecture.
 */
// Hebrew words are matched by stem so singular and plural both hit (הרצאה/הרצאות → הרצא), and final-form
// letters are covered explicitly (מבחן/מבחנים → מבח[ןנ]). Order is priority: homework before recitation
// so "תרגיל בית" wins over the bare "תרגול/תרגיל" family, exam before lecture.
const KIND_PATTERNS: { kind: LemidaKind; re: RegExp }[] = [
  {
    kind: 'homework',
    re: /תרגיל\s*בית|שיעור[יe]?\s*בית|שו"?ב|מטל[הת]|\bhomework\b|\bassignment\b|problem\s*set|\bpset\b|\bhw\s*\d|\bex\d|\bex\s*\d/i,
  },
  {
    kind: 'exam',
    re: /מבח[ןנ]|בחינ|מועד\s*[אבג]|בוח[ןנ]|\bexam\b|\bmidterm\b|\bfinal\b|\bquiz\b|\bmoed\b/i,
  },
  {
    kind: 'recitation',
    re: /תרגול|תירגול|\brecitation\b|\btutorial\b|\btirgul\b|\bdiscussion\b|\brec\b/i,
  },
  {
    kind: 'lecture',
    re: /הרצא|שיעור(?!\s*בית)|\blecture\b|\blec\b|\bslides?\b|מצג[תות]/i,
  },
  {
    kind: 'book',
    re: /ספר\s|\btextbook\b|course\s*book|\breader\b|חומר\s*קריאה|חוברת/i,
  },
];

const firstMatch = (text: string): LemidaKind | undefined => KIND_PATTERNS.find((p) => p.re.test(text))?.kind;

/** A Moodle assignment activity is homework regardless of its name. */
const moduleKind = (moduleType: string): LemidaKind | undefined =>
  /assign/i.test(moduleType) ? 'homework' : undefined;

export function classifyLemidaFile(input: ClassifyInput): Classification {
  const fileName = input.fileName ?? '';
  const section = input.sectionTitle ?? '';
  const moduleType = input.moduleType ?? '';

  const fromModule = moduleKind(moduleType);
  const fromSection = firstMatch(section);
  const fromFile = firstMatch(fileName);

  let kind: LemidaKind = 'unknown';
  let confidence = 0;
  const rules: string[] = [];

  if (fromModule) {
    kind = fromModule;
    confidence = 0.95;
    rules.push(`module:${moduleType}`);
    if (fromSection === kind) rules.push(`section:${section.trim()}`);
    if (fromFile === kind) rules.push(`file:${fileName}`);
  } else if (fromSection && fromFile && fromSection === fromFile) {
    kind = fromSection;
    confidence = 0.95;
    rules.push(`section:${section.trim()}`, `file:${fileName}`);
  } else if (fromSection) {
    kind = fromSection;
    confidence = 0.85;
    rules.push(`section:${section.trim()}`);
  } else if (fromFile) {
    kind = fromFile;
    confidence = 0.7;
    rules.push(`file:${fileName}`);
  }

  const result: Classification = { kind, confidence, rule: rules.join('+') };
  // Lectures and recitations carry a number and a title; reuse the session-filename parser for both.
  if (kind === 'lecture' || kind === 'recitation') {
    const parsed = parseSessionFilename(fileName);
    if (parsed.number !== undefined) result.number = parsed.number;
    if (parsed.title) result.title = parsed.title;
  } else if (kind === 'exam') {
    result.title = cleanTitle(fileName);
  }
  return result;
}

const HW_NUM = /(?:תרגיל\s*בית|שיעור[יe]?\s*בית|מטלה|homework|assignment|\bhw|\bps|\bex)\D{0,6}(\d{1,3})/i;
/** A homework number from the file name; the first integer as a fallback. */
export function homeworkNumber(fileName: string): number | undefined {
  const m = fileName.match(HW_NUM) ?? fileName.match(/(\d{1,3})/);
  return m?.[1] ? Number(m[1]) : undefined;
}

const DUE = /(?:להגש[הת]|הגשה|due|deadline)[^0-9]{0,12}(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/i;
/** A due date mentioned on the first page ("להגשה עד 12.11"), interpreted as this academic year. */
export function parseDueDate(snippet: string | undefined, now = new Date()): Date | null {
  if (!snippet) return null;
  const m = snippet.match(DUE);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // No explicit year and the date already passed this year ⇒ it means next year.
  const d = new Date(year, month - 1, day, 23, 59);
  if (!m[3] && d.getTime() < now.getTime() - 7 * 86_400_000) d.setFullYear(year + 1);
  return d;
}

/** File name minus extension, separators tidied, for a human-readable title. */
export function cleanTitle(fileName: string): string {
  return (
    fileName
      .replace(/\.[A-Za-z0-9]{1,5}$/, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'Untitled'
  );
}
