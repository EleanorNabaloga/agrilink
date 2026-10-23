-- When a payout/refund row was first claimed for sending; a row still unfinished 3 hours later is marked stuck.
alter table payments add column first_claimed_at timestamptz;
-- Rows already in flight keep their age instead of getting a fresh 3-hour clock.
update payments set first_claimed_at = updated_at where status in ('pending', 'retry_due') and attempts > 0;
