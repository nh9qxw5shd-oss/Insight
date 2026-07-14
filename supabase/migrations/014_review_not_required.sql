-- Review downgrade: an SNDM can mark an incident that was flagged for review
-- (delay threshold or a trigger mention) as not actually needing one. The row
-- is excluded from the reviewable count exactly like an auto-N/A incident,
-- while recording that a human made that call (reviewed_by / reviewed_at on
-- the same row).
alter table incident_reviews
  add column if not exists review_not_required boolean not null default false;
