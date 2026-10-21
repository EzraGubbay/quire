// Prompts for the self-tests and the post-marking re-read list. One-shot, JSON out.
import type { CourseType } from '@quire/shared';

export const WEEKLY_SYSTEM = `[task:test]
You write a short self-test for a university student on the material of specific lectures or recitations.

Purpose: trigger recall of the week's material. The questions may be dry: definitions, "state the …", "what does
X do", "give the complexity of …", short derivations, fill-in-the-blank, small code reading or writing. They are not
meant to be exam-like. Cover the whole set of sessions given, spread across topics, and lean toward anything the
notes mark as a definition, theorem, claim, pitfall or distinction. If a list of previously missed concepts is given,
include at least one question per missed concept.

Return ONLY a JSON object (no prose around it) of the form
{"title": "short title", "questions": [{"n": 1, "body": "question in Markdown with $math$", "modelAnswer": "concise model answer in Markdown", "concept": "2-6 word concept label", "points": 1}]}
Write 8 to 14 questions. Points 1 to 3 by effort. The student will answer on paper, then reveal each model answer and
mark pass / partial / fail themselves, so model answers must be crisp and checkable. Use the course's term labels
(**Definition:**, **Theorem:**) inside answers where natural. Slide text may be Hebrew: write questions and answers in
English, keeping a key Hebrew term in parentheses where it helps recognition.`;

export const TRIWEEKLY_SYSTEM = `[task:test]
You write an exam-style test for a university student covering everything taught in the course so far.

Purpose: rehearse the real exam. Match the style, structure, phrasing, difficulty and length of the practice exams
provided (they are real past exams of this course) as closely as you can WITHOUT copying any question: new
questions, same kind. If the exams mix multiple choice with open questions, do the same, in the same proportions.
If they chain sub-questions (a, b, c) building on each other, do that. If they give a scenario or code and ask several
things about it, do that. Weight topics the way the exams do, while making sure material from the most recent weeks
appears. Use the student's notes as the source of truth for what was taught; prefer concepts the notes flag as
important. If "what I lost points on" feedback from homework is given, include questions that probe those weaknesses.

Return ONLY a JSON object (no prose around it) of the form
{"title": "short title", "questions": [{"n": 1, "body": "full question in Markdown with $math$ and code blocks as needed; sub-questions as (a), (b), (c) inside the body", "modelAnswer": "complete model answer in Markdown, with the key steps a grader would look for", "concept": "2-6 word concept label", "points": 10}]}
Points should sum to 100 like an exam. The student answers on paper under exam conditions, then reveals the model
answers and marks pass / partial / fail per question. English, with key Hebrew terms in parentheses where they help.`;

export const REREAD_SYSTEM = `[task:reread]
After a self-test, pick what the student should re-read for each question they failed or only partly answered.

You get the failed questions (with model answers), an index of the student's notes (note title, note id, and the
headings in each note with their slugs), and the course's decks (title, document id, slide count, with slide text).
For each failed question return 1 to 3 targets: the most specific note section or the slide that teaches the missed
concept. Prefer note sections over slides; use a slide only when the notes do not cover the concept. Each target gets
a one-line reason that names the concept missed.

Return ONLY a JSON object of the form
{"items": [{"questionN": 1, "kind": "note", "noteId": "uuid", "heading": "heading-slug", "reason": "…"}, {"questionN": 2, "kind": "slide", "documentId": "uuid", "page": 14, "reason": "…"}]}
Use only ids, heading slugs and page numbers that appear in the index.`;

export const TYPE_HINT: Record<CourseType, string> = {
  practical: 'This is a practical course: include code reading/writing, debugging and performance reasoning.',
  theoretical:
    'This is a theoretical course: include precise definitions, proofs or proof sketches, and reductions.',
  mixed:
    'This course mixes theory and practice: include both proofs/definitions and concrete code or examples.',
};
