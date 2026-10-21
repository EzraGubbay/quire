'use client';

import { Button } from '@ezragubbay/folio';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import { createFolderAction } from '@/app/actions/documents';
import { createNoteFolderAction } from '@/app/actions/notes';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import type { Folder } from '@/db/schema';
import s from './ui.module.css';

interface State {
  error?: string;
  ok?: boolean;
}

/** New folder for documents or notes; builtin folders can be parents too. */
export function NewFolderDialog({
  slug,
  folders,
  scope = 'documents',
  open,
  onClose,
}: {
  slug: string;
  folders: Folder[];
  scope?: 'documents' | 'notes';
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<State, FormData>(
    scope === 'notes' ? createNoteFolderAction : createFolderAction,
    {},
  );
  useEffect(() => {
    if (state.ok) {
      onClose();
      router.refresh();
    }
  }, [state.ok, onClose, router]);
  return (
    <Dialog open={open} title="New folder" onClose={onClose}>
      <form action={action} className={s.dialogForm}>
        <input type="hidden" name="slug" value={slug} />
        <Field label="Name" error={state.error}>
          <Input name="name" required maxLength={80} autoFocus />
        </Field>
        <Field label="Inside">
          <select name="parentId" className={s.input} defaultValue="">
            <option value="">Top level</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            Create folder
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
