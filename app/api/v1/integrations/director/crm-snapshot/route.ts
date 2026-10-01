/**
 * GET /api/v1/integrations/director/crm-snapshot
 *
 * Read-only, tenant-scoped projection for MídiaPet Director. It is deliberately
 * not the generic contacts API: no personal contact data crosses this boundary.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  buildDirectorCrmSnapshot,
  buildDirectorFunnelSummary,
  type DirectorSnapshotContactRow,
  type DirectorSnapshotLeadRow,
  type DirectorSnapshotStageRow,
} from "@/lib/director/crm-snapshot";
import { ensureRole, ensureScope, McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MAX_SNAPSHOT_ROWS = 5_000;
const PAGE_SIZE = 500;
const SELECT_COLUMNS = "id,created_at,last_activity_at,source";

type SnapshotPage<T> = { data: T[] | null; count: number | null; error: unknown };

/** PostgREST may cap a response below .limit(); page until the exact count is read. */
async function loadScopedRows<T>(
  readPage: (from: number, to: number) => Promise<SnapshotPage<T>>,
): Promise<{ rows: T[] } | { error: "internal_error" | "snapshot_too_large" }> {
  const rows: T[] = [];
  let expectedCount: number | null = null;
  while (true) {
    const page = await readPage(rows.length, rows.length + PAGE_SIZE - 1);
    if (page.error || page.count === null) return { error: "internal_error" };
    if (page.count > MAX_SNAPSHOT_ROWS) return { error: "snapshot_too_large" };
    if (expectedCount !== null && page.count !== expectedCount) return { error: "internal_error" };
    expectedCount = page.count;
    const next = page.data ?? [];
    rows.push(...next);
    if (rows.length === expectedCount) return { rows };
    if (next.length === 0 || rows.length > expectedCount) return { error: "internal_error" };
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let auth;
  try {
    auth = await validateBearerToken(req.headers.get("authorization"));
    ensureScope(auth.scopes, "mcp:read");
    ensureRole(auth.role, "viewer");
  } catch (error) {
    if (error instanceof McpAuthError) {
      return fail(
        error.httpStatus === 401 ? "unauthenticated" : "forbidden",
        error.message,
        error.httpStatus,
        {
          requestId,
        },
      );
    }
    throw error;
  }

  // Service role intentionally has an explicit filter. The organization comes
  // only from the validated token, never from a path, query parameter or body.
  // Every service-role read is constrained by the organization authenticated by
  // the bearer. Lead IDs are read only for stable pagination; they never leave
  // this handler. Stage names and free-text business fields are not selected.
  const admin = createAdminClient();
  const contacts = await loadScopedRows<DirectorSnapshotContactRow>(async (from, to) => {
    const result = await admin
      .from("contacts")
      .select(SELECT_COLUMNS, { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .eq("kind", "person")
      .is("is_merged_into", null)
      .order("last_activity_at", { ascending: true, nullsFirst: true })
      .order("id")
      .range(from, to);
    return { data: result.data as DirectorSnapshotContactRow[] | null, count: result.count, error: result.error };
  });
  if ("error" in contacts) return snapshotReadFailure(contacts.error, "contacts", requestId);

  const leads = await loadScopedRows<DirectorSnapshotLeadRow>(async (from, to) => {
    const result = await admin
      .from("crm_leads")
      .select("id,pipeline_id,stage_id,status", { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .order("id")
      .range(from, to);
    return { data: result.data as DirectorSnapshotLeadRow[] | null, count: result.count, error: result.error };
  });
  if ("error" in leads) return snapshotReadFailure(leads.error, "funnel", requestId);

  const stages = await loadScopedRows<DirectorSnapshotStageRow>(async (from, to) => {
    const result = await admin
      .from("crm_stages")
      .select("id,pipeline_id", { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .order("id")
      .range(from, to);
    return { data: result.data as DirectorSnapshotStageRow[] | null, count: result.count, error: result.error };
  });
  if ("error" in stages) return snapshotReadFailure(stages.error, "funnel", requestId);

  const pipelines = await loadScopedRows<{ id: string }>(async (from, to) => {
    const result = await admin
      .from("crm_pipelines")
      .select("id", { count: "exact" })
      .eq("organization_id", auth.organizationId)
      .order("id")
      .range(from, to);
    return { data: result.data as { id: string }[] | null, count: result.count, error: result.error };
  });
  if ("error" in pipelines) return snapshotReadFailure(pipelines.error, "funnel", requestId);

  let funnelSummary;
  try {
    funnelSummary = buildDirectorFunnelSummary(
      leads.rows,
      stages.rows,
      pipelines.rows.map((pipeline) => pipeline.id),
    );
  } catch {
    return snapshotReadFailure("internal_error", "funnel", requestId);
  }

  return ok(buildDirectorCrmSnapshot(contacts.rows, new Date(), funnelSummary), { requestId });
}

function snapshotReadFailure(
  code: "internal_error" | "snapshot_too_large",
  section: "contacts" | "funnel",
  requestId: string,
): Response {
  return code === "snapshot_too_large"
    ? fail("snapshot_too_large", section === "contacts"
      ? "Os contatos excedem o limite de 5.000 registros desta leitura segura."
      : "O funil excede o limite de 5.000 registros desta leitura segura.", 422, { requestId })
    : fail("internal_error", "Não foi possível preparar a leitura do CRM.", 500, { requestId });
}
