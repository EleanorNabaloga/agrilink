-- Sign-in: request history for rate limiting, role chosen after first sign-in.

create table otp_requests (
  id bigserial primary key,
  phone text not null,
  created_at timestamptz not null default now()
);
create index otp_requests_phone_created_idx on otp_requests (phone, created_at);

-- Language the code was requested in, used as a new user's language.
alter table otp_codes add column lang text not null default 'en' check (lang in ('en','lg','sw','nyn'));

-- A new user has no role until they pick farmer or buyer.
alter table users alter column role drop not null;
