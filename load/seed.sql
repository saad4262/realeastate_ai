-- PLATFORM-PLAN 4.3: seed a DEV database for a load run. Every row is marked `load-` and removed by cleanup.sql.
-- psql "$DIRECT_URL" -v agencies=500 -v agents=2 -v contacts=5000 -v listings=30 -f load/seed.sql
-- V2 (the bar V1 must pass): agencies=500 agents=2 contacts=5000 listings=30 → 1,000 agents, 2.5M contacts,
-- 15,000 listings. That needs the dev database raised to production's compute for the day (PLATFORM-PLAN 4.3).
\set ON_ERROR_STOP 1
-- Refuse production: the pooler's user (postgres.<ref>) or the direct host (db.<ref>.supabase.co) names the project.
select (:'USER' || ' ' || :'HOST') like '%xjklpoyxcvnlhjlxasmv%' as is_production \gset
\if :is_production
  select 'Refusing: that is the production database'::int;
\endif
\if :{?agencies} \else \set agencies 20 \endif
\if :{?agents} \else \set agents 2 \endif
\if :{?contacts} \else \set contacts 200 \endif
\if :{?listings} \else \set listings 10 \endif
\if :{?buyers} \else \set buyers 50 \endif
begin;
insert into agency (name, slug, status)
  select 'Load agency ' || g, 'load-' || g, 'active' from generate_series(1, :agencies) g;
insert into "user" (id, email, name)
  select gen_random_uuid(), format('load-%s-%s@load.test', a, n), format('Agent %s-%s', a, n)
  from generate_series(1, :agencies) a, generate_series(1, :agents) n;
insert into membership (user_id, agency_id, role, status)
  select u.id, ag.id, case when u.email like '%-1@load.test' then 'owner' else 'agent' end::membership_role, 'active'
  from "user" u join agency ag on ag.slug = 'load-' || split_part(split_part(u.email, '@', 1), '-', 2)
  where u.email like 'load-%@load.test';
-- Signed-in site users (no agency) and one platform admin (its own account, never an agency member: ADR 0049).
insert into "user" (id, email, name)
  select gen_random_uuid(), format('load-buyer-%s@load.test', n), 'Buyer ' || n from generate_series(1, :buyers) n;
insert into "user" (id, email, name) values (gen_random_uuid(), 'load-admin@load.test', 'Load admin');
insert into platform_admin (user_id, note) select id, 'load test' from "user" where email = 'load-admin@load.test';
insert into contact (agency_id, name, email, phone)
  select ag.id, 'Contact ' || n, format('c%s.%s@load.test', n, ag.slug), '04' || lpad((n % 100000000)::text, 8, '0')
  from agency ag, generate_series(1, :contacts) n where ag.slug like 'load-%';
with suburbs(suburb, postcode, state) as (values
  ('Richmond', '3121', 'VIC'), ('Pakenham', '3810', 'VIC'), ('Parramatta', '2150', 'NSW'), ('Ryde', '2112', 'NSW'),
  ('Toowong', '4066', 'QLD'), ('Subiaco', '6008', 'WA'), ('Glenelg', '5045', 'SA'), ('Sandy Bay', '7005', 'TAS')),
props as (
  insert into property (street_number, street, suburb, postcode, state, formatted_address, property_type, bedrooms)
  select n::text, 'Load Street', s.suburb, s.postcode, s.state, format('%s Load Street, %s %s %s', n, s.suburb, s.state, s.postcode), 'house', 1 + n % 5
  from generate_series(1, :agencies * :listings) n
  join lateral (select * from suburbs offset (n % 8) limit 1) s on true
  returning id, street_number::int as rn)
insert into listing (property_id, agency_id, channel, status, headline, price_display, price_from, published_at)
  select p.id, ag.id, 'sale', (case when p.rn % 10 = 0 then 'sold' else 'live' end)::listing_status, 'Load listing ' || p.rn,
         '$' || (500000 + p.rn % 900 * 1000), 500000 + p.rn % 900 * 1000, now() - (p.rn % 60) * interval '1 day'
  from props p join agency ag on ag.slug = 'load-' || (1 + (p.rn - 1) % :agencies);
-- Agents see only their own work, so each gets a share: contacts assigned and listings led, round-robin per agency.
create temp table load_agent on commit drop as
  select m.user_id, m.agency_id, u.name, u.email,
         row_number() over (partition by m.agency_id order by u.email) - 1 as i, count(*) over (partition by m.agency_id) as n
  from membership m join agency ag on ag.id = m.agency_id join "user" u on u.id = m.user_id where ag.slug like 'load-%';
update contact c set assigned_to = a.user_id
  from (select c2.id, c2.agency_id, row_number() over (partition by c2.agency_id order by c2.id) as r
        from contact c2 join agency ag on ag.id = c2.agency_id where ag.slug like 'load-%') x
  join load_agent a on a.agency_id = x.agency_id and a.i = x.r % a.n
  where c.id = x.id;
insert into listing_agent (listing_id, user_id, snapshot_name, snapshot_phone, snapshot_email)
  select x.id, a.user_id, a.name, '0400000000', a.email
  from (select l.id, l.agency_id, row_number() over (partition by l.agency_id order by l.id) as r
        from listing l join agency ag on ag.id = l.agency_id where ag.slug like 'load-%') x
  join load_agent a on a.agency_id = x.agency_id and a.i = x.r % a.n;
commit;
select (select count(*) from agency where slug like 'load-%') as agencies, (select count(*) from membership m join agency a on a.id = m.agency_id where a.slug like 'load-%') as members,
       (select count(*) from contact c join agency a on a.id = c.agency_id where a.slug like 'load-%') as contacts,
       (select count(*) from listing l join agency a on a.id = l.agency_id where a.slug like 'load-%') as listings;
