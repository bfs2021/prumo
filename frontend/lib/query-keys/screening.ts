/**
 * TanStack Query keys for title/abstract screening. Every screening read of a
 * project sits under `project(projectId)`, so every screening mutation
 * invalidates that one prefix.
 */
export const screeningKeys = {
  all: ['screening'] as const,
  project: (projectId: string) => [...screeningKeys.all, 'project', projectId] as const,
  config: (projectId: string) => [...screeningKeys.project(projectId), 'config'] as const,
} as const;
