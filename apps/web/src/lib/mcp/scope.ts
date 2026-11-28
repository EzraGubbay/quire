// A "scope" says which side of Quire an MCP server serves: courses (/mcp) or research projects (/research/mcp).
// Kind isolation lives in core/projects/resolve.ts; resolveProjectIn binds it to a scope, so the other side's
// slugs answer exactly like a missing slug. Shared MCP internals take a scope as a
// trailing, defaulted parameter (default COURSE_SCOPE), which keeps the course server byte-identical.
import type { ProjectKind } from '@quire/shared';
import { type ProjectLookup, resolveProject } from '@/core/projects/resolve';
import type { Project } from '@/db/schema';
import { getProjectById, getProjectBySlug } from '@/lib/projects';

export interface McpScope {
  kind: ProjectKind;
  /** Word used in messages and as the key of an upload result's owner. */
  noun: 'course' | 'project';
  /** Name of the tool argument that carries the project reference (for read-back hints). */
  arg: 'course' | 'project';
  listTool: 'list_courses' | 'list_projects';
  filesTool: 'list_course_files' | 'list_project_files';
  uriPrefix: 'quire://course' | 'quire://research';
  /** Whether the write tools (and this scope's upload links) are on. Read per registration and per PUT. */
  writeEnabled(): boolean;
}

const flagOn = (name: string): boolean =>
  !['0', 'false', 'off', 'no'].includes((process.env[name] ?? '').trim().toLowerCase());

/** Course write tools are on unless MCP_WRITE_ENABLED is 0/false/off/no. */
export const mcpWriteEnabled = (): boolean => flagOn('MCP_WRITE_ENABLED');
/** Research write tools are on unless MCP_RESEARCH_WRITE_ENABLED is 0/false/off/no. Independent of the course flag. */
export const mcpResearchWriteEnabled = (): boolean => flagOn('MCP_RESEARCH_WRITE_ENABLED');

export const COURSE_SCOPE: McpScope = {
  kind: 'course',
  noun: 'course',
  arg: 'course',
  listTool: 'list_courses',
  filesTool: 'list_course_files',
  uriPrefix: 'quire://course',
  writeEnabled: mcpWriteEnabled,
};

export const RESEARCH_SCOPE: McpScope = {
  kind: 'research',
  noun: 'project',
  arg: 'project',
  listTool: 'list_projects',
  filesTool: 'list_project_files',
  uriPrefix: 'quire://research',
  writeEnabled: mcpResearchWriteEnabled,
};

export const scopeOf = (kind: ProjectKind): McpScope => (kind === 'research' ? RESEARCH_SCOPE : COURSE_SCOPE);

// Lazy wrappers, so module-level test doubles of @/lib/projects are read at call time.
const projectLookup: ProjectLookup = {
  byId: (id) => getProjectById(id),
  bySlug: (slug) => getProjectBySlug(slug),
};

/** The only project resolver MCP code may use: binds core's resolveProject to the scope's kind. */
export async function resolveProjectIn(scope: McpScope, ref: string): Promise<Project | undefined> {
  return resolveProject(projectLookup, scope.kind, ref);
}
