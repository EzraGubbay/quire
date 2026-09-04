import { headers } from 'next/headers';
import { type FeatureKey, featureLevel, type Level } from './features';
import { type Platform, platformFromHeaders } from './platform';

/** The requesting device's class, from the cookie the client sets (or the user agent on first load). */
export async function currentPlatform(): Promise<Platform> {
  return platformFromHeaders(await headers());
}

export async function currentFeature(key: FeatureKey): Promise<{ platform: Platform; level: Level }> {
  const platform = await currentPlatform();
  return { platform, level: featureLevel(key, platform) };
}
