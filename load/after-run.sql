-- PLATFORM-PLAN 4.3: run against the target database after every load, spike, soak or recovery run.
-- Every count must be 0. (Cross-agency reads are checked by the smoke sweeps, 4.9; here, what the run left behind.)
select 'texts sent twice (same provider SID on two rows)' as check, count(*) as n from (
  select provider_sid from sms_message where provider_sid is not null group by provider_sid having count(*) > 1) d
union all
select 'bulk recipients with two texts', count(*) from (
  select r.id from email_batch_recipient r join sms_message s on s.id = r.sms_message_id group by r.id having count(*) > 1) d
union all
select 'texts stuck queued > 15 min with no SID', count(*) from sms_message
  where direction = 'out' and status = 'queued' and provider_sid is null and created_at < now() - interval '15 minutes'
union all
select 'stored Stripe events with no job', count(*) from stripe_event e
  where not exists (select 1 from job j where j.kind = 'stripe.event' and j.payload->>'eventId' = e.id)
union all
select 'credit grants twice for one payment', count(*) from (
  select stripe_ref from ai_credit_grant where stripe_ref is not null group by stripe_ref having count(*) > 1) d
union all
select 'jobs dead after the run', count(*) from job where status = 'dead' and finished_at > now() - interval '3 hours'
union all
select 'jobs leased and abandoned (lease is 5 min)', count(*) from job where status = 'running' and claimed_at < now() - interval '10 minutes';
