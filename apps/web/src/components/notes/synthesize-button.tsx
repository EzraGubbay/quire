'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { estimateSynthesisAction, synthesizeAction } from '@/app/actions/notes';
import { useProject } from '@/components/project-context';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import type { Note } from '@/db/schema';
import type { SynthesisEstimate } from '@/lib/ai/synthesis';
import s from './notes.module.css';

/** "Synthesize" on a raw note: asks for a title, shows the cost estimate, creates the target note and starts the model. */
export function SynthesizeButton({
  slug,
  note,
  size = 'sm',
  onStarted,
}: {
  slug: string;
  note: Note;
  size?: 'sm' | 'md';
  onStarted?: () => void;
}) {
  const router = useRouter();
  const { base } = useProject();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [estimate, setEstimate] = useState<SynthesisEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!open) return;
    setEstimate(null);
    setError(null);
    setTitle(note.title.replace(/\s+notes?$/i, '').replace(/^raw\s*[:\-–]\s*/i, '') || note.title);
    estimateSynthesisAction(slug, note.id)
      .then(setEstimate)
      .catch((e: Error) => setError(e.message));
  }, [open, slug, note.id, note.title]);
  const submit = () =>
    start(async () => {
      const res = await synthesizeAction(slug, note.id, title);
      if (res.error) {
        setError(res.error);
        return;
      }
      setOpen(false);
      onStarted?.();
      if (res.noteSlug) router.push(`${base}/notes/${res.noteSlug}`);
      else router.refresh();
    });
  return (
    <>
      <Button variant="secondary" size={size} icon={<Icon icon={Sparkles} />} onClick={() => setOpen(true)}>
        Synthesize
      </Button>
      <Dialog open={open} title="Synthesize this note" onClose={() => setOpen(false)}>
        <div className={s.form}>
          <Field label="Title of the synthesized note" error={error ?? undefined}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && !pending && submit()}
            />
          </Field>
          <p className={s.estimate} data-testid="synthesis-estimate">
            {estimate
              ? `Sends the raw note${estimate.slides ? ` and ${estimate.slides} slide image${estimate.slides === 1 ? '' : 's'}` : ''} to ${estimate.model}. About $${estimate.costUsd.toFixed(2)} (${Math.round(estimate.inputTokens / 1000)}k in, up to ${Math.round(estimate.outputTokens / 1000)}k out). One shot, no follow-up: the note appears when the model is done.`
              : error
                ? ''
                : 'Estimating…'}
          </p>
          <DialogActions>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={pending || !title.trim() || !estimate}
              onClick={submit}
            >
              {pending ? 'Starting…' : 'Synthesize'}
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </>
  );
}
