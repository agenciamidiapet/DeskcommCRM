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
  created_at: string;
  last_activity_at: string | null;
  source: string | null;
}

export interface DirectorCrmSnapshot {
  asOf: string;
  contacts: Array<{
    externalId: string;
    createdAt: string;
    lastActivityAt: string | null;
    source?: string;
  }>;
  funnelSummary?: DirectorFunnelSummary;
}

export interface DirectorSnapshotLeadRow {
  pipeline_id: string;
  stage_id: string;
  status: string;
}

export interface DirectorSnapshotStageRow {
  id: string;
  pipeline_id: string;
}

export interface DirectorFunnelSummary {
  totalOpen: number;
  totalWon: number;
  totalLost: number;
  byStage: Array<{
    pipelineId: string;
    stageId: string;
    open: number;
    won: number;
    lost: number;
  }>;
}

/** Counts only real CRM businesses; an unknown or cross-pipeline reference fails closed. */
export function buildDirectorFunnelSummary(
  leads: DirectorSnapshotLeadRow[],
  stages: DirectorSnapshotStageRow[],
  pipelineIds: string[],
): DirectorFunnelSummary {
  const knownPipelines = new Set(pipelineIds);
  const knownStages = new Map(stages.map((stage) => [stage.id, stage]));
  const byStage = new Map<string, DirectorFunnelSummary["byStage"][number]>();
  const summary: DirectorFunnelSummary = {
    totalOpen: 0,
    totalWon: 0,
    totalLost: 0,
    byStage: [],
  };

  for (const lead of leads) {
    const stage = knownStages.get(lead.stage_id);
    if (!knownPipelines.has(lead.pipeline_id) || !stage || stage.pipeline_id !== lead.pipeline_id) {
      throw new Error("Director funnel contains a business outside its configured pipeline.");
    }
    if (lead.status !== "open" && lead.status !== "won" && lead.status !== "lost") {
      throw new Error("Director funnel contains an unknown business status.");
    }
    const key = `${lead.pipeline_id}:${lead.stage_id}`;
    let entry = byStage.get(key);
    if (!entry) {
      entry = {
        pipelineId: lead.pipeline_id,
        stageId: lead.stage_id,
        open: 0,
        won: 0,
        lost: 0,
      };
      byStage.set(key, entry);
    }
    entry[lead.status] += 1;
    if (lead.status === "open") summary.totalOpen += 1;
    if (lead.status === "won") summary.totalWon += 1;
    if (lead.status === "lost") summary.totalLost += 1;
  }

  summary.byStage = [...byStage.values()].sort((a, b) =>
    a.pipelineId.localeCompare(b.pipelineId) || a.stageId.localeCompare(b.stageId),
  );
  return summary;
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
  funnelSummary?: DirectorFunnelSummary,
): DirectorCrmSnapshot {
  return {
    asOf: now.toISOString(),
    contacts: rows.map((row) => ({
      externalId: row.id,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      ...(safeSource(row.source) ? { source: safeSource(row.source) } : {}),
    })),
    ...(funnelSummary ? { funnelSummary } : {}),
  };
}
