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
  type DirectorSnapshotContactRow,
} from "@/lib/director/crm-snapshot";
import { ensureRole, ensureScope, McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MAX_CONTACTS = 5_000;
const SELECT_COLUMNS = "id,created_at,last_activity_at,source";

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
  const { data, error } = await createAdminClient()
    .from("contacts")
    .select(SELECT_COLUMNS)
    .eq("organization_id", auth.organizationId)
    .eq("kind", "person")
    .is("is_merged_into", null)
    .order("last_activity_at", { ascending: true, nullsFirst: true })
    .limit(MAX_CONTACTS + 1);

  if (error)
    return fail("internal_error", "Não foi possível preparar a leitura do CRM.", 500, {
      requestId,
    });
  const rows = (data ?? []) as DirectorSnapshotContactRow[];
  if (rows.length > MAX_CONTACTS) {
    return fail(
      "snapshot_too_large",
      "A organização possui mais contatos do que esta leitura segura suporta. Configure uma exportação agregada.",
      422,
      { requestId },
    );
  }

  return ok(buildDirectorCrmSnapshot(rows), { requestId });
}
