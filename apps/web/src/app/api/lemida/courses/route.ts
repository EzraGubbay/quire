// The enabled course mappings, for the agent's one-off `sync` run (the sync command carries the same list).
import { json } from '@/lib/api';
import { enabledMappings } from '@/lib/lemida/courses';

export const dynamic = 'force-dynamic';

export async function GET() {
  const mappings = await enabledMappings();
  return json({
    courses: mappings.map((m) => ({
      mappingId: m.id,
      slug: m.project.slug,
      lemidaUrl: m.lemidaUrl,
      lemidaCourseId: m.lemidaCourseId,
      label: m.label || m.project.name,
    })),
  });
}
