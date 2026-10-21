import { notFound } from 'next/navigation';
import { SessionPage } from '@/components/sessions/session-page';
import { listAnnotations } from '@/lib/annotations';
import { mergedMacros } from '@/lib/macros';
import { linkTargets, sessionNote } from '@/lib/notes';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug, requireKind } from '@/lib/projects';
import { getSession } from '@/lib/sessions';

/** Shared by the lecture and recitation detail routes. */
export async function SessionRoute({
  slug,
  sessionId,
  docId,
}: {
  slug: string;
  sessionId: string;
  /** `?doc=` picks one of several attached decks. */
  docId?: string;
}) {
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const session = await getSession(project.id, sessionId);
  if (!session) notFound();
  const withFile = session.documents.filter((d) => d.filePath);
  const doc =
    (docId ? session.documents.find((d) => d.id === docId) : undefined) ??
    withFile[0] ??
    session.documents[0] ??
    null;
  const [annotations, note, targets, macroRows, split, viewer, annotate, synth] = await Promise.all([
    doc ? listAnnotations(project.id, doc.id) : Promise.resolve([]),
    sessionNote(project.id, session.id),
    linkTargets(project.id),
    mergedMacros(project.id),
    currentFeature('sessions.split'),
    currentFeature('documents.viewer'),
    currentFeature('documents.annotate'),
    currentFeature('notes.synthesize'),
  ]);
  return (
    <SessionPage
      slug={slug}
      session={session}
      doc={doc}
      annotations={annotations}
      note={note ?? null}
      linkTargets={targets}
      macros={macroRows.map((m) => m.name)}
      split={split.level !== 'off'}
      canAnnotate={annotate.level !== 'off'}
      lite={viewer.level === 'lite'}
      platform={viewer.platform}
      canSynthesize={synth.level !== 'off'}
    />
  );
}
