import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/integrations/director/crm-snapshot/route";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/mcp/auth", () => ({
  validateBearerToken: vi.fn(),
  ensureScope: vi.fn(),
  ensureRole: vi.fn(),
  McpAuthError: class McpAuthError extends Error {},
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const agency = "11111111-1111-4111-8111-111111111111";

function request(): NextRequest {
  return new Request("https://crm.example.test/api/v1/integrations/director/crm-snapshot", {
    headers: { authorization: "Bearer dsk_test" },
  }) as NextRequest;
}

function database(options: { limitExceeded?: "contacts" | "funnel"; malformed?: boolean } = {}) {
  const rpc = vi.fn(async (_name: string, params: { p_organization_id: string }) => ({
    error: null,
    data: options.malformed ? { partial: true } : {
      asOf: "2026-10-01T12:00:00+00:00",
      limitExceeded: options.limitExceeded ?? null,
      contacts: [{
        id: "agency-contact", created_at: "2026-01-01T00:00:00+00:00",
        last_activity_at: null, source: "manual",
      }],
      leads: [{ pipeline_id: "pipeline-a", stage_id: "stage-a", status: "open" }],
      stages: [{ id: "stage-a", pipeline_id: "pipeline-a" }],
      pipelines: ["pipeline-a"],
      tokenOrg: params.p_organization_id,
    },
  }));
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createAdminClient>);
  return rpc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: agency,
    scopes: ["mcp:read"],
    role: "manager",
    actor: { type: "api_token", id: "token", role: "manager" },
    apiTokenId: "token",
  });
});

describe("Director CRM snapshot", () => {
  it("uses one RPC scoped to the authenticated tenant and exposes no business or personal fields", async () => {
    const rpc = database();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("fn_director_crm_snapshot", {
      p_organization_id: agency,
    });
    const body = await response.json();
    expect(body.data.asOf).toBe("2026-10-01T12:00:00.000Z");
    expect(body.data.contacts).toEqual([{
      externalId: "agency-contact", createdAt: "2026-01-01T00:00:00+00:00",
      lastActivityAt: null, source: "manual",
    }]);
    expect(body.data.funnelSummary).toEqual({
      totalOpen: 1, totalWon: 0, totalLost: 0,
      byStage: [{ pipelineId: "pipeline-a", stageId: "stage-a", open: 1, won: 0, lost: 0 }],
    });
    expect(JSON.stringify(body)).not.toContain("tokenOrg");
    expect(JSON.stringify(body)).not.toContain("agency-business");
  });

  it.each(["contacts", "funnel"] as const)("fails closed when %s exceeds the cap", async (section) => {
    database({ limitExceeded: section });
    const response = await GET(request());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("snapshot_too_large");
  });

  it("fails closed on a malformed RPC result", async () => {
    database({ malformed: true });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
  });
});
