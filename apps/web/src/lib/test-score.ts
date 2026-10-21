/** Pure scoring helper shared by server code and the client test view (no DB imports here). */
export function testScore(
  questions: { result: 'pass' | 'partial' | 'fail' | null; points: number }[],
): { got: number; total: number } | null {
  if (questions.length === 0 || questions.some((q) => !q.result)) return null;
  let got = 0;
  let total = 0;
  for (const q of questions) {
    total += q.points;
    got += q.result === 'pass' ? q.points : q.result === 'partial' ? q.points / 2 : 0;
  }
  return { got, total };
}
