import { notFound } from 'next/navigation';
import s from '@/components/notes/notes.module.css';
import { NotesRail } from '@/components/notes/notes-rail';
import { listNotes } from '@/lib/notes';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { slug } = await params;
  const { new: openNew } = await searchParams;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const [notes, read] = await Promise.all([listNotes(project.id), currentFeature('notes.read')]);
  // Phones: the list is the page; a note opens on its own route.
  if (read.platform === 'phone')
    return (
      <div className={s.layout} data-phone="true">
        <NotesRail slug={slug} notes={notes} openNew={openNew === '1'} phone />
      </div>
    );
  return (
    <div className={s.layout}>
      <NotesRail slug={slug} notes={notes} openNew={openNew === '1'} />
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
