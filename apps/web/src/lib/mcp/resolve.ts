// This is a shim that exists purely so existing tests which mock './courses' (resolveCourse) keep working:
// content.ts and upload.ts resolve through here instead of calling resolveProjectIn directly.
// Scope-aware project resolution for the shared MCP internals. The course scope goes through resolveCourse (the
// course server's own resolver); any other scope through resolveProjectIn. Both enforce the project's kind.
import type { Project } from '@/db/schema';
import { resolveCourse } from './courses';
import { type McpScope, resolveProjectIn } from './scope';

export const resolveInScope = (scope: McpScope, ref: string): Promise<Project | undefined> =>
  scope.kind === 'course' ? resolveCourse(ref) : resolveProjectIn(scope, ref);
