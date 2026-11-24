// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enqueueCommand: vi.fn(async () => ({})), revalidatePath: vi.fn() }));

vi.mock('@/lib/lemida/commands', () => ({ enqueueCommand: h.enqueueCommand }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/lib/lemida/courses', () => ({
  deleteMapping: vi.fn(),
  mapCourse: vi.fn(),
  setMappingEnabled: vi.fn(),
}));
vi.mock('@/lib/lemida/files', () => ({ dismissReview: vi.fn(), resolveReview: vi.fn() }));

import { enqueueRescanAction, enqueueSyncAction } from './lemida';

describe('lemida sync actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueueRescanAction queues a full sync and revalidates the panel', async () => {
    await enqueueRescanAction();
    expect(h.enqueueCommand).toHaveBeenCalledWith('sync', { full: true });
    expect(h.revalidatePath).toHaveBeenCalledWith('/courses/lemida');
  });

  it('enqueueSyncAction still queues a plain sync with no payload', async () => {
    await enqueueSyncAction();
    expect(h.enqueueCommand).toHaveBeenCalledWith('sync');
  });
});
