import { notFound } from 'next/navigation';
import { NoteView } from '@/components/notes/note-view';
import s from '@/components/notes/notes.module.css';
import { NotesRail } from '@/components/notes/notes-rail';
import { mergedMacros } from '@/lib/macros';
import { renderMarkdown } from '@/lib/markdown';
import { backlinksTo, getNote, getNoteBySlug, linkTargets, listNotes, unresolvedFrom } from '@/lib/notes';
import { getProjectBySlug } from '@/lib/projects';

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
  const note = (await getNoteBySlug(project.id, noteSlug)) ?? (await getNote(project.id, noteSlug));
  if (!note) notFound();
  const [notes, html, backlinks, unresolved, targets, macroRows] = await Promise.all([
    listNotes(project.id),
    renderMarkdown(note.body),
    backlinksTo(project.id, 'note', note.id),
    unresolvedFrom(project.id, 'note', note.id),
    linkTargets(project.id),
    mergedMacros(project.id),
  ]);
  return (
    <div className={s.layout}>
      <NotesRail slug={slug} notes={notes} activeSlug={note.slug} />
      <NoteView
        slug={slug}
        note={note}
        html={html}
        backlinks={backlinks}
        unresolved={unresolved}
        linkTargets={targets.filter((t) => t !== note.title)}
        editing={edit === '1'}
        macros={macroRows.map((m) => m.name)}
      />
    </div>
  );
}
