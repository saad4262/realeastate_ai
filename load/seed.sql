-- PLATFORM-PLAN 4.3: seed a DEV database for a load run. Every row is marked `load-` and removed by cleanup.sql.
-- psql "$DIRECT_URL" -v agencies=500 -v agents=2 -v contacts=5000 -v listings=30 -f load/seed.sql
-- V2 (the bar V1 must pass): agencies=500 agents=2 contacts=5000 listings=30 → 1,000 agents, 2.5M contacts,
-- 15,000 listings. That needs the dev database raised to production's compute for the day (PLATFORM-PLAN 4.3).
\set ON_ERROR_STOP 1
\if :{?agencies} \else \set agencies 20 \endif
\if :{?agents} \else \set agents 2 \endif
\if :{?contacts} \else \set contacts 200 \endif
\if :{?listings} \else \set listings 10 \endif
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
commit;
select (select count(*) from agency where slug like 'load-%') as agencies, (select count(*) from membership m join agency a on a.id = m.agency_id where a.slug like 'load-%') as members,
       (select count(*) from contact c join agency a on a.id = c.agency_id where a.slug like 'load-%') as contacts,
       (select count(*) from listing l join agency a on a.id = l.agency_id where a.slug like 'load-%') as listings;
