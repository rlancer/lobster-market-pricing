// Workspace context + hook, split out of App.tsx so the app layout file only
// exports components. App.tsx exporting `useWorkspace` alongside components
// broke React Fast Refresh (every save near the layout forced a full page
// reload and spammed HMR invalidation logs).
import { createContext, useContext } from 'react';
import type { Stats } from './api';

export interface WorkspaceValue {
  stats: Stats | null;
  updatedAt: string;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useWorkspace must be used within the app layout');
  return v;
}