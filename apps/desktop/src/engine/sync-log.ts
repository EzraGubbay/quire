// Append-only, size-capped diagnostic log for Lemida syncs. Synchronous and fully fault-tolerant: logging
// must never break a sync. Rotates lemida-sync.log -> .1 -> .2 (3 files kept).
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const KEEP = 3;

export class SyncLog {
  private readonly file: string;
  private readonly dir: string;
  private readonly maxBytes: number;
  private dirReady = false;

  constructor(dir: string, opts: { maxBytes?: number; mirror?: boolean } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'lemida-sync.log');
    this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.mirror = opts.mirror ?? true;
  }

  private readonly mirror: boolean;

  line(msg: string): void {
    if (this.mirror) {
      try {
        console.log(`[lemida] ${msg}`);
      } catch {
        // ignore
      }
    }
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
      }
      this.rotateIfNeeded();
      appendFileSync(this.file, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // Logging never breaks a sync.
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes) return;
    rmSync(`${this.file}.${KEEP - 1}`, { force: true });
    for (let i = KEEP - 2; i >= 1; i--) {
      try {
        renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      } catch {
        // missing
      }
    }
    renameSync(this.file, `${this.file}.1`);
  }
}
