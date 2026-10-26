#!/usr/bin/env node
// Entry point. Subcommands:
//   run              the poll loop (default; what launchd runs)
//   login            open a window to sign in to Lemida by hand, then report the session status
//   probe            check the session once, headless
//   sync [--full]    crawl mapped courses once and import new files (--full ignores the seen-cache)
//   parse <file>     dry-run the Moodle parser on a saved HTML fixture (no network, no browser)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runLoop, runSync } from './agent.js';
import { openLogin, probe } from './browser.js';
import { loadConfig } from './config.js';
import { parseMoodleCourse } from './moodle.js';
import { QuireClient } from './quire.js';
import { SeenStore } from './seen.js';

async function main() {
  const [cmd = 'run', ...rest] = process.argv.slice(2);

  if (cmd === 'parse') {
    const file = rest[0];
    if (!file) throw new Error('usage: lemida-agent parse <course.html>');
    const html = await readFile(file, 'utf8');
    const resources = parseMoodleCourse(html, 'https://lemida.biu.ac.il/');
    console.log(JSON.stringify(resources, null, 2));
    console.log(`\n${resources.length} activities parsed.`);
    return;
  }

  const config = loadConfig();
  const client = new QuireClient(config);

  if (cmd === 'login') {
    const status = await openLogin(config);
    await client.postState({ sessionStatus: status });
    console.log(`login → ${status}`);
  } else if (cmd === 'probe') {
    const status = await probe(config);
    await client.postState({ sessionStatus: status });
    console.log(`probe → ${status}`);
  } else if (cmd === 'sync') {
    const full = rest.includes('--full');
    const { courses } = await client.listCourses();
    if (courses.length === 0) {
      console.log('No enabled course mappings. Link a course in Quire → Courses → Lemida sync.');
      return;
    }
    const seenStore = new SeenStore(path.join(config.agentDir, '.seen.json'));
    await seenStore.load();
    const summary = await runSync(config, client, courses, seenStore, { full });
    await client.postState({
      sessionStatus: 'valid',
      lastSyncSummary: summary,
      lastSyncAt: new Date().toISOString(),
    });
    console.log(`sync → ${summary}`);
  } else if (cmd === 'run') {
    await runLoop(config, client);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
