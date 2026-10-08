export type StoryAudienceValue =
  { mode: 'all_savers' } | { mode: 'savers_except'; excludedUserIds?: unknown };

/** The server is the source of truth: equality is exclusive at expiresAt. */
export function isStoryUnexpired(expiresAt: Date | string, now: Date = new Date()): boolean {
  const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime();
}

/** Story privacy narrows saved-profile access; follows are intentionally absent. */
export function storyAudienceAllows(audience: unknown, viewerPublicUserId: string): boolean {
  if (!audience || typeof audience !== 'object' || Array.isArray(audience)) return false;
  const value = audience as Record<string, unknown>;
  if (value.mode === 'all_savers') return true;
  if (value.mode !== 'savers_except') return false;
  const excluded = value.excludedUserIds;
  if (!Array.isArray(excluded) || !excluded.every(id => typeof id === 'string')) return false;
  return !excluded.includes(viewerPublicUserId);
}
