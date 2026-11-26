import { beforeEach, describe, expect, it } from 'vitest';
import { __storeForTests, createLink, getStatus, type LinkBinding, setStatus } from './upload-links';

const base: LinkBinding = {
  projectId: 'p1',
  scope: 'course',
  section: 'documents',
  kind: 'pdf',
  filename: 'a.pdf',
  folderId: null,
  folderName: null,
  contentType: 'application/pdf',
  maxBytes: 100,
};
beforeEach(() => {
  __storeForTests().links.clear();
  __storeForTests().statuses.clear();
});

describe('upload link scope binding', () => {
  it('stores the scope on the link and the status; token never stored', () => {
    const { token, uploadId } = createLink({ ...base, scope: 'research' });
    const s = __storeForTests();
    expect([...s.links.values()][0]?.scope).toBe('research');
    expect(s.statuses.get(uploadId)?.scope).toBe('research');
    expect(JSON.stringify([...s.links.keys()])).not.toContain(token);
  });
  it('a course link has a course-scoped status', () => {
    const { uploadId } = createLink(base);
    expect(getStatus(uploadId, 'course')?.state).toBe('pending');
  });
  it('a status is invisible to the other scope, in both directions', () => {
    const r = createLink({ ...base, scope: 'research' });
    const c = createLink({ ...base, scope: 'course' });
    expect(getStatus(r.uploadId, 'course')).toBeUndefined();
    expect(getStatus(r.uploadId, 'research')).toBeDefined();
    expect(getStatus(c.uploadId, 'research')).toBeUndefined();
    setStatus(r.uploadId, { state: 'created' });
    expect(getStatus(r.uploadId, 'course')).toBeUndefined();
    expect(getStatus(r.uploadId, 'research')?.state).toBe('created');
  });
});
