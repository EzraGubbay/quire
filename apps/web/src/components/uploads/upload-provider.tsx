'use client';

import { useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useReducer, useRef } from 'react';
import { type Upload, uploadReducer } from './upload-reducer';

export interface EnqueueArgs {
  /** Shown in the tray. */
  name: string;
  /** Route handler to POST the multipart body to. */
  url: string;
  body: FormData;
  /**
   * New-document uploads: where to open the result (given the new id). Only followed if the user is still on the
   * page they started from; otherwise the upload just refreshes in the background.
   */
  openOnDone?: (id: string) => string;
}

interface UploadCtx {
  uploads: Upload[];
  enqueue: (args: EnqueueArgs) => string;
  dismiss: (id: string) => void;
}

const UploadContext = createContext<UploadCtx>({ uploads: [], enqueue: () => '', dismiss: () => {} });
export const useUploads = () => useContext(UploadContext);

const errorOf = (xhr: XMLHttpRequest): string => {
  try {
    const e = JSON.parse(xhr.responseText)?.error;
    if (typeof e === 'string' && e) return e;
  } catch {}
  return `Upload failed (${xhr.status || 'network error'}).`;
};

/**
 * Owns uploads for the whole app. Mounted in Providers (above every page), so the XHRs keep running when the
 * user navigates client-side. XHR rather than fetch for `upload.onprogress`.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, dispatch] = useReducer(uploadReducer, []);
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  const seq = useRef(0);

  const enqueue = useCallback(({ name, url, body, openOnDone }: EnqueueArgs) => {
    const id = `up-${Date.now()}-${++seq.current}`;
    dispatch({ type: 'enqueue', id, name });
    const originPath = window.location.pathname;
    const xhr = new XMLHttpRequest();
    xhrs.current.set(id, xhr);
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) dispatch({ type: 'progress', id, progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      xhrs.current.delete(id);
      if (xhr.status >= 200 && xhr.status < 300) {
        let newId: unknown;
        let warning: unknown;
        try {
          const body = JSON.parse(xhr.responseText);
          newId = body?.id;
          warning = body?.warning;
        } catch {}
        dispatch({ type: 'done', id, warning: typeof warning === 'string' && warning ? warning : undefined });
        if (openOnDone && typeof newId === 'string' && window.location.pathname === originPath)
          routerRef.current.push(openOnDone(newId));
        else routerRef.current.refresh();
      } else dispatch({ type: 'error', id, error: errorOf(xhr) });
    };
    xhr.onerror = () => {
      xhrs.current.delete(id);
      dispatch({ type: 'error', id, error: errorOf(xhr) });
    };
    xhr.send(body);
    return id;
  }, []);

  const dismiss = useCallback((id: string) => {
    xhrs.current.get(id)?.abort();
    xhrs.current.delete(id);
    dispatch({ type: 'dismiss', id });
  }, []);

  const value = useMemo(() => ({ uploads, enqueue, dismiss }), [uploads, enqueue, dismiss]);
  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}
