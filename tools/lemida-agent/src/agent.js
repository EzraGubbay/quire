// The agent: a poll loop that picks up commands the Quire panel queues, plus a passive hourly session
// probe. Everything it does is something you could do yourself in your own browser; it only ever reuses
// the session you signed in by hand.
import path from 'node:path';
import { openLogin, probe, SessionExpired, syncCourse } from './browser.js';
import { SeenStore } from './seen.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarise(tally) {
  const parts = [];
  if (tally.imported) parts.push(`${tally.imported} imported`);
  if (tally.needs_review) parts.push(`${tally.needs_review} to review`);
  if (tally.duplicate) parts.push(`${tally.duplicate} already had`);
  if (tally.error) parts.push(`${tally.error} failed`);
  return parts.join(', ') || 'nothing new';
}

/** Crawl every mapped course and upload each new file. Returns a one-line summary. */
export async function runSync(config, client, courses, seenStore, { full = false } = {}) {
  const tally = { imported: 0, needs_review: 0, duplicate: 0, error: 0 };
  for (const course of courses) {
    const key = course.lemidaUrl;
    const seen = seenStore.for(key);
    const onFile = async (dl, resource) => {
      try {
        const res = await client.importFile(course.slug, {
          fileName: dl.name,
          bytes: dl.bytes,
          contentType: dl.contentType,
          sourceUrl: dl.sourceUrl,
          sectionTitle: resource.sectionTitle,
          moduleType: resource.moduleType,
          mappingId: course.mappingId,
        });
        tally[res.status] = (tally[res.status] ?? 0) + 1;
      } catch (err) {
        tally.error++;
        console.error(`  import failed (${dl.name}): ${err.message}`);
      }
    };
    console.log(`→ ${course.label} (${course.slug})`);
    const stats = await syncCourse(config, course, onFile, { seen, full });
    await seenStore.save(key, seen);
    console.log(`  ${stats.resources} activities, ${stats.downloaded} files, ${stats.skipped} skipped`);
  }
  return summarise(tally);
}

async function handleCommand(config, client, seenStore, payload) {
  const cmd = payload.command;
  try {
    if (cmd.kind === 'open_login') {
      const status = await openLogin(config);
      await client.postState({ sessionStatus: status });
      await client.completeCommand(cmd.id, 'done', { sessionStatus: status });
      console.log(`login → ${status}`);
    } else if (cmd.kind === 'probe') {
      const status = await probe(config);
      await client.postState({ sessionStatus: status });
      await client.completeCommand(cmd.id, 'done', { sessionStatus: status });
      console.log(`probe → ${status}`);
    } else if (cmd.kind === 'sync') {
      const summary = await runSync(config, client, payload.courses ?? [], seenStore);
      await client.postState({
        sessionStatus: 'valid',
        lastSyncSummary: summary,
        lastSyncAt: new Date().toISOString(),
      });
      await client.completeCommand(cmd.id, 'done', { summary });
      console.log(`sync → ${summary}`);
    }
  } catch (err) {
    const expired = err instanceof SessionExpired;
    if (expired) await client.postState({ sessionStatus: 'expired' }).catch(() => {});
    await client.completeCommand(cmd.id, 'error', { message: err.message }).catch(() => {});
    console.error(`command ${cmd.kind} failed: ${err.message}`);
  }
}

/** The main loop: claim commands as they arrive, and probe the session every `probeMs`. */
export async function runLoop(config, client) {
  const seenStore = new SeenStore(path.join(config.agentDir, '.seen.json'));
  await seenStore.load();
  let lastProbe = 0;
  console.log(`lemida-agent watching ${config.baseUrl} (poll ${config.pollMs}ms, probe ${config.probeMs}ms)`);
  for (;;) {
    try {
      const payload = await client.nextCommand();
      if (payload.command) {
        await handleCommand(config, client, seenStore, payload);
      } else if (Date.now() - lastProbe > config.probeMs) {
        lastProbe = Date.now();
        const status = await probe(config).catch(() => 'expired');
        await client.postState({ sessionStatus: status });
        console.log(`passive probe → ${status}`);
      }
    } catch (err) {
      console.error(`loop error: ${err.message}`);
    }
    await sleep(config.pollMs);
  }
}
