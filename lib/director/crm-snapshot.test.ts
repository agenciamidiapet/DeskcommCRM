import { describe, expect, it } from "vitest";

import { buildDirectorCrmSnapshot, buildDirectorFunnelSummary } from "@/lib/director/crm-snapshot";

describe("buildDirectorCrmSnapshot", () => {
  it("projects only the activity signal required by Director", () => {
    const snapshot = buildDirectorCrmSnapshot(
      [
        {
          id: "b54c9cef-feb9-4a61-91f4-5d5312f8a801",
          created_at: "2026-06-01T10:00:00.000Z",
          last_activity_at: "2026-07-01T10:00:00.000Z",
          source: "WhatsApp",
        },
      ],
      new Date("2026-09-29T12:00:00.000Z"),
    );

    expect(snapshot).toEqual({
      asOf: "2026-09-29T12:00:00.000Z",
      contacts: [
        {
          externalId: "b54c9cef-feb9-4a61-91f4-5d5312f8a801",
          createdAt: "2026-06-01T10:00:00.000Z",
          lastActivityAt: "2026-07-01T10:00:00.000Z",
          source: "whatsapp",
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/name|email|phone|tag|conversation/i);
  });

  it("does not invent service interest and classifies unknown sources safely", () => {
    const snapshot = buildDirectorCrmSnapshot(
      [{ id: "id-1", created_at: "2026-06-01T10:00:00.000Z", last_activity_at: null, source: "custom vendor value" }],
      new Date("2026-09-29T12:00:00.000Z"),
    );

    expect(snapshot.contacts[0]).toEqual({
      externalId: "id-1",
      createdAt: "2026-06-01T10:00:00.000Z",
      lastActivityAt: null,
      source: "other",
    });
    expect(snapshot.contacts[0]).not.toHaveProperty("serviceInterest");
  });
});

describe("buildDirectorFunnelSummary", () => {
  const stages = [
    { id: "stage-a", pipeline_id: "pipeline-a" },
    { id: "stage-b", pipeline_id: "pipeline-b" },
  ];

  it("counts actual business statuses by stage without projecting lead or contact data", () => {
    const summary = buildDirectorFunnelSummary(
      [
        { pipeline_id: "pipeline-a", stage_id: "stage-a", status: "open" },
        { pipeline_id: "pipeline-a", stage_id: "stage-a", status: "won" },
        { pipeline_id: "pipeline-b", stage_id: "stage-b", status: "lost" },
      ],
      stages,
      ["pipeline-a", "pipeline-b"],
    );

    expect(summary).toEqual({
      totalOpen: 1,
      totalWon: 1,
      totalLost: 1,
      byStage: [
        { pipelineId: "pipeline-a", stageId: "stage-a", open: 1, won: 1, lost: 0 },
        { pipelineId: "pipeline-b", stageId: "stage-b", open: 0, won: 0, lost: 1 },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(/contactId|leadId|title|description|valueCents/i);
  });

  it("returns a measured zero when no businesses exist", () => {
    expect(buildDirectorFunnelSummary([], stages, ["pipeline-a", "pipeline-b"])).toEqual({
      totalOpen: 0,
      totalWon: 0,
      totalLost: 0,
      byStage: [],
    });
  });

  it("rejects cross-pipeline, unknown-stage and unknown-status rows", () => {
    expect(() => buildDirectorFunnelSummary(
      [{ pipeline_id: "pipeline-b", stage_id: "stage-a", status: "open" }],
      stages,
      ["pipeline-a", "pipeline-b"],
    )).toThrow();
    expect(() => buildDirectorFunnelSummary(
      [{ pipeline_id: "pipeline-a", stage_id: "unknown", status: "open" }],
      stages,
      ["pipeline-a"],
    )).toThrow();
    expect(() => buildDirectorFunnelSummary(
      [{ pipeline_id: "pipeline-a", stage_id: "stage-a", status: "pending" }],
      stages,
      ["pipeline-a"],
    )).toThrow();
  });
});
