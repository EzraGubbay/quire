// A tiny on-disk cache of resource hrefs already pulled per course, so a sync skips unchanged activities.
// The server dedupes by content anyway; this just avoids re-downloading files we've already handled.
// Ported from tools/lemida-agent/src/seen.js. Lives under app.getPath('userData') in the desktop app.
import { readFile, writeFile } from 'node:fs/promises';

export class SeenStore {
  private readonly file: string;
  private data: Record<string, string[]> = {};

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string[]>;
    } catch {
      this.data = {};
    }
  }

  for(key: string): Set<string> {
    return new Set(this.data[key] ?? []);
  }

  async save(key: string, set: Set<string>): Promise<void> {
    this.data[key] = [...set];
    await writeFile(this.file, JSON.stringify(this.data, null, 2)).catch(() => {});
  }
}
