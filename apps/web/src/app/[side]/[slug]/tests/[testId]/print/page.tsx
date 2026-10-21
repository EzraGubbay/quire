import { notFound } from 'next/navigation';
import { getProjectBySlug, requireKind } from '@/lib/projects';
import { getTest } from '@/lib/tests';
import { testHtml } from '@/lib/tests-pdf';

export const dynamic = 'force-dynamic';

/**
 * Print view: the same HTML the PDF renderer uses, served as a page so the browser's Print → Save as PDF works when no
 * conversion service is configured. MathJax is the self-hosted SVG bundle.
 */
export default async function TestPrintPage({
  params,
}: {
  params: Promise<{ slug: string; testId: string }>;
}) {
  const { slug, testId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const test = await getTest(project.id, testId);
  if (!test || test.status === 'generating' || test.status === 'failed') notFound();
  const html = await testHtml(
    { title: test.title, courseName: project.name, questions: test.questions },
    '/mathjax/tex-svg.js',
  );
  // The page is a complete document; render only its body and head styles inside the app's html.
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  return (
    <div className="quire-print" data-testid="test-print">
      <style
        dangerouslySetInnerHTML={{
          __html: `${style}\n.quire-print{background:#fff;color:#1f1b16;padding:24px;max-width:860px;margin:0 auto}@media print{.folio header,.folio nav{display:none}}`,
        }}
      />
      <div dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  );
}
