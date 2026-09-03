/** Splits text into ~`size`-token chunks on paragraph/sentence boundaries with a little overlap. */
export function chunkText(text: string, size = 700, overlap = 80): string[] {
  const clean = text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!clean) return [];
  const maxChars = size * 4;
  const overlapChars = overlap * 4;
  const units = clean.split(/\n{2,}/).flatMap((p) => (p.length > maxChars ? p.split(/(?<=[.!?])\s+/) : [p]));
  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    const piece = u.trim();
    if (!piece) continue;
    if (cur && cur.length + piece.length + 2 > maxChars) {
      out.push(cur);
      cur = `${cur.slice(-overlapChars)}\n${piece}`.trim();
    } else cur = cur ? `${cur}\n\n${piece}` : piece;
    while (cur.length > maxChars * 1.5) {
      out.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars - overlapChars);
    }
  }
  if (cur) out.push(cur);
  return out;
}
