'use client';

import { Button } from '@ezragubbay/folio';
import NextLink from 'next/link';
import { useState, useTransition } from 'react';
import { addCandidateAction, discoverAction } from '@/app/actions/discover';
import { SpendBanner } from '@/components/chat/spend-banner';
import type { Candidate, DiscoverResult } from '@/lib/ai/discover';
import type { SpendSummary } from '@/lib/ai/ledger';
import s from './discover.module.css';

export function DiscoverView({
  slug,
  summary,
  configured,
  initialQuery = '',
}: {
  slug: string;
  summary: SpendSummary;
  configured: boolean;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [added, setAdded] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const disabled = !configured || summary.state === 'capped' || summary.state === 'blocked';

  const run = () => {
    if (!query.trim()) return;
    setError(null);
    start(async () => {
      const res = await discoverAction(slug, query);
      if ('error' in res) setError(res.error);
      else setResult(res);
    });
  };
  const add = (c: Candidate, as: 'document' | 'source') => {
    setAdding(c.id);
    start(async () => {
      const res = await addCandidateAction(
        slug,
        {
          title: c.title,
          authors: c.authors,
          year: c.year,
          abstract: c.abstract,
          url: c.url,
          arxivId: c.arxivId,
          doi: c.doi,
          pdfUrl: c.pdfUrl,
        },
        as,
      );
      setAdding(null);
      if ('error' in res) setError(res.error);
      else setAdded((m) => ({ ...m, [c.id]: res.href }));
    });
  };

  return (
    <div className={s.wrap}>
      <h1 className={s.title}>Discover</h1>
      <p className={s.help}>
        Describe what you are looking for. Quire searches arXiv and Semantic Scholar, drops what the project
        already has, and ranks the rest with a short reason each. Anything you add goes through the normal
        import.
      </p>
      <SpendBanner summary={summary} configured={configured} />
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input
          className={s.input}
          aria-label="What are you looking for?"
          placeholder="e.g. learned routing for sparse attention with variational bounds"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={pending || !query.trim()}>
          {pending && !adding ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {error && <p className={s.reason}>{error}</p>}
      {result && (
        <>
          <p className={s.note}>
            {result.candidates.length} candidates
            {result.ranked ? ', ranked by the light model' : ', ordered by citations'}
            {disabled ? ' (ranking off: AI unavailable)' : ''}
            {result.note ? ` · ${result.note}` : ''}
          </p>
          <div className={s.list}>
            {result.candidates.map((c) => (
              <article key={c.id} className={s.card} data-known={c.alreadyInProject} data-testid="candidate">
                <h2 className={s.cardTitle}>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title}
                  </a>
                </h2>
                <div className={s.meta}>
                  {c.authors.length > 0 && (
                    <span>
                      {c.authors.slice(0, 4).join(', ')}
                      {c.authors.length > 4 ? ' et al.' : ''}
                    </span>
                  )}
                  {c.year && <span>{c.year}</span>}
                  {c.citations != null && <span>{c.citations} citations</span>}
                  {c.arxivId && <span>arXiv:{c.arxivId}</span>}
                  <span>
                    {c.origin === 'arxiv'
                      ? 'arXiv'
                      : c.origin === 'semanticscholar'
                        ? 'Semantic Scholar'
                        : 'web'}
                  </span>
                </div>
                {c.reason && <p className={s.reason}>{c.reason}</p>}
                {c.abstract && <p className={s.abstract}>{c.abstract}</p>}
                <div className={s.actions}>
                  {c.alreadyInProject ? (
                    <span className={s.added}>Already in this project</span>
                  ) : added[c.id] ? (
                    <NextLink href={added[c.id] ?? '#'} className={s.added}>
                      Added · open
                    </NextLink>
                  ) : (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={adding === c.id}
                        onClick={() => add(c, 'document')}
                      >
                        {adding === c.id
                          ? 'Adding…'
                          : c.pdfUrl
                            ? 'Add paper (fetch PDF)'
                            : 'Add paper record'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={adding === c.id}
                        onClick={() => add(c, 'source')}
                      >
                        Add as source
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
