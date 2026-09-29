import { describe, expect, it } from "vitest";

import { buildDirectorCrmSnapshot } from "@/lib/director/crm-snapshot";

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
