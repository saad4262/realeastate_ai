-- PLATFORM-PLAN 4.3: remove everything seed.sql made (DEV only). Listings first: they keep an agency from deleting.
\set ON_ERROR_STOP 1
begin;
create temp table load_listing as select l.id, l.property_id from listing l join agency a on a.id = l.agency_id where a.slug like 'load-%';
delete from listing where id in (select id from load_listing);
delete from property where id in (select property_id from load_listing) and not exists (select 1 from listing l where l.property_id = property.id);
delete from agency where slug like 'load-%';
delete from "user" where email like 'load-%@load.test';
commit;
