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
import { z } from "zod";

export const dynamic = "force-dynamic";

const snapshotShape = z.object({
  asOf: z.string().datetime({ offset: true }),
  limitExceeded: z.enum(["contacts", "funnel"]).nullable(),
  contacts: z.array(z.object({
    id: z.string(),
    created_at: z.string(),
    last_activity_at: z.string().nullable(),
    source: z.string().nullable(),
  })),
  leads: z.array(z.object({
    pipeline_id: z.string(),
    stage_id: z.string(),
    status: z.string(),
  })),
  stages: z.array(z.object({ id: z.string(), pipeline_id: z.string() })),
  pipelines: z.array(z.string()),
});

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

  // A single SQL RPC observes contacts and funnel under one MVCC snapshot.
  // The service role bypasses RLS, so the organization must come only from the
  // validated bearer. The SQL function filters all four sources by this ID.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_director_crm_snapshot", {
    p_organization_id: auth.organizationId,
  });
  if (error) return snapshotReadFailure("internal_error", "contacts", requestId);
  const parsed = snapshotShape.safeParse(data);
  if (!parsed.success) return snapshotReadFailure("internal_error", "contacts", requestId);
  const snapshot = parsed.data;
  if (snapshot.limitExceeded) {
    return snapshotReadFailure("snapshot_too_large", snapshot.limitExceeded, requestId);
  }

  let funnelSummary;
  try {
    funnelSummary = buildDirectorFunnelSummary(
      snapshot.leads as DirectorSnapshotLeadRow[],
      snapshot.stages as DirectorSnapshotStageRow[],
      snapshot.pipelines,
    );
  } catch {
    return snapshotReadFailure("internal_error", "funnel", requestId);
  }

  return ok(buildDirectorCrmSnapshot(
    snapshot.contacts as DirectorSnapshotContactRow[],
    new Date(snapshot.asOf),
    funnelSummary,
  ), { requestId });
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
