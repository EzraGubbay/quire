// Thin client for Quire's Lemida API. Authenticates with the bearer key (proxy.ts accepts it on /api/*).
// The key is read from config and never logged.

export class QuireClient {
  constructor(config) {
    this.base = config.baseUrl;
    this.key = config.apiKey;
  }

  headers(extra = {}) {
    return { ...(this.key ? { authorization: `Bearer ${this.key}` } : {}), ...extra };
  }

  async #json(method, pathname, body) {
    const res = await fetch(`${this.base}${pathname}`, {
      method,
      headers: this.headers(body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${await res.text().catch(() => '')}`);
    return res.json();
  }

  /** The next queued command, or { command: null }. For sync it also carries the mapped courses. */
  nextCommand() {
    return this.#json('GET', '/api/lemida/commands');
  }

  /** Enabled course mappings, for a one-off `sync` run. */
  listCourses() {
    return this.#json('GET', '/api/lemida/courses');
  }

  completeCommand(id, status, result = {}) {
    return this.#json('POST', `/api/lemida/commands/${id}`, { status, result });
  }

  postState(patch) {
    return this.#json('POST', '/api/lemida/state', patch);
  }

  /** Upload one downloaded file to a course; the server hashes, dedupes, classifies and places it. */
  async importFile(slug, { fileName, bytes, contentType, sourceUrl, sectionTitle, moduleType, mappingId }) {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), fileName);
    form.set('fileName', fileName);
    if (sourceUrl) form.set('sourceUrl', sourceUrl);
    if (sectionTitle) form.set('sectionTitle', sectionTitle);
    if (moduleType) form.set('moduleType', moduleType);
    if (mappingId) form.set('mappingId', mappingId);
    const res = await fetch(`${this.base}/api/projects/${slug}/lemida/import`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) throw new Error(`import ${slug} → ${res.status} ${await res.text().catch(() => '')}`);
    return res.json();
  }
}
