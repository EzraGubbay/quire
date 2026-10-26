// A tiny on-disk cache of resource hrefs already pulled per course, so a sync skips unchanged activities.
// The server dedupes by content anyway; this just avoids re-downloading files we've already handled.
import { readFile, writeFile } from 'node:fs/promises';

export class SeenStore {
  constructor(file) {
    this.file = file;
    this.data = {};
  }
  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }
  for(key) {
    return new Set(this.data[key] ?? []);
  }
  async save(key, set) {
    this.data[key] = [...set];
    await writeFile(this.file, JSON.stringify(this.data, null, 2)).catch(() => {});
  }
}
