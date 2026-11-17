// Pure helpers for naming entries in the "download all documents" ZIP. Kept separate so they unit-test
// without touching the filesystem or the archiver stream.

/** Sanitize a title into a safe ZIP entry basename (no path separators or reserved characters). */
export function safeZipName(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'document'
  );
}

/**
 * Returns a de-duplicator for entry paths within one archive: the first use of a name passes through, later
 * collisions get " (2)", " (3)", … inserted before the extension (and after any folder prefix).
 */
export function makeDeduper(): (name: string) => string {
  const used = new Set<string>();
  return (name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const slash = name.lastIndexOf('/');
    const dir = slash >= 0 ? name.slice(0, slash + 1) : '';
    const file = slash >= 0 ? name.slice(slash + 1) : name;
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    let next = name;
    for (let i = 2; used.has(next); i++) next = `${dir}${stem} (${i})${ext}`;
    used.add(next);
    return next;
  };
}
