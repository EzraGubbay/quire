# Phase 2 plan: Lemida semantic typing + self-learning loop

## Context

Phase 1 (shipped `543a937`, merged 2026-10-26) pulls course files from Lemida and places each one by
**deterministic rules only** — file name, Moodle section heading, module type (`lib/lemida/classify.ts`).
Anything the rules can't place confidently lands in Documents and in the panel's **Needs review** list,
where one click re-files it. Every decision and every correction is already recorded in `lemida_files`
(`detected_kind`, `confidence`, `rule`, `corrected_kind`, plus `section_title`, `module_type`, `file_name`).

Phase 2 adds a cheap LLM as the fallback classifier, measures how much the deterministic layer already
gets right, and **feeds corrections back into deterministic rules** so that over time both the human and
the LLM drop out of the loop. User's guidance (2026-10-25):

> Deterministic first. Initial trial period: run the LLM classifier on **all** files right after the
> deterministic pass to measure deterministic coverage vs. LLM need — more expensive, but only at first.
> On a misclassification the LLM should produce new keywords / deterministic logic, balancing
> **generalization** (prevent future false negatives) vs. **specification** (prevent false positives).

Model: the cheapest OpenAI model already configured in Quire (`lib/ai/settings.ts`), bounded by the
existing monthly cap. Stay on OpenAI (DeepSeek steps remain documented for later).

## Pieces

1. **LLM classifier** (`lib/lemida/classify-llm.ts`). Input: file name, section heading, module type, and a
   short first-page text snippet (extract in `import.ts` for PDFs). Output (JSON, via the provider's
   `json` mode + zod): `{ kind, number?, confidence, reason }` over the existing `LEMIDA_KINDS`. Keep it
   one cheap call per file; record usage under a new `'lemida-classify'` task in the ledger.

2. **Two-pass import with a shadow/trial mode.** In `importLemidaFile`, after the deterministic result:
   - **Trial mode on** (first N days / until coverage is understood): always call the LLM too, store its
     verdict alongside the deterministic one, and when they disagree keep the higher-confidence one but
     log both. This measures deterministic precision/recall without changing behaviour much.
   - **Trial mode off** (steady state): only call the LLM when the deterministic result is `unknown` or
     below a confidence threshold. Store the trial flag + both verdicts on `lemida_files` (add
     `llm_kind`, `llm_confidence`, `llm_reason` columns, migration 0008).
   - A small settings flag (`settings.data.lemida.trial`) toggles it; the panel shows a coverage stat
     ("deterministic placed 82% unaided this week").

3. **Learning loop → promote rules.** A `lemida_rules` store (new table, migration 0008:
   `{ id, project_id?, kind, pattern, signal (file|section|module), weight, source (manual|llm|promoted),
   hits, misses, created }`). On each correction (`resolveReview` / `corrected_kind`) and on each
   trial-mode disagreement, a background job asks the LLM: *given this misplacement and the existing
   rules, propose a minimal new keyword/pattern that fixes it without over-triggering* — explicitly
   trading generalization (cover the plural/variant, avoid future false negatives) against specification
   (narrow enough to avoid false positives). Proposed rules are stored unapproved, scored against the
   back-catalogue in `lemida_files` (how many past rows they'd newly match correctly vs. wrongly), and
   either auto-promoted when clean or surfaced in the panel for a thumbs-up. `classify.ts` reads promoted
   rules in addition to its built-ins, so the deterministic layer keeps getting stronger.

4. **Measurement surface.** Panel section: deterministic-unaided %, LLM-needed %, correction rate, and
   the pending proposed rules. This is how we decide when to turn trial mode off.

## Verification

- Unit: LLM classifier against `AI_MOCK=1` (fixed JSON), rule-promotion scorer (a proposed pattern's
  hit/miss count over a fixture set of `lemida_files` rows), threshold/trial-mode gating.
- e2e: with the mock, an `unknown` deterministic result gets an LLM kind; a correction yields a proposed
  rule row; promoting it makes `classify.ts` place the next like-named file unaided.
- Backtest: replay recorded `lemida_files` rows through old vs. new rule sets; assert precision doesn't
  drop (no new false positives) while recall rises.

## Questions to resolve at Phase 2 kickoff (deferred from Phase 1 per the user)

- Trial-mode duration / exit criterion: fixed window, or "until deterministic-unaided ≥ X%"?
- Rule promotion: fully automatic when the backtest is clean, or always a one-tap approval?
- Scope of learned rules: per-course, per-course-type, or global? (Hebrew section names generalize well;
  idiosyncratic file names may not.)
- Snippet extraction cost/latency: extract first-page text for every PDF, or only when deterministic is
  unsure?
- Confidence threshold for calling the LLM in steady state.
