-- Uma chamada RPC substitui quatro leituras PostgREST paginadas. Uma funcao
-- SQL STABLE executa a projecao sob o snapshot MVCC da instrucao que a chama.
-- O service_role usa o organization_id do bearer validado pela rota; nenhum
-- papel de sessao ou anonimo pode chamar a funcao diretamente.
create or replace function public.fn_director_crm_snapshot(p_organization_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with
  contatos as materialized (
    select c.id, c.created_at, c.last_activity_at, c.source
    from public.contacts c
    where c.organization_id = p_organization_id
      and c.kind = 'person'
      and c.is_merged_into is null
    order by c.last_activity_at asc nulls first, c.id
    limit 5001
  ),
  negocios as materialized (
    select l.pipeline_id, l.stage_id, l.status
    from public.crm_leads l
    where l.organization_id = p_organization_id
    order by l.id
    limit 5001
  ),
  etapas as materialized (
    select s.id, s.pipeline_id
    from public.crm_stages s
    where s.organization_id = p_organization_id
    order by s.id
    limit 5001
  ),
  funis as materialized (
    select p.id
    from public.crm_pipelines p
    where p.organization_id = p_organization_id
    order by p.id
    limit 5001
  ),
  limites as (
    select
      (select count(*) from contatos) > 5000 as contatos_excedidos,
      (select count(*) from negocios) > 5000
        or (select count(*) from etapas) > 5000
        or (select count(*) from funis) > 5000 as funil_excedido
  )
  select jsonb_build_object(
    'asOf', statement_timestamp(),
    'limitExceeded', case
      when limites.contatos_excedidos then 'contacts'
      when limites.funil_excedido then 'funnel'
      else null
    end,
    'contacts', case when limites.contatos_excedidos then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'created_at', c.created_at,
        'last_activity_at', c.last_activity_at, 'source', c.source
      ) order by c.last_activity_at asc nulls first, c.id), '[]'::jsonb)
      from contatos c
    ) end,
    'leads', case when limites.funil_excedido then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object(
        'pipeline_id', l.pipeline_id, 'stage_id', l.stage_id, 'status', l.status
      ) order by l.pipeline_id, l.stage_id), '[]'::jsonb)
      from negocios l
    ) end,
    'stages', case when limites.funil_excedido then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'pipeline_id', s.pipeline_id)
        order by s.id), '[]'::jsonb)
      from etapas s
    ) end,
    'pipelines', case when limites.funil_excedido then '[]'::jsonb else (
      select coalesce(jsonb_agg(p.id order by p.id), '[]'::jsonb)
      from funis p
    ) end
  )
  from limites;
$$;

revoke execute on function public.fn_director_crm_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.fn_director_crm_snapshot(uuid) to service_role;
