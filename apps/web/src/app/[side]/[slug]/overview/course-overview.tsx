import { Card, CardRow, HighlightChip, Icon } from '@ezragubbay/folio';
import { ANNOTATION_TYPE_LABEL, PRACTICE_EXAMS_REQUIRED } from '@quire/shared';
import {
  BookOpenCheck,
  ClipboardList,
  ExternalLink,
  GraduationCap,
  Presentation,
  StickyNote,
  Users,
} from 'lucide-react';
import NextLink from 'next/link';
import { RereadList } from '@/components/tests/reread-list';
import type { Project } from '@/db/schema';
import { fmtDue } from '@/lib/homework';
import type { CourseOverviewData } from '@/lib/overview';
import { projectMeta } from '@/lib/projects';
import s from './overview.module.css';

const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const ago = (d: Date) => {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return fmt(d);
};
const TYPE_LABEL = { practical: 'Practical', theoretical: 'Theoretical', mixed: 'Mixed' } as const;

export function CourseOverview({
  project,
  base,
  o,
}: {
  project: Project;
  base: string;
  o: CourseOverviewData;
}) {
  const meta = projectMeta(project);
  const triweeklyDue =
    o.practiceExams >= PRACTICE_EXAMS_REQUIRED &&
    (o.weeksSinceTriweekly === null || o.weeksSinceTriweekly >= 3);
  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <h1 className={s.title}>{project.name}</h1>
        <p className={s.meta}>
          {[meta.code, meta.semester, TYPE_LABEL[meta.type], `started ${fmt(project.createdAt)}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {project.description && <p className={s.desc}>{project.description}</p>}
        {meta.links.length > 0 && (
          <p className={s.links}>
            {meta.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className={s.link}>
                <Icon icon={ExternalLink} size={16} /> {l.label}
              </a>
            ))}
          </p>
        )}
        <dl className={s.stats}>
          <div>
            <dt>Lectures</dt>
            <dd>{o.counts.lectures}</dd>
          </div>
          <div>
            <dt>Recitations</dt>
            <dd>{o.counts.recitations}</dd>
          </div>
          <div>
            <dt>Notes</dt>
            <dd>{o.counts.notes}</dd>
          </div>
          <div>
            <dt>Open homework</dt>
            <dd>{o.counts.openAssignments}</dd>
          </div>
        </dl>
      </header>
      <div className={s.grid}>
        <Card
          title="Due next"
          action={
            <NextLink href={`${base}/homework`} className={s.more}>
              Homework
            </NextLink>
          }
        >
          {o.nextDue.length === 0 ? (
            <p className={s.muted}>Nothing open. Add an assignment from the Homework tab.</p>
          ) : (
            o.nextDue.map((a) => (
              <CardRow
                key={a.id}
                icon={<Icon icon={ClipboardList} />}
                title={<NextLink href={`${base}/homework/${a.id}`}>{`#${a.number} ${a.title}`}</NextLink>}
                meta={[a.dueAt ? `due ${fmtDue(a.dueAt)}` : 'no due date', a.status.replace('_', ' ')].join(
                  ' · ',
                )}
              />
            ))
          )}
        </Card>
        <Card
          title="Latest sessions"
          action={
            <NextLink href={`${base}/lectures`} className={s.more}>
              Lectures
            </NextLink>
          }
        >
          {!o.latestLecture && !o.latestRecitation ? (
            <p className={s.muted}>Drop a deck on the Lectures tab to start.</p>
          ) : (
            <>
              {o.latestLecture && (
                <CardRow
                  icon={<Icon icon={Presentation} />}
                  title={
                    <NextLink href={`${base}/lectures/${o.latestLecture.id}`}>
                      Lecture {o.latestLecture.number}
                      {o.latestLecture.title ? ` — ${o.latestLecture.title}` : ''}
                    </NextLink>
                  }
                  meta={o.latestLecture.date ?? ''}
                />
              )}
              {o.latestRecitation && (
                <CardRow
                  icon={<Icon icon={Users} />}
                  title={
                    <NextLink href={`${base}/recitations/${o.latestRecitation.id}`}>
                      Recitation {o.latestRecitation.number}
                      {o.latestRecitation.title ? ` — ${o.latestRecitation.title}` : ''}
                    </NextLink>
                  }
                  meta={o.latestRecitation.date ?? ''}
                />
              )}
            </>
          )}
        </Card>
        <Card
          title="To re-read"
          action={
            <NextLink href={`${base}/tests`} className={s.more}>
              Tests
            </NextLink>
          }
        >
          {triweeklyDue && (
            <p className={s.nudge}>
              <Icon icon={GraduationCap} />{' '}
              {o.weeksSinceTriweekly === null
                ? 'No tri-weekly test yet and enough practice exams: generate one.'
                : `${o.weeksSinceTriweekly} weeks since the last tri-weekly test.`}
            </p>
          )}
          {o.reread.length === 0 ? (
            <p className={s.muted}>
              {o.practiceExams < PRACTICE_EXAMS_REQUIRED
                ? `Nothing to re-read. ${o.practiceExams}/${PRACTICE_EXAMS_REQUIRED} practice exams for tri-weekly tests.`
                : 'Nothing to re-read. Failed test questions put note sections here.'}
            </p>
          ) : (
            <RereadList items={o.reread} base={base} compact />
          )}
        </Card>
        <Card title="Open questions" action={<span className={s.more}>{o.openItems.length}</span>}>
          {o.openItems.length === 0 ? (
            <p className={s.muted}>Question and Todo annotations on slides will show up here.</p>
          ) : (
            o.openItems.map((a) => (
              <CardRow
                key={a.id}
                title={
                  a.documentId ? (
                    <NextLink href={`${base}/documents/${a.documentId}`}>
                      {a.body || a.quote || ANNOTATION_TYPE_LABEL[a.type]}
                    </NextLink>
                  ) : (
                    a.body || ANNOTATION_TYPE_LABEL[a.type]
                  )
                }
                meta={[a.documentTitle, a.pageNo ? `slide ${a.pageNo}` : null].filter(Boolean).join(' · ')}
                trailing={<HighlightChip kind={a.type === 'question' ? 'question' : 'todo'} />}
              />
            ))
          )}
        </Card>
        <Card
          title="Recent notes"
          action={
            <NextLink href={`${base}/notes`} className={s.more}>
              All
            </NextLink>
          }
          className={s.wide}
        >
          {o.recentNotes.length === 0 ? (
            <p className={s.muted}>No notes yet. Open a lecture and start typing beside the slides.</p>
          ) : (
            o.recentNotes.map((n) => (
              <CardRow
                key={n.id}
                icon={<Icon icon={n.status === 'generating' ? BookOpenCheck : StickyNote} />}
                title={<NextLink href={`${base}/notes/${n.slug}`}>{n.title}</NextLink>}
                meta={n.status === 'generating' ? 'synthesizing…' : ago(n.updatedAt)}
              />
            ))
          )}
        </Card>
      </div>
    </div>
  );
}
