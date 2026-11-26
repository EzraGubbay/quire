// Read-only data assembly for the Quire Research MCP server. Only ever resolves kind='research' projects
// (RESEARCH_SCOPE), so a course slug or id is "No research project found", exactly like a missing slug.
import type { Document } from '@/db/schema';
import { countDocuments, listDocuments, listFolders } from '@/lib/documents';
import { RESEARCH_SCOPE, resolveProjectIn } from '@/lib/mcp/scope';
import { getNote, listNotes } from '@/lib/notes';
import { listProjects } from '@/lib/projects';
import { listSources } from '@/lib/sources';

const snippet = (s: string | null | undefined, n = 300) => (s ?? '').slice(0, n);

export interface ResearchProjectSummary {
  slug: string;
  id: string;
  name: string;
  description: string;
  documentCount: number;
  noteCount: number;
  sourceCount: number;
}

export interface ResearchDocument {
  fileId: string;
  title: string;
  kind: 'pdf' | 'markdown';
  folder: string | null;
  pageCount: number | null;
  sizeBytes: number | null;
  hasPdf: boolean;
  hasOriginal: boolean;
  hasMarkdown: boolean;
  readingStatus: string;
  tags: string[];
  paper: {
    authors: string[];
    year: number | null;
    arxivId: string | null;
    doi: string | null;
    sourceUrl: string | null;
    abstract: string;
  } | null;
  resourceUri: string;
}

export async function requireResearchProject(ref: string) {
  const project = await resolveProjectIn(RESEARCH_SCOPE, ref);
  if (!project) {
    throw new Error(`No research project found for "${ref}". Call list_projects for the valid slugs.`);
  }
  return project;
}

export async function listResearchProjects(): Promise<ResearchProjectSummary[]> {
  const projects = await listProjects({ kind: 'research' });
  return Promise.all(
    projects.map(async (p) => {
      const [documentCount, notes, sources] = await Promise.all([
        countDocuments(p.id),
        listNotes(p.id),
        listSources(p.id),
      ]);
      return {
        slug: p.slug,
        id: p.id,
        name: p.name,
        description: p.description,
        documentCount,
        noteCount: notes.length,
        sourceCount: sources.length,
      };
    }),
  );
}

export function paperOf(d: Document): ResearchDocument['paper'] {
  if (!d.arxivId && !d.doi && !d.sourceUrl && !d.authors?.length && !d.year) return null;
  return {
    authors: d.authors ?? [],
    year: d.year ?? null,
    arxivId: d.arxivId ?? null,
    doi: d.doi ?? null,
    sourceUrl: d.sourceUrl ?? null,
    abstract: snippet(d.abstract),
  };
}

export async function listProjectFiles(ref: string) {
  const project = await requireResearchProject(ref);
  const [docs, docFolders, notes, noteFolders, sources] = await Promise.all([
    listDocuments(project.id),
    listFolders(project.id, 'documents'),
    listNotes(project.id),
    listFolders(project.id, 'notes'),
    listSources(project.id),
  ]);
  const docFolder = new Map(docFolders.map((f) => [f.id, f.name]));
  const noteFolder = new Map(noteFolders.map((f) => [f.id, f.name]));
  return {
    project: { slug: project.slug, name: project.name },
    documents: docs.map(
      (d): ResearchDocument => ({
        fileId: d.id,
        title: d.title,
        kind: d.kind,
        folder: d.folderId ? (docFolder.get(d.folderId) ?? null) : null,
        pageCount: d.pageCount,
        sizeBytes: d.fileSize,
        hasPdf: Boolean(d.filePath),
        hasOriginal: Boolean(d.originalPath),
        hasMarkdown: d.kind === 'markdown',
        readingStatus: d.readingStatus,
        tags: d.tags ?? [],
        paper: paperOf(d),
        resourceUri: `${RESEARCH_SCOPE.uriPrefix}/${project.slug}/file/${d.id}`,
      }),
    ),
    notes: notes.map((n) => ({
      noteId: n.id,
      title: n.title,
      folder: n.folderId ? (noteFolder.get(n.folderId) ?? null) : null,
      updatedAt: n.updatedAt.toISOString(),
    })),
    sources: sources.map((s) => ({
      sourceId: s.id,
      type: s.type,
      title: s.title,
      url: s.url,
      description: snippet(s.description),
      tags: s.tags ?? [],
    })),
  };
}

export async function listAllResearchFileResources(): Promise<
  { uri: string; name: string; mimeType: string; description: string }[]
> {
  const projects = await listProjects({ kind: 'research' });
  const per = await Promise.all(projects.map((p) => listProjectFiles(p.slug)));
  return per.flatMap(({ project, documents }) =>
    documents.map((f) => ({
      uri: f.resourceUri,
      name: `${project.name} — ${f.title}`,
      mimeType: f.hasPdf ? 'application/pdf' : f.hasMarkdown ? 'text/markdown' : 'application/octet-stream',
      description: f.paper ? 'paper' : f.kind,
    })),
  );
}

export async function getNoteMarkdown(ref: string, noteId: string): Promise<string> {
  const project = await requireResearchProject(ref);
  const note = await getNote(project.id, noteId);
  if (!note) throw new Error(`No note "${noteId}" in project "${project.slug}"`);
  return `# ${note.title}\n\n${note.body}`;
}
