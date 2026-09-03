/** Small subsequence fuzzy matcher: returns a score > 0 when every character of `query` appears in order in `text`. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 + q.length;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    run = idx === ti ? run + 1 : 1;
    score += run;
    ti = idx + 1;
  }
  return score;
}
