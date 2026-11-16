// The per-resource reconcile step of a course sync, split out of lemida-session.ts so it is pure and
// Electron-free (type-only imports) and can be smoke-tested without a live browser. A resource is recorded
// as "seen" ONLY after we've actually pulled a file from it — a resource that yields no download (a
// transient fetch failure, a file still processing, a bot-wall challenge page) is left un-seen so the next
// sync retries it. Marking seen unconditionally was the bug that permanently blacklisted any resource that
// failed to download once, stranding the OpenMP lectures.
import type { Download, OnFile, SyncStats } from './lemida-session';
import type { Resource } from './moodle';

export interface ReconcileDeps {
  collect: (resource: Resource) => Promise<Download[]>;
  onFile: OnFile;
}

export async function reconcileResources(
  resources: Resource[],
  { seen, full }: { seen: Set<string>; full: boolean },
  { collect, onFile }: ReconcileDeps,
): Promise<SyncStats> {
  const stats: SyncStats = { resources: resources.length, downloaded: 0, skipped: 0 };
  for (const resource of resources) {
    if (!full && seen.has(resource.href)) {
      stats.skipped++;
      continue;
    }
    const downloads = await collect(resource);
    for (const dl of downloads) {
      await onFile(dl, resource);
      stats.downloaded++;
    }
    if (downloads.length > 0) seen.add(resource.href);
  }
  return stats;
}
