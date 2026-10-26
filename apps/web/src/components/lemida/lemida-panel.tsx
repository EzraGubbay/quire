'use client';

import { Button, Card, CardRow, Icon } from '@ezragubbay/folio';
import type { LemidaFileStatus, LemidaKind, LemidaSessionStatus } from '@quire/shared';
import { LogIn, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  deleteMappingAction,
  dismissReviewAction,
  enqueueProbeAction,
  enqueueSignInAction,
  enqueueSyncAction,
  mapCourseAction,
  resolveReviewAction,
  toggleCourseSyncAction,
} from '@/app/actions/lemida';
import { Field, Input } from '@/components/ui/field';
import { PollWhile } from '@/components/ui/poll-while';
import { useToast } from '@/components/ui/toast';
import type { LemidaState } from '@/lib/lemida/state';
import s from './lemida-panel.module.css';

interface Mapping {
  id: string;
  projectId: string;
  courseName: string;
  lemidaUrl: string;
  label: string;
  enabled: boolean;
  lastSyncedAt: string | null;
}
interface CourseOpt {
  id: string;
  name: string;
  suggestedUrl: string;
}
interface ReviewRow {
  id: string;
  fileName: string;
  courseName: string;
  detectedKind: LemidaKind;
  confidence: number;
  sectionTitle: string;
}
interface RecentRow {
  id: string;
  fileName: string;
  courseName: string;
  detectedKind: LemidaKind;
  status: LemidaFileStatus;
  createdAt: string;
}

export interface LemidaPanelProps {
  state: LemidaState;
  online: boolean;
  active: boolean;
  mappings: Mapping[];
  courses: CourseOpt[];
  review: ReviewRow[];
  recent: RecentRow[];
}

const SESSION_LABEL: Record<LemidaSessionStatus, string> = {
  valid: 'Signed in',
  expired: 'Signed out — sign in needed',
  unknown: 'Unknown',
};

const REVIEW_KINDS: { kind: LemidaKind; label: string }[] = [
  { kind: 'lecture', label: 'Lecture' },
  { kind: 'recitation', label: 'Recitation' },
  { kind: 'homework', label: 'Homework' },
  { kind: 'exam', label: 'Practice exam' },
  { kind: 'book', label: 'Course material' },
  { kind: 'other', label: 'Document' },
];

const KIND_LABEL: Record<LemidaKind, string> = {
  lecture: 'Lecture',
  recitation: 'Recitation',
  homework: 'Homework',
  exam: 'Practice exam',
  book: 'Course material',
  other: 'Document',
  unknown: 'Unsorted',
};

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return 'never';
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

export function LemidaPanel(props: LemidaPanelProps) {
  const { state, online, mappings, courses, review, recent } = props;
  const router = useRouter();
  const { toast } = useToast();
  const [, start] = useTransition();

  const run = (fn: () => Promise<unknown>, done?: string) =>
    start(async () => {
      await fn();
      router.refresh();
      if (done) toast({ message: done });
    });

  return (
    <div className={s.wrap}>
      <PollWhile active={props.active} />
      <header className={s.head}>
        <div>
          <h1 className={s.title}>Lemida sync</h1>
          <p className={s.sub}>
            You sign in to Lemida by hand once a day; the agent on your Mac then reuses that session to pull
            new course files into Quire. Nothing is downloaded until you sign in.
          </p>
        </div>
      </header>

      <Card title="Connection">
        <div className={s.statusGrid}>
          <div className={s.statusItem}>
            <Icon icon={online ? Wifi : WifiOff} />
            <div>
              <div className={s.statusName} data-ok={online}>
                {online ? 'Agent online' : 'Agent offline'}
              </div>
              <div className={s.statusMeta}>last seen {ago(state.agentSeenAt)}</div>
            </div>
          </div>
          <div className={s.statusItem}>
            <span className={s.dot} data-session={state.sessionStatus} />
            <div>
              <div className={s.statusName}>{SESSION_LABEL[state.sessionStatus]}</div>
              <div className={s.statusMeta}>checked {ago(state.checkedAt)}</div>
            </div>
          </div>
        </div>
        <div className={s.actions}>
          <Button
            variant="primary"
            icon={<Icon icon={LogIn} />}
            onClick={() => run(enqueueSignInAction, 'Opening Lemida login on your Mac…')}
          >
            Sign in to Lemida
          </Button>
          <Button
            variant="secondary"
            icon={<Icon icon={RefreshCw} />}
            onClick={() => run(enqueueProbeAction, 'Checking session…')}
          >
            Check session
          </Button>
          <Button
            variant="secondary"
            icon={<Icon icon={RefreshCw} />}
            onClick={() => run(enqueueSyncAction, 'Sync queued')}
            disabled={mappings.filter((m) => m.enabled).length === 0}
          >
            Sync now
          </Button>
        </div>
        {state.lastSyncSummary && (
          <p className={s.syncLine}>
            Last sync {ago(state.lastSyncAt)}: {state.lastSyncSummary}
          </p>
        )}
        {!online && (
          <p className={s.hint}>
            The agent isn’t reporting in. Start it on your Mac (<code>tools/lemida-agent</code>), then the
            buttons above will take effect on the next poll.
          </p>
        )}
      </Card>

      <ReviewCard review={review} run={run} />

      <CourseMappingCard mappings={mappings} courses={courses} run={run} />

      <Card title="Recent" action={<span className={s.count}>{recent.length}</span>}>
        {recent.length === 0 ? (
          <p className={s.empty}>No files pulled yet.</p>
        ) : (
          recent.map((r) => (
            <CardRow
              key={r.id}
              title={r.fileName}
              meta={`${r.courseName} · ${KIND_LABEL[r.detectedKind]} · ${ago(r.createdAt)}`}
              trailing={
                <span className={s.badge} data-status={r.status}>
                  {r.status.replace('_', ' ')}
                </span>
              }
            />
          ))
        )}
      </Card>
    </div>
  );
}

