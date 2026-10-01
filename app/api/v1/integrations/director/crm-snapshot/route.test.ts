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
const other = "22222222-2222-4222-8222-222222222222";

function request(): NextRequest {
  return new Request("https://crm.example.test/api/v1/integrations/director/crm-snapshot", {
    headers: { authorization: "Bearer dsk_test" },
  }) as NextRequest;
}

function database(options: { tooManyLeads?: boolean; contactCount?: number } = {}) {
  const contactCount = options.contactCount ?? 1;
  const records: Record<string, Array<Record<string, unknown>>> = {
    contacts: [
      { organization_id: agency, id: "agency-contact", created_at: "2026-01-01T00:00:00Z", last_activity_at: null, source: "manual" },
      ...Array.from({ length: contactCount - 1 }, (_, index) => ({
        organization_id: agency,
        id: `agency-contact-${index}`,
        created_at: "2026-01-01T00:00:00Z",
        last_activity_at: null,
        source: "manual",
      })),
      { organization_id: other, id: "other-contact", created_at: "2026-01-01T00:00:00Z", last_activity_at: null, source: "manual" },
    ],
    crm_leads: [
      { organization_id: agency, id: "agency-business", pipeline_id: "pipeline-a", stage_id: "stage-a", status: "open" },
      { organization_id: other, id: "other-business", pipeline_id: "pipeline-b", stage_id: "stage-b", status: "won" },
    ],
    crm_stages: [
      { organization_id: agency, id: "stage-a", pipeline_id: "pipeline-a", name: "Proposta" },
      { organization_id: other, id: "stage-b", pipeline_id: "pipeline-b", name: "Cliente secreto" },
    ],
    crm_pipelines: [
      { organization_id: agency, id: "pipeline-a" },
      { organization_id: other, id: "pipeline-b" },
    ],
  };
  const queries: Array<{ table: string; scope: string | null }> = [];
  const from = vi.fn((table: string) => {
    let scope: string | null = null;
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: string) => {
        if (column === "organization_id") scope = value;
        return query;
      }),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => {
        queries.push({ table, scope });
        return { data: records[table]!.filter((row) => row.organization_id === scope), error: null };
      }),
      range: vi.fn(async (start: number, end: number) => {
        queries.push({ table, scope });
        const scoped = records[table]!.filter((row) => row.organization_id === scope);
        return {
          data: scoped.slice(start, end + 1),
          count: options.tooManyLeads && table === "crm_leads" ? 5001 : scoped.length,
          error: null,
        };
      }),
    };
    return query;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof createAdminClient>);
  return queries;
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

describe("Director CRM snapshot funnel extension", () => {
  it("filters all four service-role reads by the authenticated tenant and returns no business identifiers", async () => {
    const queries = database();
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.contacts).toHaveLength(1);
    expect(body.data.contacts[0].externalId).toBe("agency-contact");
    expect(body.data.funnelSummary).toEqual({
      totalOpen: 1,
      totalWon: 0,
      totalLost: 0,
      byStage: [{ pipelineId: "pipeline-a", stageId: "stage-a", open: 1, won: 0, lost: 0 }],
    });
    expect(queries).toEqual([
      { table: "contacts", scope: agency },
      { table: "crm_leads", scope: agency },
      { table: "crm_stages", scope: agency },
      { table: "crm_pipelines", scope: agency },
    ]);
    expect(JSON.stringify(body)).not.toContain("agency-business");
    expect(JSON.stringify(body)).not.toContain("other-business");
    expect(JSON.stringify(body)).not.toContain("Proposta");
    expect(JSON.stringify(body)).not.toContain("Cliente secreto");
  });

  it("fails closed instead of returning a partial funnel above the cap", async () => {
    database({ tooManyLeads: true });
    const response = await GET(request());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("snapshot_too_large");
  });

  it("reads all contact pages instead of treating the first PostgREST page as complete", async () => {
    const queries = database({ contactCount: 1_001 });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).data.contacts).toHaveLength(1_001);
    expect(queries.filter((query) => query.table === "contacts")).toHaveLength(3);
  });

  it("fails closed when the contact count exceeds the cap", async () => {
    database({ contactCount: 5_001 });
    const response = await GET(request());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("snapshot_too_large");
  });
});
