import { AppShell } from '@/components/app-shell';
import { LemidaPanel } from '@/components/lemida/lemida-panel';
import type { LemidaCommand } from '@/db/schema';
import type { CommandView } from '@/lib/lemida/command-view';
import { commandOverview, hasActiveCommand, reapStaleCommands } from '@/lib/lemida/commands';
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

function commandView(c: LemidaCommand | null): CommandView | null {
  if (!c) return null;
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    payload: c.payload,
    result: c.result,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export default async function LemidaSyncPage() {
  await reapStaleCommands();
  const [state, mappings, review, recent, courses, active, overview] = await Promise.all([
    getLemidaState(),
    listMappings(),
    listReviewQueue(),
    recentFiles(20),
    listProjects({ kind: 'course', status: 'active' }),
    hasActiveCommand(),
    commandOverview(),
  ]);

  return (
    <AppShell>
      <LemidaPanel
        state={state}
        online={agentOnline(state)}
        active={active}
        commands={{ current: commandView(overview.current), last: commandView(overview.last) }}
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
