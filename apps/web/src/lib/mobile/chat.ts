// Mappers from chat DB rows / web stream events to the mobile v1 wire shapes.
import type { ChatStreamShape } from '@/lib/chat-stream';
import type { ChatMessage, Citation, ErrorCode, Thread } from './schema';

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  citations: unknown;
  error: string | null;
  createdAt: Date;
}

export interface ThreadRow {
  id: string;
  title: string;
  documentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Web citations carry `href` and a nullable `pageNo`; the mobile contract has neither. */
export function toCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const { n, kind, id, title, pageNo } = c as Record<string, unknown>;
    if (typeof n !== 'number' || typeof id !== 'string') continue;
    out.push({
      n,
      kind: String(kind ?? ''),
      id,
      title: String(title ?? ''),
      ...(typeof pageNo === 'number' ? { pageNo } : {}),
    });
  }
  return out;
}

export function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    citations: toCitations(row.citations),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toThread(row: ThreadRow, courseSlug: string): Thread {
  return {
    id: row.id,
    courseSlug,
    title: row.title,
    documentId: row.documentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function errorCodeFor(kind: string): ErrorCode {
  switch (kind) {
    case 'budget':
    case 'rate_limit':
      return 'rate_limited';
    case 'quota':
    case 'auth':
      return 'ai_unavailable';
    default:
      return 'internal';
  }
}

/** Mobile NDJSON shape: contract messages, no `saved` row, `error` carries `code`. */
export function mobileStreamShape(): ChatStreamShape<MessageRow> {
  return {
    user: (m) => ({ type: 'user', message: toMessage(m) }),
    done: (m, fallback) => ({ type: 'done', message: toMessage(m), fallback }),
    error: ({ message, kind }) => ({
      type: 'error',
      code: errorCodeFor(kind),
      message,
      kind,
    }),
  };
}
