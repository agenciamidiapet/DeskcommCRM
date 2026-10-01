import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_CONTACT_1, GOV_LEAD, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql,
} from "./gov-helpers";

const OTHER_ORG = "eeeeeeee-0000-4000-8000-000000000491";
const OTHER_CONTACT = "eeeeeeee-3333-4000-8000-000000000491";
const LARGE_ORG = "eeeeeeee-0000-4000-8000-000000000492";

function read(orgId: string): Record<string, unknown> {
  return JSON.parse(sql(`select public.fn_director_crm_snapshot('${orgId}');`)) as Record<string, unknown>;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values
      ('${OTHER_ORG}', 'director-other-0491', 'Director Other 0491', 'Other 0491'),
      ('${LARGE_ORG}', 'director-large-0491', 'Director Large 0491', 'Large 0491')
    on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name)
    values ('${OTHER_CONTACT}', '${OTHER_ORG}', 'Nome que nao deve sair')
    on conflict (id) do nothing;
    insert into public.contacts (organization_id)
    select '${LARGE_ORG}' from generate_series(1, 5001);
  `);
});

describe("snapshot consistente do Diretor no PostgreSQL real", () => {
  it("isola o tenant e entrega apenas as colunas permitidas", () => {
    const snapshot = read(GOV_ORG);
    expect(snapshot.limitExceeded).toBeNull();
    const contacts = snapshot.contacts as Array<Record<string, unknown>>;
    expect(contacts.some((contact) => contact.id === GOV_CONTACT_1)).toBe(true);
    expect(contacts.some((contact) => contact.id === OTHER_CONTACT)).toBe(false);
    expect(Object.keys(contacts[0] ?? {}).sort()).toEqual([
      "created_at", "id", "last_activity_at", "source",
    ]);
    const leads = snapshot.leads as Array<Record<string, unknown>>;
    expect(leads.some((lead) => lead.pipeline_id === GOV_PIPELINE && lead.stage_id === GOV_STAGE)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(GOV_LEAD);
    expect(JSON.stringify(snapshot)).not.toContain("Nome que nao deve sair");
  });

  it("recusa o teto sem entregar contatos parciais", () => {
    const snapshot = read(LARGE_ORG);
    expect(snapshot.limitExceeded).toBe("contacts");
    expect(snapshot.contacts).toEqual([]);
  });

  it("somente service_role executa a RPC", () => {
    const grants = sql(`select
      has_function_privilege('service_role', 'public.fn_director_crm_snapshot(uuid)', 'execute'),
      has_function_privilege('anon', 'public.fn_director_crm_snapshot(uuid)', 'execute'),
      has_function_privilege('authenticated', 'public.fn_director_crm_snapshot(uuid)', 'execute');`);
    expect(grants).toBe("t|f|f");
  });

  it("a função é STABLE e não é SECURITY DEFINER", () => {
    const properties = sql(`select provolatile, prosecdef
      from pg_proc where oid='public.fn_director_crm_snapshot(uuid)'::regprocedure;`);
    expect(properties).toBe("s|f");
  });
});
