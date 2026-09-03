'use client';

import { Button } from '@ezragubbay/folio';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { type ActionState, saveAiSettingsAction, testConnectionAction } from '@/app/actions/ai';
import { clearProviderBlockAction } from '@/app/actions/chat';
import { Field, Input } from '@/components/ui/field';
import type { SpendSummary } from '@/lib/ai/ledger';
import type { AiSettings } from '@/lib/ai/settings';
import s from './settings.module.css';

export function AiPanel({
  settings,
  summary,
  configured,
}: {
  settings: AiSettings;
  summary: SpendSummary;
  configured: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(saveAiSettingsAction, {});
  const [test, setTest] = useState<ActionState | null>(null);
  const [testing, startTest] = useTransition();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  const maxDay = Math.max(0.01, ...summary.byDay.map((d) => d.cost));
  return (
    <section className={s.section}>
      <h2 className={s.h2}>AI</h2>
      <p className={s.help}>
        {configured
          ? 'The server has an API key.'
          : 'No OPENAI_API_KEY on the server; chat and discovery are off until it is set.'}{' '}
        Month-to-date spend is counted from every call; calls are refused once the cap is reached.
      </p>
      <div className={s.spend} data-testid="spend">
        <div className={s.spendBig}>
          <span>${summary.monthToDate.toFixed(2)}</span>
          <span className={s.help}>
            of ${summary.cap.toFixed(2)} this month · resets {summary.resetsOn}
          </span>
        </div>
        <div
          className={s.meter}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Math.min(1, summary.fraction)}
        >
          <div
            className={s.meterFill}
            data-state={summary.state}
            style={{ width: `${Math.min(100, summary.fraction * 100)}%` }}
          />
        </div>
        {summary.state === 'blocked' && (
          <p className={s.help}>
            The provider refused for budget reasons: {summary.blockedMessage}.{' '}
            <button
              type="button"
              className={s.linkBtn}
              onClick={() => clearProviderBlockAction().then(() => router.refresh())}
            >
              Retry
            </button>
          </p>
        )}
        <div className={s.spendCols}>
          <div>
            <h3 className={s.h3}>By task</h3>
            {summary.byTask.length === 0 ? (
              <p className={s.help}>No calls yet.</p>
            ) : (
              <table className={s.table}>
                <tbody>
                  {summary.byTask.map((t) => (
                    <tr key={t.task}>
                      <td>{t.task}</td>
                      <td className={s.num}>{t.calls}</td>
                      <td className={s.num}>${t.cost.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h3 className={s.h3}>By day</h3>
            <div className={s.spark} aria-hidden="true">
              {summary.byDay.map((d) => (
                <span
                  key={d.day}
                  className={s.bar}
                  title={`${d.day}: $${d.cost.toFixed(3)}`}
                  style={{ height: `${Math.max(4, (d.cost / maxDay) * 100)}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <form action={action} className={s.form}>
        <div className={s.row}>
          <Field label="Provider">
            <select name="provider" className={s.select} defaultValue={settings.provider}>
              <option value="openai">OpenAI</option>
              <option value="openai-compatible">OpenAI-compatible endpoint</option>
            </select>
          </Field>
          <Field
            label="Base URL (compatible endpoints only)"
            hint="e.g. https://api.deepseek.com/v1 or http://laptop:11434/v1"
          >
            <Input
              name="baseUrl"
              defaultValue={settings.baseUrl ?? ''}
              placeholder="leave empty for OpenAI"
            />
          </Field>
        </div>
        <div className={s.row3}>
          <Field label="Answer model" hint="Heavy questions">
            <Input name="answer" defaultValue={settings.models.answer} />
          </Field>
          <Field label="Light model" hint="Rewrites, ranking, summaries">
            <Input name="light" defaultValue={settings.models.light} />
          </Field>
          <Field label="Embeddings model">
            <Input name="embeddings" defaultValue={settings.models.embeddings} />
          </Field>
        </div>
        <div className={s.row}>
          <Field
            label="Monthly cap (USD)"
            hint="Calls are refused past this. Keep it below the provider-side hard limit."
          >
            <Input
              name="monthlyCapUsd"
              type="number"
              min={0}
              step="1"
              defaultValue={settings.monthlyCapUsd}
            />
          </Field>
          <Field label="Warn at (%)">
            <Input
              name="warnAtPercent"
              type="number"
              min={0}
              max={100}
              step="5"
              defaultValue={Math.round(settings.warnAtFraction * 100)}
            />
          </Field>
        </div>
        <h3 className={s.h3}>Prices, USD per 1M tokens</h3>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Model</th>
              <th>Input</th>
              <th>Cached input</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            {[
              ...new Set([
                settings.models.answer,
                settings.models.light,
                settings.models.embeddings,
                ...Object.keys(settings.prices),
              ]),
            ].map((m) => {
              const p = settings.prices[m] ?? { input: 0, cachedInput: 0, output: 0 };
              return (
                <tr key={m}>
                  <td>
                    <code>{m}</code>
                  </td>
                  {(['input', 'cachedInput', 'output'] as const).map((k) => (
                    <td key={k}>
                      <input
                        name={`price:${m}:${k}`}
                        type="number"
                        min={0}
                        step="0.01"
                        defaultValue={p[k]}
                        className={s.numInput}
                        aria-label={`${m} ${k} price`}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {state.error && <p className={s.help}>{state.error}</p>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button type="submit" variant="primary" size="sm" disabled={pending}>
            {pending ? 'Saving…' : 'Save AI settings'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testing}
            onClick={() => startTest(async () => setTest(await testConnectionAction()))}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          {state.ok && <span className={s.help}>Saved.</span>}
        </div>
        {test && (
          <p className={s.help}>
            {test.error
              ? `Connection failed: ${test.error}`
              : `Connected. Models available: ${test.models?.join(', ') ?? ''}`}
          </p>
        )}
      </form>
    </section>
  );
}
