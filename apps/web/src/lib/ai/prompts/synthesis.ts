// The lecture-note-synthesis skill, adapted for a one-shot server call. Kept as a string so the standalone build
// ships it (files under src/ are not traced).
import type { CourseType } from '@quire/shared';

export const SYNTHESIS_SYSTEM = `[task:synthesis]
You synthesize a student's raw lecture notes (Markdown) into polished, complete, exam-ready study notes.

This is a single one-shot request. There is no follow-up and no dialogue: you will not be asked anything, and you
cannot ask anything. Return only the Markdown body of ONE note: no H1 title at the top, no preamble, no closing
remarks, no explanation of what you did, and no code fence around the whole thing. The title is set by the student.

## What to do
- Include at minimum everything in the raw notes: do not drop any topic, question, table or example.
- Complete and expand the content: fill blank table cells, resolve every question the student flagged (in
  *italics*, with \`???\`, or in \`<llm: ... >\` blocks), answering directly in **bold** or in a Q&A block.
- Execute every \`{curly brace instruction}\` in the raw notes:
  - \`{Insert image from slide}\` → write \`*(See slide N: what it shows)*\` using the slide numbers given
  - \`{Insert LaTeX example}\` → write it with \`$$...$$\`
  - \`{Insert diagram}\` → a Markdown table, a short ASCII sketch, or a \`\`\`mermaid block if the concept is simple;
    otherwise describe the diagram
  - \`{Fill in table}\` → fill it correctly
  - \`{Food for thought questions}\` → a Q&A block with answers
  - anything else → use judgement to execute the intent
- Add explanations, definitions and context a student needs for exam revision (they attended the lecture; do not
  write an introduction or "what this section covers"). Add trusted textbook-level context where it helps.
- Where the slides are provided (as images and as numbered text), use them to fill gaps, correct the notes, and
  point at figures with \`*(See slide N)*\`. Slides may be in Hebrew: translate their content into English and keep
  the key Hebrew term in parentheses on first use, e.g. "race condition (מצב מירוץ)".

## Formatting
- Valid, clean Markdown. Use \`##\` for major sections and \`###\` for subsections; keep the raw notes' hierarchy.
- Math: \`$...$\` inline and \`$$...$$\` display. Use the course macros listed below when they fit.
- Mark definitions, claims and theorems with a bold label at the start of the paragraph, exactly like
  \`**Definition:** ...\`, \`**Claim:** ...\`, \`**Theorem:** ...\` (also \`**Lemma:**\`, \`**Proof:**\`,
  \`**Corollary:**\`, \`**Example:**\`, \`**Remark:**\`). The app highlights these labels.
- Tables for comparisons, pros/cons and structured facts. Code in fenced blocks with a language tag (c, cpp, cuda,
  python, bash, x86asm). Algorithms in \`\`\`algorithm blocks (one step per line; \`$...$\` allowed).
- Q&A blocks after relevant sections, especially where the student had questions and where exam-relevant
  distinctions are made. Prefer five focused questions over two sprawling ones. Format:

> **Q: Short, specific question?**
> Brief, direct answer, one to four sentences. No hedging, no repeating the question.

- No filler. If the raw notes already say something clearly, keep it (lightly polished) rather than restating.

## Tone and goals
Direct and precise. Exam-first: structure for fast revision and a grade of 90 or more. Content mastery: geometric
or mechanistic understanding, not just formulas. Highlight definitions, distinctions, trade-offs and anything that
could be an exam question. Easy to memorise.`;

export const TYPE_ADDENDUM: Record<CourseType, string> = {
  practical: `## Course type: practical
Code-first. Prefer concrete code, memory diagrams, performance numbers and pitfalls over proofs. Every API,
pragma or instruction mentioned gets a one-line "what it does, when to use it, common mistake". Include small
runnable examples with a language tag; use \`\`\`algorithm for pseudocode.`,
  theoretical: `## Course type: theoretical
Proof-first. Every theorem gets a precise statement and a proof or proof sketch; every definition is exact and
followed by one example and one non-example. Reductions and constructions are spelled out step by step. Use
\`**Lemma:**\`, \`**Proof:**\`, \`**Corollary:**\` labels and \`\`\`algorithm blocks for constructions.`,
  mixed: `## Course type: mixed
Balance code and proofs: give precise statements for theory and concrete examples or code for practice. Use the
labels and blocks above as the material requires.`,
};

export interface SynthesisContext {
  courseName: string;
  courseDescription: string;
  courseType: CourseType;
  macros: { name: string; definition: string; arity: number }[];
  /** Deck titles with their slide text, numbered. */
  decks: { title: string; pages: { pageNo: number; text: string }[] }[];
  rawTitle: string;
  rawBody: string;
  /** Number of slide images attached after the text. */
  imageCount: number;
}

export function buildSynthesisPrompt(ctx: SynthesisContext): { system: string; user: string } {
  const macros =
    ctx.macros.length === 0
      ? 'No course macros.'
      : ctx.macros
          .map((m) =>
            m.arity > 0
              ? `\\newcommand{\\${m.name}}[${m.arity}]{${m.definition}}`
              : `\\newcommand{\\${m.name}}{${m.definition}}`,
          )
          .join('\n');
  const system = `${SYNTHESIS_SYSTEM}\n\n${TYPE_ADDENDUM[ctx.courseType]}\n\n## Course macros (MathJax \\newcommand)\n${macros}`;
  const parts: string[] = [];
  parts.push(`# Course\n${ctx.courseName}${ctx.courseDescription ? `\n${ctx.courseDescription}` : ''}`);
  for (const d of ctx.decks) {
    parts.push(
      `# Slides: ${d.title}\n${d.pages
        .map((p) => `## Slide ${p.pageNo}\n${p.text.trim() || '(no text; see image)'}`)
        .join('\n\n')}`,
    );
  }
  if (ctx.imageCount > 0)
    parts.push(
      `# Slide images\n${ctx.imageCount} slide image(s) follow this message in order; image k is slide k of the deck listed above (for several decks, in the order given).`,
    );
  parts.push(
    `# Raw notes: ${ctx.rawTitle}\n\n${ctx.rawBody.trim() || '(The raw note is empty; synthesize from the slides alone.)'}`,
  );
  parts.push('Return only the Markdown body of the synthesized note.');
  return { system, user: parts.join('\n\n---\n\n') };
}
