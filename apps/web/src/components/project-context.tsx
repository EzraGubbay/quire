'use client';

import type { ProjectKind } from '@quire/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  kind: ProjectKind;
  /** URL prefix for this workspace: /p/<slug> for research, /c/<slug> for courses. */
  base: string;
}

const ProjectContext = createContext<ProjectInfo | null>(null);

export function ProjectProvider({ value, children }: { value: ProjectInfo; children: ReactNode }) {
  const memo = useMemo(() => value, [value]);
  return <ProjectContext.Provider value={memo}>{children}</ProjectContext.Provider>;
}

/** The current workspace; throws outside a project layout. */
export function useProject(): ProjectInfo {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject outside a project layout');
  return ctx;
}

/** Like useProject but null on the home and settings pages. */
export function useProjectMaybe(): ProjectInfo | null {
  return useContext(ProjectContext);
}
