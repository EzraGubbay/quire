import { notFound } from 'next/navigation';
import s from '@/components/notes/notes.module.css';
import { NotesRail } from '@/components/notes/notes-rail';
import { listNotes } from '@/lib/notes';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function NotesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const notes = await listNotes(project.id);
  return (
    <div className={s.layout}>
      <NotesRail slug={slug} notes={notes} />
      <div className={s.main}>
        <div className={s.empty}>
          <h2
            style={{
              font: '600 20px/1.2 var(--eg-font-heading)',
              color: 'var(--eg-text)',
              margin: '0 0 8px',
            }}
          >
            Notes
          </h2>
          <p style={{ margin: 0 }}>
            Short linked pages with [[wiki links]], math, and backlinks. Pick one on the left or create a new
            one.
          </p>
        </div>
      </div>
    </div>
  );
}
