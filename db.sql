-- =============================================================
-- AFC / Events platform - Postgres schema proposal (MVP)
-- Notes:
-- - Uses ENUMs for core status fields.
-- - Uses JSONB for flexible payload/attributes.
-- - Assumes 1 ticket per user per event, and 1 check-in per user per event.
-- - Geofence is enforced per event when events.geo_enforced = true.
-- - Hours are tracked via an auditable ledger.
-- =============================================================

BEGIN;

-- ----------
-- Extensions (recommended)
-- ----------
-- pgcrypto: optional if you want UUIDs / random tokens in DB.
-- citext: best practice for case-insensitive email uniqueness.
CREATE EXTENSION IF NOT EXISTS citext;
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------
-- ENUM types (core dictionaries)
-- ----------
DO $$ BEGIN
  CREATE TYPE membership_role AS ENUM ('student','staff','admin','auditor','visitor');
EXCEPTION
  WHEN duplicate_object THEN
    BEGIN
      -- If type already existed without 'visitor', ensure it is added
      ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'visitor';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

DO $$ BEGIN
  CREATE TYPE event_status AS ENUM ('draft','published','cancelled','ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE registration_mode AS ENUM ('auto','manual_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE resubmission_policy AS ENUM ('allowed','only_changes_requested','not_allowed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE cancel_policy AS ENUM ('free_cancel','locked','penalize_no_show');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE registration_status AS ENUM (
    'pending',
    'changes_requested',
    'approved',
    'rejected',
    'blocked',
    'cancelled_by_user',
    'cancelled_by_admin'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('active','used','revoked','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE ticket_status ADD VALUE IF NOT EXISTS 'used';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE checkin_source AS ENUM ('self','staff');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE checkin_result AS ENUM ('accepted','rejected','duplicate','invalid_ticket','cancelled_ticket');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE geo_reason AS ENUM ('ok','no_gps','out_of_radius','low_accuracy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ledger_reason AS ENUM ('checkin','adjustment','override');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------
-- Core tables
-- ----------

CREATE TABLE IF NOT EXISTS orgs (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS careers (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  faculty       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS event_categories (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO event_categories (key, name, description)
VALUES
  ('general', 'General', 'Categoría por defecto'),
  ('culturales', 'Culturales', 'Eventos culturales y artísticos'),
  ('deportivas', 'Deportivas', 'Eventos deportivos'),
  ('investigacion', 'Investigación', 'Eventos de investigación'),
  ('vinculacion', 'Vinculación', 'Eventos de vinculación académica y profesional'),
  ('emprendimiento', 'Emprendimiento', 'Eventos de innovación, startups y emprendimiento'),
  ('responsabilidad_social', 'Responsabilidad Social', 'Actividades con impacto social y comunitario'),
  ('formacion_humana', 'Formación Humana', 'Desarrollo personal, ética y valores')
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         CITEXT NOT NULL UNIQUE,

  -- Auth fields
  password_hash TEXT NOT NULL, -- store bcrypt/argon2 hash, NEVER plain password
  email_verified_at TIMESTAMPTZ,

  -- Personal info (split for better integrations like Google OAuth)
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  middle_name   TEXT,

  -- Academic identifier ("boleta" / matrícula). Optional.
  student_id    TEXT,
  career_id     BIGINT REFERENCES careers(id) ON DELETE SET NULL,

  -- Extra metadata (e.g., staff users tied to events)
  attributes    JSONB,

  -- Optional provider info (future Google integration)
  oauth_provider TEXT,              -- e.g., 'google'
  oauth_subject  TEXT,              -- provider user id (sub)

  status        TEXT NOT NULL DEFAULT 'active',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (oauth_provider, oauth_subject),
  UNIQUE (student_id)
);



CREATE TABLE IF NOT EXISTS memberships (
  id            BIGSERIAL PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Role of this user inside this org (multi-tenant-safe)
  role          membership_role NOT NULL DEFAULT 'student',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS career_id BIGINT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS attributes JSONB;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT fk_users_career_id
    FOREIGN KEY (career_id)
    REFERENCES careers(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Migración legacy: users.career (texto) -> users.career_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name = 'career'
  ) THEN
    EXECUTE $sql$
      UPDATE users u
      SET career_id = c.id
      FROM careers c
      WHERE u.career_id IS NULL
        AND u.career IS NOT NULL
        AND lower(trim(u.career)) = lower(trim(c.name))
    $sql$;
  END IF;
END $$;


-- ----------
-- Roles / permissions (optional but recommended for "special admin" actions)
-- ----------
-- If simple roles are enough, you can skip this section and only use memberships.role.
-- If you need fine-grained permissions (e.g., "can_adjust_hours", "can_block_user"), use these tables.

CREATE TABLE IF NOT EXISTS permissions (
  key         TEXT PRIMARY KEY,        -- e.g., 'hours.adjust', 'users.block', 'events.publish'
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role        membership_role NOT NULL,
  perm_key    TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role, perm_key)
);

-- Optional: user-level permission grants/denies (overrides role defaults)
CREATE TABLE IF NOT EXISTS user_permissions (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm_key    TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  effect      TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, perm_key)
);

-- Convenience view: effective permissions per user in an org (role + grants/denies)
-- NOTE: This is a simple approach; many teams compute this in the app layer for performance.
CREATE OR REPLACE VIEW v_effective_permissions AS
WITH base AS (
  SELECT m.org_id, m.user_id, rp.perm_key, 'grant'::text AS effect
  FROM memberships m
  JOIN role_permissions rp ON rp.role = m.role
), overrides AS (
  SELECT org_id, user_id, perm_key, effect
  FROM user_permissions
)
SELECT
  COALESCE(o.org_id, b.org_id) AS org_id,
  COALESCE(o.user_id, b.user_id) AS user_id,
  COALESCE(o.perm_key, b.perm_key) AS perm_key,
  COALESCE(o.effect, b.effect) AS effect
FROM base b
FULL OUTER JOIN overrides o
  ON o.org_id = b.org_id AND o.user_id = b.user_id AND o.perm_key = b.perm_key;


-- ----------
-- Events + geofence
-- ----------

CREATE TABLE IF NOT EXISTS events (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description           TEXT,
  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ NOT NULL,
  hours_value           NUMERIC(6,2) NOT NULL DEFAULT 0,
  capacity              INTEGER,
  capacity_enabled      BOOLEAN NOT NULL DEFAULT false,

  -- Basic sanity checks
  CONSTRAINT chk_events_time_range CHECK (ends_at > starts_at),
  CONSTRAINT chk_events_hours_nonnegative CHECK (hours_value >= 0),
  CONSTRAINT chk_events_capacity_nonnegative CHECK (capacity IS NULL OR capacity >= 0),
  CONSTRAINT chk_events_capacity_when_enabled CHECK (
    (capacity_enabled = false AND capacity IS NULL)
    OR (capacity_enabled = true AND capacity IS NOT NULL AND capacity > 0)
  ),


  status                event_status NOT NULL DEFAULT 'draft',

  -- Registration / ticketing rules
  registration_mode     registration_mode NOT NULL DEFAULT 'auto',
  resubmission_policy   resubmission_policy NOT NULL DEFAULT 'only_changes_requested',

  -- Check-in rules
  allow_self_checkin    BOOLEAN NOT NULL DEFAULT false,

  -- Event location (can be physical place name, address, or URL for virtual events)
  location              TEXT,
  cover_image_url       TEXT,

  -- Geo policy
  geo_enforced          BOOLEAN NOT NULL DEFAULT false,

  -- Cancellation / no-show policy (optional now, useful later)
  cancel_policy         cancel_policy NOT NULL DEFAULT 'free_cancel',
  cancel_deadline       TIMESTAMPTZ,

  -- Flexible attributes for future features
  attributes            JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_org_starts ON events (org_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);
CREATE INDEX IF NOT EXISTS idx_events_capacity_enabled_active
  ON events (org_id, starts_at DESC, capacity)
  WHERE capacity_enabled = true;
CREATE INDEX IF NOT EXISTS idx_events_attrs_gin ON events USING GIN (attributes);

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS capacity INTEGER,
  ADD COLUMN IF NOT EXISTS capacity_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

DO $$ BEGIN
  ALTER TABLE events
    ADD CONSTRAINT chk_events_capacity_nonnegative
    CHECK (capacity IS NULL OR capacity >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE events
    ADD CONSTRAINT chk_events_capacity_when_enabled
    CHECK (
      (capacity_enabled = false AND capacity IS NULL)
      OR (capacity_enabled = true AND capacity IS NOT NULL AND capacity > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE events
SET capacity = NULLIF(trim(attributes->>'cupo'), '')::int
WHERE attributes ? 'cupo'
  AND (attributes->>'cupo') ~ '^\s*\d+\s*$'
  AND capacity IS NULL;

UPDATE events
SET capacity_enabled = (capacity IS NOT NULL AND capacity > 0);

UPDATE events
SET attributes = attributes - 'cupo'
WHERE attributes ? 'cupo';

CREATE TABLE IF NOT EXISTS event_geo (
  event_id              BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  center_lat            NUMERIC(9,6) NOT NULL,
  center_lng            NUMERIC(9,6) NOT NULL,
  radius_m              INTEGER NOT NULL,
  strict_accuracy_m     INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------
-- Registrations (application / approval workflow)
-- ----------

CREATE TABLE IF NOT EXISTS registrations (
  id                    BIGSERIAL PRIMARY KEY,
  event_id              BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  status                registration_status NOT NULL DEFAULT 'pending',

  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,

  decision_reason       TEXT,

  -- Form answers / uploaded-metadata pointers / extra fields
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Optional future use
  blocked_until         TIMESTAMPTZ,

  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_registrations_user ON registrations (user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations (event_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations (status);

-- ----------
-- Tickets (QR tokens). Created only when registration is approved
-- ----------

CREATE TABLE IF NOT EXISTS tickets (
  id                    BIGSERIAL PRIMARY KEY,
  event_id              BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_id       BIGINT REFERENCES registrations(id) ON DELETE SET NULL,

  ticket_code           TEXT NOT NULL UNIQUE,
  CONSTRAINT chk_ticket_code_len CHECK (length(ticket_code) >= 24),

  status                ticket_status NOT NULL DEFAULT 'active',

  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ,

  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (user_id, event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets (event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_user_active
  ON tickets (user_id, event_id)
  WHERE status = 'active';


-- ----------
-- Event sessions (BASE for classes / multi-day events)
-- ----------
-- Each event can have one or many sessions (e.g., classes, multi-day events).
-- For single-day events, create exactly ONE session.

CREATE TABLE IF NOT EXISTS event_sessions (
  id            BIGSERIAL PRIMARY KEY,
  event_id      BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  label         TEXT,
  hours_value   NUMERIC(6,2), -- if NULL, fallback to events.hours_value
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_event_sessions_time_range CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_event_sessions_event_starts
  ON event_sessions (event_id, starts_at);


-- ----------
-- Check-ins (1 per user per SESSION)
-- ----------

CREATE TABLE IF NOT EXISTS checkins (
  id                    BIGSERIAL PRIMARY KEY,
  event_id              BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id            BIGINT NOT NULL REFERENCES event_sessions(id) ON DELETE CASCADE,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id             BIGINT REFERENCES tickets(id) ON DELETE SET NULL,

  checkin_source        checkin_source NOT NULL,
  scanner_admin_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT chk_checkins_source_staff_requires_scanner CHECK (
    (checkin_source = 'staff' AND scanner_admin_id IS NOT NULL)
    OR (checkin_source = 'self' AND scanner_admin_id IS NULL)
  ),

  scanned_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- GPS evidence
  client_lat            NUMERIC(9,6),
  client_lng            NUMERIC(9,6),
  accuracy_m            INTEGER,
  distance_m            INTEGER,
  geo_ok                BOOLEAN NOT NULL DEFAULT false,
  geo_reason            geo_reason NOT NULL DEFAULT 'ok',

  result                checkin_result NOT NULL,

  meta                  JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_checkins_event_time ON checkins (event_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_user_time ON checkins (user_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_scanner_time ON checkins (scanner_admin_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_result ON checkins (result);

-- Common access patterns: accepted attendance lists and active tickets.
CREATE INDEX IF NOT EXISTS idx_checkins_event_time_accepted
  ON checkins (event_id, scanned_at DESC)
  WHERE result = 'accepted';


-- ----------
-- Hours ledger (auditable)
-- ----------

CREATE TABLE IF NOT EXISTS hours_ledger (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id              BIGINT REFERENCES events(id) ON DELETE SET NULL,

  hours_delta           NUMERIC(6,2) NOT NULL,
  reason                ledger_reason NOT NULL,

  source_checkin_id     BIGINT REFERENCES checkins(id) ON DELETE SET NULL,

  created_by            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  note                  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent double-crediting the same check-in
  UNIQUE (source_checkin_id)
);

CREATE INDEX IF NOT EXISTS idx_hours_ledger_user ON hours_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hours_ledger_event ON hours_ledger (event_id);

-- ----------
-- Optional: attendance flags (e.g., NO_SHOW)
-- ----------
DO $$ BEGIN
  CREATE TYPE attendance_flag_type AS ENUM ('no_show');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS attendance_flags (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id              BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  flag_type             attendance_flag_type NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  note                  TEXT,
  UNIQUE (user_id, event_id, flag_type)
);

-- ----------
-- Multi-day / multi-occurrence events (ADD-ON / optional)
-- ----------
-- Use this if:
-- - A ticket should grant access on multiple different days for the same event (e.g., festival, 3-day congress), OR
-- - The same event concept has multiple occurrences.
--
-- Approach:
-- 1) Create sessions (occurrences) under an event.
-- 2) Tickets remain UNIQUE(event_id, user_id).
-- 3) Check-ins become UNIQUE(session_id, user_id) (1 check-in per day/occurrence).
--
-- Example table:
-- CREATE TABLE IF NOT EXISTS event_sessions (
--   id          BIGSERIAL PRIMARY KEY,
--   event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
--   starts_at   TIMESTAMPTZ NOT NULL,
--   ends_at     TIMESTAMPTZ NOT NULL,
--   label       TEXT,
--   created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
--   CONSTRAINT chk_event_sessions_time_range CHECK (ends_at > starts_at)
-- );
--
-- CREATE INDEX IF NOT EXISTS idx_event_sessions_event_starts ON event_sessions (event_id, starts_at);
--
-- Then modify checkins:
-- - Add: session_id BIGINT REFERENCES event_sessions(id)
-- - Replace UNIQUE(event_id, user_id) with UNIQUE(session_id, user_id)
--
-- Minimal migration idea (outline):
-- 1) Add session_id nullable.
-- 2) Backfill session_id for existing checkins (create 1 session per event using events.starts_at/ends_at).
-- 3) Drop old unique(event_id,user_id).
-- 4) Add new unique(session_id,user_id).
--
-- ----------
-- Helpful views (optional)
-- ----------

-- Current hours balance per user (computed)
CREATE OR REPLACE VIEW v_user_hours_balance AS
SELECT
  user_id,
  COALESCE(SUM(hours_delta), 0) AS hours_total
FROM hours_ledger
GROUP BY user_id;

COMMIT;

-- =============================================================
-- Suggested backend invariants (implement in application logic)
-- =============================================================
-- 1) DB enforces staff/self invariants via chk_checkins_source_staff_requires_scanner.
--    Additionally, backend should validate per-event policy:
--    - if events.allow_self_checkin = false => only allow checkin_source='staff'.
--    - if events.allow_self_checkin = true => allow 'self' (and optionally 'staff').
-- 2) If events.geo_enforced = true => require GPS fields, enforce radius/accuracy.
-- 3) Tickets should be created only when registrations.status becomes 'approved'.
-- 4) For accepted checkins, insert hours_ledger with reason='checkin' and
--    hours_delta = events.hours_value.
-- 5) Admin adjustments insert hours_ledger with reason='adjustment' and a note.
-- =============================================================
