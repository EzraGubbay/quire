import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/projects', () => ({
  listProjects: vi.fn(),
  getProjectById: vi.fn(),
  getProjectBySlug: vi.fn(),
}));
vi.mock('@/lib/documents', () => ({}));
vi.mock('./courses', () => ({}));
vi.mock('./content', () => ({ MAX_IMAGES_PER_CALL: 4, TEXT_BUDGET: 20_000 }));
vi.mock('./tool-results', () => ({}));
vi.mock('./upload', () => ({ kb: vi.fn(), uploadLimits: () => ({ maxMarkdownBytes: 1 }) }));
vi.mock('./drive/tools', () => ({ registerDriveTools: vi.fn() }));
const { registerQuireMcp } = await import('./server');

describe('course server never registers research tools', () => {
  it('has no list_projects, add_paper or get_note', () => {
    const names: string[] = [];
    registerQuireMcp({ tool: (n: string) => names.push(n), resource: vi.fn() } as never);
    expect(names).toContain('list_courses');
    for (const n of ['list_projects', 'list_project_files', 'add_paper', 'get_note']) {
      expect(names).not.toContain(n);
    }
  });
});
