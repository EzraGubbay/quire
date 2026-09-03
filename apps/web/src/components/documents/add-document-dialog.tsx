'use client';

import { Button } from '@ezragubbay/folio';
import { useActionState, useRef, useState } from 'react';
import {
  type ActionState,
  createMarkdownAction,
  importReferenceAction,
  uploadPdfAction,
} from '@/app/actions/documents';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import type { Folder } from '@/db/schema';
import { parseReference } from '@/lib/ingest';
import s from './documents.module.css';

type Mode = 'upload' | 'reference' | 'markdown';

export function AddDocumentDialog({
  slug,
  folders,
  defaultFolderId,
  open,
  onClose,
}: {
  slug: string;
  folders: Folder[];
  defaultFolderId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('upload');
  return (
    <Dialog open={open} title="Add document" onClose={onClose}>
      <div className={s.tabs} role="tablist">
        {(
          [
            ['upload', 'Upload PDF'],
            ['reference', 'arXiv / DOI / link'],
            ['markdown', 'New Markdown'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={s.tab}
            data-active={mode === m}
            onClick={() => setMode(m)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'upload' ? (
        <UploadForm slug={slug} folders={folders} defaultFolderId={defaultFolderId} onCancel={onClose} />
      ) : mode === 'reference' ? (
        <ReferenceForm slug={slug} folders={folders} defaultFolderId={defaultFolderId} onCancel={onClose} />
      ) : (
        <MarkdownForm slug={slug} folders={folders} defaultFolderId={defaultFolderId} onCancel={onClose} />
      )}
    </Dialog>
  );
}

function FolderSelect({ folders, defaultFolderId }: { folders: Folder[]; defaultFolderId: string | null }) {
  return (
    <Field label="Folder">
      <select name="folderId" className={s.chip} defaultValue={defaultFolderId ?? ''}>
        <option value="">Unfiled</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function UploadForm({
  slug,
  folders,
  defaultFolderId,
  onCancel,
}: {
  slug: string;
  folders: Folder[];
  defaultFolderId: string | null;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(uploadPdfAction, {});
  const [fileName, setFileName] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form action={action} className={s.form}>
      <input type="hidden" name="slug" value={slug} />
      <div
        className={s.dropzone}
        data-over={over}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f && inputRef.current) {
            const dt = new DataTransfer();
            dt.items.add(f);
            inputRef.current.files = dt.files;
            setFileName(f.name);
          }
        }}
      >
        <strong>{fileName ?? 'Drop a PDF here'}</strong>
        <span>or</span>
        <label>
          <Button type="button" variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
          <input
            ref={inputRef}
            name="file"
            type="file"
            accept="application/pdf,.pdf"
            required
            hidden
            aria-label="PDF file"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
        </label>
      </div>
      <FolderSelect folders={folders} defaultFolderId={defaultFolderId} />
      {state.error && (
        <p className={s.muted} role="alert">
          {state.error}
        </p>
      )}
      <DialogActions>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !fileName}>
          {pending ? 'Uploading and reading…' : 'Add PDF'}
        </Button>
      </DialogActions>
    </form>
  );
}

function MarkdownForm({
  slug,
  folders,
  defaultFolderId,
  onCancel,
}: {
  slug: string;
  folders: Folder[];
  defaultFolderId: string | null;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createMarkdownAction, {});
  return (
    <form action={action} className={s.form}>
      <input type="hidden" name="slug" value={slug} />
      <Field label="Title" error={state.error}>
        <Input
          name="title"
          required
          maxLength={200}
          autoFocus
          placeholder="Summary of sparse attention methods"
        />
      </Field>
      <FolderSelect folders={folders} defaultFolderId={defaultFolderId} />
      <DialogActions>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          Create document
        </Button>
      </DialogActions>
    </form>
  );
}

function ReferenceForm({
  slug,
  folders,
  defaultFolderId,
  onCancel,
}: {
  slug: string;
  folders: Folder[];
  defaultFolderId: string | null;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(importReferenceAction, {});
  const [value, setValue] = useState('');
  const ref = parseReference(value);
  const hint = !value.trim()
    ? 'An arXiv id or URL, a DOI, or a direct link to a PDF.'
    : ref?.kind === 'arxiv'
      ? `arXiv ${ref.id}: metadata and PDF from arxiv.org`
      : ref?.kind === 'doi'
        ? `DOI ${ref.doi}: metadata from Crossref, PDF if openly available`
        : ref?.kind === 'url'
          ? 'Direct link: the PDF is downloaded and read'
          : 'Not recognised yet';
  return (
    <form action={action} className={s.form}>
      <input type="hidden" name="slug" value={slug} />
      <Field label="Reference" hint={hint} error={state.error}>
        <Input
          name="reference"
          required
          autoFocus
          placeholder="2609.01234 · https://arxiv.org/abs/… · 10.1000/xyz · https://…/paper.pdf"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <FolderSelect folders={folders} defaultFolderId={defaultFolderId} />
      <DialogActions>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !ref}>
          {pending ? 'Fetching…' : 'Add'}
        </Button>
      </DialogActions>
    </form>
  );
}
