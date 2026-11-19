export interface Upload {
  id: string;
  name: string;
  /** 0..1 */
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

export type UploadAction =
  | { type: 'enqueue'; id: string; name: string }
  | { type: 'progress'; id: string; progress: number }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; error: string }
  | { type: 'dismiss'; id: string };

const patch = (xs: Upload[], id: string, f: (u: Upload) => Upload): Upload[] =>
  xs.map((u) => (u.id === id ? f(u) : u));

export function uploadReducer(state: Upload[], a: UploadAction): Upload[] {
  switch (a.type) {
    case 'enqueue':
      return [...state, { id: a.id, name: a.name, progress: 0, status: 'uploading' }];
    case 'progress':
      return patch(state, a.id, (u) =>
        u.status === 'uploading' ? { ...u, progress: Math.min(1, Math.max(0, a.progress)) } : u,
      );
    case 'done':
      return patch(state, a.id, (u) => ({ ...u, status: 'done', progress: 1 }));
    case 'error':
      return patch(state, a.id, (u) => ({ ...u, status: 'error', error: a.error }));
    case 'dismiss':
      return state.filter((u) => u.id !== a.id);
  }
}
