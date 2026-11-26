import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/projects', () => ({
  listProjects: vi.fn(),
  getProjectById: vi.fn(),
  getProjectBySlug: vi.fn(),
  projectBase: vi.fn(),
}));
vi.mock('@/lib/documents', () => ({}));
vi.mock('@/lib/notes', () => ({}));
vi.mock('@/lib/sources', () => ({}));
vi.mock('@/lib/ingest', () => ({}));
vi.mock('@/lib/ai/index', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/mcp/upload-store', () => ({}));
vi.mock('@/lib/mcp/courses', () => ({}));
vi.mock('@/lib/mcp/content', () => ({ MAX_IMAGES_PER_CALL: 4 }));
vi.mock('@/lib/mcp/tool-results', () => ({}));
vi.mock('@/lib/mcp/drive/tools', () => ({ registerDriveTools: vi.fn() }));

const { registerQuireResearchMcp } = await import('./server');

type Reg = { name: string; description: string; annotations?: Record<string, unknown> };
function register(): Reg[] {
  const out: Reg[] = [];
  registerQuireResearchMcp({
    tool: (name: string, description: string, ...rest: unknown[]) => {
      const maybe = rest.at(-2);
      out.push({ name, description, annotations: (maybe ?? undefined) as Reg['annotations'] });
    },
    resource: vi.fn(),
  } as never);
  return out;
}
afterEach(() => {
  delete process.env.MCP_WRITE_ENABLED;
  delete process.env.MCP_RESEARCH_WRITE_ENABLED;
});

const READ = ['list_projects', 'list_project_files', 'get_file', 'get_page_images', 'get_note'];
const WRITE = ['upload_markdown', 'upload_pdf', 'add_paper', 'create_upload_link', 'get_upload_status'];

describe('registerQuireResearchMcp', () => {
  it('registers exactly the research tools with writes on', () => {
    expect(
      register()
        .map((t) => t.name)
        .sort(),
    ).toEqual([...READ, ...WRITE].sort());
  });
  it('MCP_RESEARCH_WRITE_ENABLED=false leaves only the read tools', () => {
    process.env.MCP_RESEARCH_WRITE_ENABLED = 'false';
    expect(
      register()
        .map((t) => t.name)
        .sort(),
    ).toEqual([...READ].sort());
  });
  it('MCP_WRITE_ENABLED=false alone does not hide the research write tools', () => {
    process.env.MCP_WRITE_ENABLED = 'false';
    expect(register().map((t) => t.name)).toEqual(expect.arrayContaining(WRITE));
  });
  it('never registers course or Drive tools', () => {
    const names = register().map((t) => t.name);
    for (const n of ['list_courses', 'list_course_files', 'import_from_drive', 'drive_inbox_status']) {
      expect(names).not.toContain(n);
    }
  });
  it('no description says "course"', () => {
    for (const t of register()) expect(t.description.toLowerCase(), t.name).not.toContain('course');
  });
  it('read tools are annotated readOnly', () => {
    for (const t of register().filter((x) => READ.includes(x.name))) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    }
  });
});
