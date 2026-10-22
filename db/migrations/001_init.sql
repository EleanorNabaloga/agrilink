-- AgriLink schema. Money columns are bigint (whole Uganda shillings).

create table users (
  id bigserial primary key,
  phone text not null unique check (phone ~ '^\+256[0-9]{9}$'),
  name text,
  role text not null check (role in ('farmer','buyer','admin','agent')),
  district text,
  language text not null default 'en' check (language in ('en','lg','sw','nyn')),
  payout_phone text check (payout_phone is null or payout_phone ~ '^\+256[0-9]{9}$'),
  payout_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table otp_codes (
  phone text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0
);

create table products (
  id bigserial primary key,
  name_en text not null unique,
  name_lg text not null,
  name_sw text not null,
  name_nyn text not null,
  units text[] not null,
  picture text,
  added_by bigint references users(id),
  added_at timestamptz not null default now()
);

create table voice_notes (
  id bigserial primary key,
  owner_id bigint not null references users(id),
  storage_key text not null,
  duration_seconds int,
  transcript text,
  detected_language text,
  translations jsonb not null default '{}'::jsonb,
  transcription_status text not null default 'pending'
    check (transcription_status in ('pending','done','failed')),
  created_at timestamptz not null default now()
);

create table listings (
  id bigserial primary key,
  farmer_id bigint not null references users(id),
  product_id bigint not null references products(id),
  quantity_available int not null check (quantity_available >= 0),
  unit text not null,
  price_per_unit bigint not null check (price_per_unit > 0),
  district text not null,
  photo text,
  description text,
  voice_note_id bigint references voice_notes(id),
  posted_by bigint references users(id),
  status text not null default 'active' check (status in ('active','sold_out','withdrawn')),
  created_at timestamptz not null default now()
);
create index listings_product_idx on listings (product_id, status);

create table orders (
  id bigserial primary key,
  listing_id bigint not null references listings(id),
  buyer_id bigint not null references users(id),
  farmer_id bigint not null references users(id),
  quantity int not null check (quantity > 0),
  unit_price bigint not null,
  subtotal bigint not null,
  commission_percent numeric not null,
  commission bigint not null,
  provider_fee bigint not null default 0,
  total bigint not null,
  state text not null default 'ordered' check (state in (
    'ordered','awaiting_payment','paid','in_transit','delivered',
    'disputed','releasing','refunding','completed','refunded','cancelled')),
  deadline_at timestamptz,
  transporter_name text,
  transporter_phone text,
  created_at timestamptz not null default now()
);
create index orders_state_idx on orders (state, deadline_at);
create index orders_buyer_idx on orders (buyer_id);
create index orders_farmer_idx on orders (farmer_id);

create table order_events (
  id bigserial primary key,
  order_id bigint not null references orders(id),
  from_state text,
  to_state text not null,
  actor text not null, -- user id as text, or the word system
  note text,
  voice_note_id bigint references voice_notes(id),
  created_at timestamptz not null default now()
);
create index order_events_order_idx on order_events (order_id);

-- Order history is append only: no UPDATE or DELETE.
create function order_events_append_only() returns trigger as $$
begin
  raise exception 'order_events is append only';
end;
$$ language plpgsql;

create trigger order_events_no_update
  before update or delete on order_events
  for each row execute function order_events_append_only();

create table payments (
  id bigserial primary key,
  order_id bigint not null references orders(id),
  kind text not null check (kind in ('charge','payout','refund')),
  amount bigint not null,
  reference text not null unique,
  provider_ref text,
  status text not null default 'pending'
    check (status in ('pending','retry_due','successful','stuck')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_order_idx on payments (order_id);
create index payments_retry_idx on payments (status, next_attempt_at);

create table messages (
  id bigserial primary key,
  order_id bigint not null references orders(id),
  sender_id bigint not null references users(id),
  text text,
  voice_note_id bigint references voice_notes(id),
  created_at timestamptz not null default now()
);
create index messages_order_idx on messages (order_id);

create table follows (
  user_id bigint not null references users(id),
  product_id bigint not null references products(id),
  district text,
  sms_enabled boolean not null default false
);
create unique index follows_unique_idx on follows (user_id, product_id, coalesce(district, ''));

-- Notifications store keys, rendered in the reader's language when viewed.
create table notifications (
  id bigserial primary key,
  user_id bigint not null references users(id),
  kind text not null,
  title_key text not null,
  body_key text not null,
  vars jsonb not null default '{}'::jsonb,
  link text,
  read_at timestamptz,
  sms_status text,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, read_at);

create table synced_actions (
  action_id text primary key,
  user_id bigint not null references users(id),
  action text not null,
  result jsonb,
  phone_time timestamptz,
  received_at timestamptz not null default now()
);
