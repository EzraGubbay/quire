'use client';

// Thin client wrapper so the preview can render without a round trip. Same pipeline as the server.
export { renderMarkdown as renderMarkdownClient } from './markdown';