function ReviewCard({
  review,
  run,
}: {
  review: ReviewRow[];
  run: (fn: () => Promise<unknown>, done?: string) => void;
}) {
  return (
    <Card title="Needs review" action={<span className={s.count}>{review.length}</span>}>
      {review.length === 0 ? (
        <p className={s.empty}>Nothing to sort — every pulled file was placed automatically.</p>
      ) : (
        <ul className={s.reviewList}>
          {review.map((r) => (
            <li key={r.id} className={s.reviewItem}>
              <div className={s.reviewHead}>
                <span className={s.fileName}>{r.fileName}</span>
                <span className={s.reviewMeta}>
                  {r.courseName}
                  {r.sectionTitle ? ` · ${r.sectionTitle}` : ''}
                </span>
              </div>
              <div className={s.reviewBtns}>
                {REVIEW_KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    className={s.kindBtn}
                    onClick={() => run(() => resolveReviewAction(r.id, k.kind), `Filed as ${k.label}`)}
                  >
                    {k.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={s.dismissBtn}
                  onClick={() => run(() => dismissReviewAction(r.id), 'Dismissed')}
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CourseMappingCard({
  mappings,
  courses,
  run,
}: {
  mappings: Mapping[];
  courses: CourseOpt[];
  run: (fn: () => Promise<unknown>, done?: string) => void;
}) {
  const [courseId, setCourseId] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const pickCourse = (id: string) => {
    setCourseId(id);
    const c = courses.find((x) => x.id === id);
    if (c?.suggestedUrl && !url) setUrl(c.suggestedUrl);
  };

  const submit = () => {
    setError('');
    if (!courseId) return setError('Pick a course.');
    run(async () => {
      const res = await mapCourseAction(courseId, url);
      if (res.error) setError(res.error);
      else {
        setUrl('');
        setCourseId('');
      }
    });
  };

  return (
    <Card title="Courses" action={<span className={s.count}>{mappings.length}</span>}>
      {mappings.length === 0 ? (
        <p className={s.empty}>No courses linked yet. Link one to its Lemida page below.</p>
      ) : (
        mappings.map((m) => (
          <CardRow
            key={m.id}
            title={
              <NextLink href={m.lemidaUrl} target="_blank" rel="noopener noreferrer">
                {m.courseName}
              </NextLink>
            }
            meta={`synced ${ago(m.lastSyncedAt)}`}
            trailing={
              <span className={s.mapTrail}>
                <label className={s.toggle}>
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={() => run(() => toggleCourseSyncAction(m.id, !m.enabled))}
                  />
                  <span>sync</span>
                </label>
                <button
                  type="button"
                  className={s.iconBtn}
                  aria-label={`Unlink ${m.courseName}`}
                  title="Unlink"
                  onClick={() => run(() => deleteMappingAction(m.id), 'Unlinked')}
                >
                  <Icon icon={Trash2} />
                </button>
              </span>
            }
          />
        ))
      )}
      <div className={s.mapForm}>
        <select
          className={s.select}
          value={courseId}
          onChange={(e) => pickCourse(e.target.value)}
          aria-label="Course"
        >
          <option value="">Choose a course…</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Field label="" error={error}>
          <Input
            placeholder="https://lemida.biu.ac.il/course/view.php?id=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Button variant="secondary" onClick={submit}>
          Link
        </Button>
      </div>
    </Card>
  );
}
