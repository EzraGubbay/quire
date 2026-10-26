import { AppShell } from '@/components/app-shell';
import { LemidaPanel } from '@/components/lemida/lemida-panel';
import { hasActiveCommand } from '@/lib/lemida/commands';
import { listMappings } from '@/lib/lemida/courses';
import { listReviewQueue, recentFiles } from '@/lib/lemida/files';
import { agentOnline, getLemidaState } from '@/lib/lemida/state';
import { listProjects, projectMeta } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/** A Lemida/Moodle URL already saved on the course's links, to prefill the mapping form. */
function moodleLink(meta: ReturnType<typeof projectMeta>): string {
  const hit = meta.links.find(
    (l) => /lemida\.biu\.ac\.il/i.test(l.url) || /moodle|lemida|למדה/i.test(l.label),
  );
  return hit?.url ?? '';
}

export default async function LemidaSyncPage() {
  const [state, mappings, review, recent, courses, active] = await Promise.all([
    getLemidaState(),
    listMappings(),
    listReviewQueue(),
    recentFiles(20),
    listProjects({ kind: 'course', status: 'active' }),
    hasActiveCommand(),
  ]);

  return (
    <AppShell>
      <LemidaPanel
        state={state}
        online={agentOnline(state)}
        active={active}
        mappings={mappings.map((m) => ({
          id: m.id,
          projectId: m.projectId,
          courseName: m.project.name,
          lemidaUrl: m.lemidaUrl,
          label: m.label,
          enabled: m.enabled,
          lastSyncedAt: m.lastSyncedAt?.toISOString() ?? null,
        }))}
        courses={courses.map((c) => ({
          id: c.id,
          name: c.name,
          suggestedUrl: moodleLink(projectMeta(c)),
        }))}
        review={review.map((f) => ({
          id: f.id,
          fileName: f.fileName,
          courseName: f.project.name,
          detectedKind: f.detectedKind,
          confidence: f.confidence,
          sectionTitle: f.sectionTitle,
        }))}
        recent={recent.map((f) => ({
          id: f.id,
          fileName: f.fileName,
          courseName: f.project.name,
          detectedKind: f.detectedKind,
          status: f.status,
          createdAt: f.createdAt.toISOString(),
        }))}
      />
    </AppShell>
  );
}
