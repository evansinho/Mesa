-- Postgres restricts using a newly-added enum value in the same transaction
-- that adds it — kept in its own migration file, separate from
-- 0043's column additions, so nothing in this same migration batch ever
-- tries to write one of these values before it's committed.
ALTER TYPE "fulfilment_status" ADD VALUE IF NOT EXISTS 'QUOTE_PENDING';
ALTER TYPE "fulfilment_status" ADD VALUE IF NOT EXISTS 'BOOKED';
ALTER TYPE "fulfilment_status" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
