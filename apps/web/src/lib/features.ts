import type { Platform } from './platform';

export type Level = 'on' | 'lite' | 'off';
type Row = { phone: Level; tablet?: Level; desktop: Level };

/**
 * Feature availability per platform. Code is the source of truth; tablet inherits desktop unless set.
 * Rule: phone is for capture and lookup; a feature is phone-off if it needs a wide canvas, precise pointer
 * selection, or long-form typing; lite when its read half is still valuable on a phone.
 */
export const FEATURES = {
  overview: { phone: 'on', desktop: 'on' },
  'documents.list': { phone: 'on', desktop: 'on' },
  'documents.viewer': { phone: 'lite', desktop: 'on' },
  'documents.annotate': { phone: 'off', desktop: 'on' },
  'documents.import': { phone: 'on', desktop: 'on' },
  'documents.edit': { phone: 'off', desktop: 'on' },
  'notes.read': { phone: 'on', desktop: 'on' },
  'notes.edit': { phone: 'lite', desktop: 'on' },
  graph: { phone: 'off', desktop: 'on' },
  sources: { phone: 'on', desktop: 'on' },
  experiments: { phone: 'lite', desktop: 'on' },
  chat: { phone: 'on', desktop: 'on' },
  ask: { phone: 'on', desktop: 'on' },
  discover: { phone: 'on', desktop: 'on' },
  palette: { phone: 'off', desktop: 'on' },
  'settings.full': { phone: 'lite', desktop: 'on' },
  /** Meta flag: show the read-only feature-flags table in Settings. */
  'settings.flags': { phone: 'off', tablet: 'off', desktop: 'on' },
} as const satisfies Record<string, Row>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export const FEATURE_LABEL: Record<FeatureKey, string> = {
  overview: 'Overview',
  'documents.list': 'Documents list and folders',
  'documents.viewer': 'Document viewer',
  'documents.annotate': 'Text-selection annotations',
  'documents.import': 'Add documents (upload, arXiv, DOI, URL)',
  'documents.edit': 'Markdown document editor',
  'notes.read': 'Notes',
  'notes.edit': 'Note editing',
  graph: 'Graph',
  sources: 'Sources',
  experiments: 'Experiments',
  chat: 'Chat',
  ask: 'Ask',
  discover: 'Discover',
  palette: 'Command palette (⌘K)',
  'settings.full': 'Full settings',
  'settings.flags': 'Feature-flags table (meta)',
};

type Overrides = Partial<Record<FeatureKey, Partial<Record<Platform, Level>>>>;

/** Emergency overrides from the environment: QUIRE_FEATURES_JSON='{"graph":{"desktop":"off"}}'. */
export function envOverrides(json = process.env.QUIRE_FEATURES_JSON): Overrides {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Overrides;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function featureLevel(
  key: FeatureKey,
  platform: Platform,
  overrides: Overrides = envOverrides(),
): Level {
  const o = overrides[key]?.[platform] ?? (platform === 'tablet' ? overrides[key]?.desktop : undefined);
  if (o) return o;
  const row: Row = FEATURES[key];
  if (platform === 'tablet') return row.tablet ?? row.desktop;
  return row[platform];
}

export const isOn = (key: FeatureKey, platform: Platform): boolean => featureLevel(key, platform) !== 'off';

/** Resolved matrix, for the flags table and for shipping to the client once. */
export function featureMatrix(
  overrides: Overrides = envOverrides(),
): Record<FeatureKey, Record<Platform, Level>> {
  const out = {} as Record<FeatureKey, Record<Platform, Level>>;
  for (const k of FEATURE_KEYS)
    out[k] = {
      phone: featureLevel(k, 'phone', overrides),
      tablet: featureLevel(k, 'tablet', overrides),
      desktop: featureLevel(k, 'desktop', overrides),
    };
  return out;
}
