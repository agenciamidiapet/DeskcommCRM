/**
 * Projection consumed by MídiaPet Director.
 *
 * This is intentionally narrower than the contacts API: the Director needs
 * activity signals, not names, telephone numbers, e-mail addresses, tags or
 * conversation contents.  Keeping the projection here makes that privacy
 * boundary testable independently from the route.
 */
export interface DirectorSnapshotContactRow {
  id: string;
  last_activity_at: string | null;
  source: string | null;
}

export interface DirectorCrmSnapshot {
  asOf: string;
  contacts: Array<{
    externalId: string;
    lastActivityAt: string | null;
    source?: string;
  }>;
}

const SAFE_SOURCES = new Set([
  "whatsapp",
  "manual",
  "import",
  "landing_page",
  "webhook",
  "campaign",
]);

function safeSource(source: string | null): string | undefined {
  if (!source) return undefined;
  const normalized = source.trim().toLowerCase();
  return SAFE_SOURCES.has(normalized) ? normalized : "other";
}

export function buildDirectorCrmSnapshot(
  rows: DirectorSnapshotContactRow[],
  now = new Date(),
): DirectorCrmSnapshot {
  return {
    asOf: now.toISOString(),
    contacts: rows.map((row) => ({
      externalId: row.id,
      lastActivityAt: row.last_activity_at,
      ...(safeSource(row.source) ? { source: safeSource(row.source) } : {}),
    })),
  };
}
