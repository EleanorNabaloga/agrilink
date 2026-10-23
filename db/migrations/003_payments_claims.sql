-- When a payout/refund row was first claimed for sending; a row still unfinished 3 hours later is marked stuck.
alter table payments add column first_claimed_at timestamptz;
