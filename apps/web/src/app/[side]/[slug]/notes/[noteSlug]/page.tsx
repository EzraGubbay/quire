import { notFound } from 'next/navigation';
import { NoteView } from '@/components/notes/note-view';
import s from '@/components/notes/notes.module.css';
import { NotesRail } from '@/components/notes/notes-rail';
import { synthesizedFrom, synthesizedInto } from '@/lib/ai/synthesis';
import { listFolders } from '@/lib/documents';
import { mergedMacros } from '@/lib/macros';
import { renderMarkdown } from '@/lib/markdown';
import { backlinksTo, getNote, getNoteBySlug, linkTargets, listNotes, unresolvedFrom } from '@/lib/notes';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug, projectBase } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function NotePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; noteSlug: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { slug, noteSlug } = await params;
  const { edit } = await searchParams;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const base = projectBase(project);
  const note = (await getNoteBySlug(project.id, noteSlug)) ?? (await getNote(project.id, noteSlug));
  const [editFeature, synthFeature] = await Promise.all([
    currentFeature('notes.edit'),
    currentFeature('notes.synthesize'),
  ]);
  const editLevel = editFeature.level;
  const phone = editFeature.platform === 'phone';
  if (!note) notFound();
  const [notes, folders, html, backlinks, unresolved, targets, macroRows, from, into] = await Promise.all([
    listNotes(project.id),
    listFolders(project.id, 'notes'),
    renderMarkdown(note.body),
    backlinksTo(project.id, 'note', note.id),
    unresolvedFrom(project.id, 'note', note.id),
    linkTargets(project.id),
    mergedMacros(project.id),
    synthesizedFrom(project.id, note.id),
    synthesizedInto(project.id, note.id),
  ]);
  const folder = folders.find((f) => f.id === note.folderId);
  return (
    <div className={s.layout} data-phone={phone ? 'true' : undefined}>
      {!phone && <NotesRail slug={slug} notes={notes} folders={folders} activeSlug={note.slug} />}
      <NoteView
        backHref={phone ? `${base}/notes` : undefined}
        slug={slug}
        note={note}
        html={html}
        backlinks={backlinks}
        unresolved={unresolved}
        linkTargets={targets.filter((t) => t !== note.title)}
        editing={edit === '1' && editLevel !== 'off' && note.status !== 'generating'}
        editLevel={editLevel}
        macros={macroRows.map((m) => m.name)}
        course={project.kind === 'course'}
        canSynthesize={
          project.kind === 'course' && synthFeature.level !== 'off' && folder?.builtin !== 'synthesized'
        }
        synthesizedFrom={from ? { title: from.title, slug: from.slug } : null}
        synthesizedInto={into.map((n) => ({ id: n.id, title: n.title, slug: n.slug, status: n.status }))}
        rawCandidates={
          project.kind === 'course' && folder?.builtin === 'synthesized'
            ? notes
                .filter((n) => n.id !== note.id && n.status === 'ready')
                .map((n) => ({ id: n.id, title: n.title }))
            : []
        }
      />
    </div>
  );
}
