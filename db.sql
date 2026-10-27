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

-- clave_carrera: clave oficial UNAM de la carrera (NULL si aún no se conoce).
-- afc_hours: meta de horas AFC de la carrera; los check-ins dejan de sumar al alcanzarla.
ALTER TABLE careers
  ADD COLUMN IF NOT EXISTS clave_carrera TEXT,
  ADD COLUMN IF NOT EXISTS afc_hours NUMERIC(6,2) NOT NULL DEFAULT 480;

CREATE UNIQUE INDEX IF NOT EXISTS uq_careers_clave_carrera
  ON careers (clave_carrera)
  WHERE clave_carrera IS NOT NULL;

-- afc_hours = 0: la carrera no contabiliza horas AFC.
ALTER TABLE careers DROP CONSTRAINT IF EXISTS chk_careers_afc_hours;
ALTER TABLE careers ADD CONSTRAINT chk_careers_afc_hours CHECK (afc_hours >= 0);

DO $$ BEGIN
  ALTER TABLE careers
    ADD CONSTRAINT chk_careers_clave_format CHECK (clave_carrera IS NULL OR clave_carrera ~ '^[0-9]{1,10}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Horas de Formación Complementaria por carrera (FES Aragón).
WITH career_data (name, clave_carrera, afc_hours) AS (
  VALUES
    ('Ingeniería Civil', '2236', 480),
    ('Ingeniería en Computación', '2119', 480),
    ('Ingeniería Eléctrica Electrónica', '2217', 480),
    ('Ingeniería Industrial', '2195', 480),
    ('Ingeniería Mecánica', '2187', 480),
    ('Sociología', '2276', 480),
    ('Derecho', '2254', 480),
    ('Relaciones Internacionales', NULL, 480),
    ('Comunicación y Periodismo', '2302', 480),
    ('Arquitectura', '2336', 240)
), updated AS (
  UPDATE careers c
  SET name = d.name,
      clave_carrera = COALESCE(d.clave_carrera, c.clave_carrera),
      afc_hours = d.afc_hours
  FROM career_data d
  WHERE lower(c.name) = lower(d.name)
  RETURNING c.id
)
INSERT INTO careers (name, faculty, clave_carrera, afc_hours)
SELECT d.name, 'FES Aragón', d.clave_carrera, d.afc_hours
FROM career_data d
WHERE NOT EXISTS (SELECT 1 FROM careers c WHERE lower(c.name) = lower(d.name));

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

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS oauth_provider TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS oauth_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth_identity
  ON users (oauth_provider, oauth_subject)
  WHERE oauth_provider IS NOT NULL AND oauth_subject IS NOT NULL;

-- Sistema de estudios del alumno: esc = escolarizado, sua = universidad abierta / a distancia.
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS study_system TEXT;

DO $$ BEGIN
  ALTER TABLE memberships
    ADD CONSTRAINT chk_memberships_study_system CHECK (study_system IS NULL OR study_system IN ('esc', 'sua'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_memberships_study_system_sua
  ON memberships (org_id, user_id)
  WHERE study_system = 'sua';

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
  -- NULL = horas pendientes de valoración (solo borrador/cancelado)
  hours_value           NUMERIC(6,2) DEFAULT 0,
  capacity              INTEGER,
  capacity_enabled      BOOLEAN NOT NULL DEFAULT false,

  -- Basic sanity checks
  CONSTRAINT chk_events_time_range CHECK (ends_at > starts_at),
  CONSTRAINT chk_events_hours_nonnegative CHECK (hours_value >= 0),
  CONSTRAINT chk_events_hours_max CHECK (hours_value IS NULL OR hours_value <= 200),
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

-- Solo filas que cambian: tocar todas re-evalúa los checks NOT VALID sobre datos históricos.
UPDATE events
SET capacity_enabled = (capacity IS NOT NULL AND capacity > 0)
WHERE capacity_enabled IS DISTINCT FROM (capacity IS NOT NULL AND capacity > 0);

UPDATE events
SET attributes = attributes - 'cupo'
WHERE attributes ? 'cupo';

-- ----------
-- AFC hours valuation (tipo de evento / actividad realizada)
-- ----------

-- NOT VALID: se aplica a filas nuevas/modificadas sin alterar horas históricas existentes.
ALTER TABLE events ALTER COLUMN hours_value DROP NOT NULL;
ALTER TABLE events DROP CONSTRAINT IF EXISTS chk_events_hours_max;
ALTER TABLE events
  ADD CONSTRAINT chk_events_hours_max CHECK (hours_value IS NULL OR hours_value <= 200) NOT VALID;
ALTER TABLE events DROP CONSTRAINT IF EXISTS chk_events_hours_required_when_active;
ALTER TABLE events
  ADD CONSTRAINT chk_events_hours_required_when_active
  CHECK (hours_value IS NOT NULL OR status IN ('draft', 'cancelled')) NOT VALID;

-- Los borradores pueden guardarse sin fechas; al publicarse son obligatorias.
ALTER TABLE events ALTER COLUMN starts_at DROP NOT NULL;
ALTER TABLE events ALTER COLUMN ends_at DROP NOT NULL;
ALTER TABLE events DROP CONSTRAINT IF EXISTS chk_events_schedule_required_when_active;
ALTER TABLE events
  ADD CONSTRAINT chk_events_schedule_required_when_active
  CHECK ((starts_at IS NOT NULL AND ends_at IS NOT NULL) OR status IN ('draft', 'cancelled')) NOT VALID;

-- Eventos de varias sesiones: % mínimo de sesiones asistidas para acreditar las horas AFC (100 = todas).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS min_attendance_percent SMALLINT NOT NULL DEFAULT 100;
DO $$ BEGIN
  ALTER TABLE events
    ADD CONSTRAINT chk_events_min_attendance_percent CHECK (min_attendance_percent BETWEEN 1 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Snapshot of the applied rule (type, scenario, range, percent, inputs, result).
-- NULL = legacy event whose hours were entered before the AFC catalog.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS afc_valuation JSONB;

-- Actividades AFC (tablas de los Criterios Internos, art. 6 y 7).
-- valuation_mode: scenarios = supuestos del tabulador; manual = horas libres dentro del rango
-- con evidencia opcional; committee = horas libres con dictamen obligatorio.
CREATE TABLE IF NOT EXISTS afc_activity_types (
  id              BIGSERIAL PRIMARY KEY,
  origin          TEXT NOT NULL CHECK (origin IN ('fes_aragon', 'external')),
  key             TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  name            TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description     TEXT,
  requirements    TEXT,
  min_hours       NUMERIC(6,2),
  max_hours       NUMERIC(6,2),
  valuation_mode  TEXT NOT NULL CHECK (valuation_mode IN ('scenarios', 'manual', 'committee')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_afc_types_range CHECK (
    (valuation_mode = 'committee' AND min_hours IS NULL AND max_hours IS NULL)
    OR (
      valuation_mode <> 'committee'
      AND max_hours IS NOT NULL AND max_hours > 0 AND max_hours <= 200
      AND (min_hours IS NULL OR (min_hours >= 0 AND min_hours <= max_hours))
    )
  ),
  UNIQUE (origin, key)
);

-- Supuestos del Tabulador indicativo por actividad.
CREATE TABLE IF NOT EXISTS afc_valuation_scenarios (
  id                BIGSERIAL PRIMARY KEY,
  activity_type_id  BIGINT NOT NULL REFERENCES afc_activity_types(id) ON DELETE CASCADE,
  key               TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  label             TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
  kind              TEXT NOT NULL CHECK (kind IN ('percent', 'fixed_hours', 'course_duration')),
  percent           NUMERIC(7,4),
  fixed_hours       NUMERIC(6,2),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_afc_scenarios_kind CHECK (
    (kind = 'percent' AND percent IS NOT NULL AND percent BETWEEN 0 AND 100 AND fixed_hours IS NULL)
    OR (kind = 'fixed_hours' AND fixed_hours IS NOT NULL AND fixed_hours > 0 AND percent IS NULL)
    OR (kind = 'course_duration' AND percent IS NULL AND fixed_hours IS NULL)
  ),
  UNIQUE (activity_type_id, key)
);

CREATE INDEX IF NOT EXISTS idx_afc_types_origin_order
  ON afc_activity_types (origin, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_afc_scenarios_type_order
  ON afc_valuation_scenarios (activity_type_id, sort_order, id);

-- Seed inicial; ON CONFLICT DO NOTHING conserva los cambios hechos desde el panel de administración.
INSERT INTO afc_activity_types
  (origin, key, name, description, requirements, min_hours, max_hours, valuation_mode, sort_order)
VALUES
  ('fes_aragon', 'conferences', 'Conferencias',
   'Asistencia o ponencia en charlas, conferencias o pláticas.',
   'Constancia o registro de asistencia emitido por la organización.', 10, 50, 'scenarios', 10),
  ('fes_aragon', 'stands', 'Stands informativos o de proyectos',
   'Participación en el montaje, atención y desmontaje de estands durante ferias, exposiciones o actividades académicas.',
   'Participar activamente en al menos un turno completo.', 5, 20, 'scenarios', 20),
  ('fes_aragon', 'congresses', 'Congresos',
   'Participación en congresos con varias actividades académicas en su programa.',
   'Participar en al menos 5 actividades del congreso.', 100, 200, 'scenarios', 30),
  ('fes_aragon', 'courses', 'Talleres y cursos',
   'Actividades prácticas o teóricas orientadas al aprendizaje de habilidades o conocimientos específicos.',
   'Constancia con número de horas o, en su defecto, registro diario.', NULL, 150, 'scenarios', 40),
  ('fes_aragon', 'seminars', 'Seminarios internos',
   'Ciclos de sesiones periódicas sobre un tema especializado, organizados por carreras, coordinaciones o centros.',
   'Constancia de participación en al menos 80 % de las sesiones.', 30, 80, 'scenarios', 50),
  ('fes_aragon', 'academic_events', 'Eventos académicos',
   'Actividades como coloquios, simposios, torneos o festivales.',
   'Constancia oficial de participación.', 20, 100, 'scenarios', 60),
  ('fes_aragon', 'institutional_participation', 'Participación en cuestiones institucionales',
   'Apoyo como brigadista, staff en eventos, logística o cuidado de estands.',
   'Carta o constancia de la instancia responsable.', 20, 80, 'scenarios', 70),
  ('fes_aragon', 'institutional_support_projects', 'Proyectos institucionales de apoyo',
   'Programas, ferias o actividades.',
   'Registro o constancia de la dependencia organizadora.', 20, 100, 'manual', 80),
  ('fes_aragon', 'cultural', 'Actividades culturales',
   'Actividades culturales (presentaciones, festivales, muestras, círculos de lectura, etc.).',
   'Constancia o registro oficial.', 20, 100, 'manual', 90),
  ('fes_aragon', 'sports', 'Actividades deportivas',
   'Actividades deportivas (torneos, clínicas, exhibiciones).',
   'Constancia o registro oficial.', 20, 100, 'manual', 100),
  ('fes_aragon', 'research', 'Actividades de investigación',
   'Participación en proyectos, laboratorios, seminarios o apoyo a docentes o investigación.',
   'Carta o constancia del responsable del proyecto con periodo y tareas.', 40, 200, 'scenarios', 110),
  ('fes_aragon', 'entrepreneurship', 'Actividades de emprendimiento',
   'Retos, hackathons, incubación o ferias de emprendimiento.',
   'Constancia de participación y, si aplica, evidencia del proyecto.', 40, 150, 'scenarios', 120),
  ('fes_aragon', 'social_responsibility', 'Actividades de responsabilidad social',
   'Brigadas y campañas (salud, inclusión, sostenibilidad, etc.).',
   'Constancia de la instancia responsable.', 20, 100, 'scenarios', 130),
  ('fes_aragon', 'outreach', 'Actividades de vinculación',
   'Actividades coordinadas con sectores público, privado o social.',
   'Constancia de coordinación o participación.', 20, 120, 'scenarios', 140),
  ('fes_aragon', 'human_development', 'Actividades de formación humana',
   'Actividades sobre habilidades socioemocionales, ética, valores, liderazgo o comunicación.',
   'Constancia de participación.', 20, 80, 'scenarios', 150),
  ('fes_aragon', 'committee', 'Actividades validadas por el Comité de Carrera',
   'Actividades no previstas en el tabulador o méritos excepcionales de carácter académico, cultural, deportivo, institucional o formativo.',
   'Dictamen y justificación aprobada por el Comité de Carrera.', NULL, NULL, 'committee', 160),

  ('external', 'ext_contest_participation', 'Concursos: participación',
   'Participación en concursos culturales, deportivos, académicos o de innovación.',
   'Constancia oficial de participación.', 20, 30, 'manual', 10),
  ('external', 'ext_contest_podium', 'Concursos: 1.º, 2.º o 3.º lugar',
   'Obtención de primeros lugares en concursos externos (nacionales o internacionales).',
   'Constancia oficial con lugar obtenido.', 80, 150, 'manual', 20),
  ('external', 'ext_contest_other', 'Concursos: otros lugares destacados',
   'Obtención de menciones honoríficas, semifinales u otros reconocimientos.',
   'Constancia oficial con lugar obtenido.', 30, 80, 'manual', 30),
  ('external', 'ext_course_defined', 'Cursos/talleres externos con horas definidas',
   'Cursos organizados por dependencias de la UNAM o por instituciones externas.',
   'Constancia con número de horas y sello oficial.', NULL, 150, 'scenarios', 40),
  ('external', 'ext_course_undefined', 'Cursos/talleres externos sin horas definidas',
   'Actividades de capacitación sin carga horaria explícita.',
   'Constancia oficial de asistencia.', 20, 50, 'scenarios', 50),
  ('external', 'ext_event_attendance', 'Asistencia a eventos externos',
   'Participación como asistente en actividades culturales, artísticas, académicas o deportivas.',
   'Boleto, ticket o constancia con nombre del estudiante junto con reporte escrito con fotografía.', 20, 30, 'manual', 60),
  ('external', 'ext_museum', 'Visitas a museos o exposiciones',
   'Visitas con valor cultural, académico o de divulgación científica.',
   'Boleto, ticket o constancia con nombre del estudiante junto con reporte escrito con fotografía.', 20, 30, 'manual', 70),
  ('external', 'ext_congress', 'Congresos externos',
   'Participación en congresos nacionales o internacionales.',
   'Constancia oficial con nombre y programa.', 100, 200, 'manual', 80),
  ('external', 'ext_research', 'Proyectos externos de investigación',
   'Participación en proyectos de investigación en otras dependencias de la UNAM o instituciones externas.',
   'Carta o constancia del responsable del proyecto.', 40, 200, 'manual', 90),
  ('external', 'ext_entrepreneurship', 'Eventos de emprendimiento externos',
   'Retos, ferias o programas de incubación.',
   'Constancia oficial y evidencia de participación.', 40, 150, 'manual', 100),
  ('external', 'ext_internship', 'Prácticas profesionales o estancias cortas',
   'Participación en estancias cortas, prácticas o voluntariado académico.',
   'Carta o constancia de la institución receptora.', 40, 200, 'manual', 110),
  ('external', 'ext_social_responsibility', 'Actividades de responsabilidad social externas',
   'Participación en brigadas, voluntariado o campañas en instituciones externas (ONGs, gobiernos, asociaciones de asistencia social o civil).',
   'Constancia de la instancia organizadora.', 20, 120, 'manual', 120),
  ('external', 'ext_outreach', 'Actividades de vinculación externas',
   'Participación en convenios, proyectos o colaboraciones con empresas u organismos externos.',
   'Constancia de participación o carta institucional.', 20, 150, 'manual', 130),
  ('external', 'ext_human_development', 'Actividades de formación humana externas',
   'Participación en actividades de desarrollo personal, ética, valores, liderazgo o comunicación.',
   'Constancia oficial de participación.', 20, 80, 'manual', 140),
  ('external', 'ext_committee', 'Actividades validadas por el Comité de Carrera',
   'Actividades no previstas en el tabulador o méritos excepcionales de carácter académico, cultural, deportivo, institucional o formativo.',
   'Dictamen y justificación aprobada por el Comité de Carrera.', NULL, NULL, 'committee', 150)
ON CONFLICT (origin, key) DO NOTHING;

INSERT INTO afc_valuation_scenarios
  (activity_type_id, key, label, kind, percent, fixed_hours, sort_order)
SELECT t.id, s.key, s.label, s.kind, s.percent, s.fixed_hours, s.sort_order
FROM (VALUES
  ('fes_aragon', 'conferences', 'conf_internal_attendance', 'Asistencia a conferencia interna', 'percent', 20::numeric, NULL::numeric, 10),
  ('fes_aragon', 'conferences', 'conf_career_division', 'Asistencia a conferencia organizada por la carrera o división', 'percent', 30, NULL, 20),
  ('fes_aragon', 'conferences', 'conf_fes_authorities', 'Asistencia a conferencia impartida por autoridades de la FES Aragón', 'percent', 40, NULL, 30),
  ('fes_aragon', 'conferences', 'conf_unam_authorities', 'Asistencia a conferencia impartida por autoridades universitarias de la UNAM', 'percent', 50, NULL, 40),
  ('fes_aragon', 'conferences', 'conf_external_specialist', 'Asistencia a conferencia con especialista externo', 'percent', 60, NULL, 50),
  ('fes_aragon', 'conferences', 'conf_recognized_specialist', 'Conferencia impartida por especialista reconocido o invitado internacional', 'percent', 80, NULL, 60),
  ('fes_aragon', 'conferences', 'conf_moderator', 'Participación como moderador o apoyo académico', 'percent', 80, NULL, 70),
  ('fes_aragon', 'conferences', 'conf_organizer_speaker', 'Participación como organizador o ponente', 'percent', 100, NULL, 80),

  ('fes_aragon', 'stands', 'stand_basic', 'Participación básica en atención del stand', 'percent', 25, NULL, 10),
  ('fes_aragon', 'stands', 'stand_full_shift', 'Participación durante un turno completo', 'percent', 50, NULL, 20),
  ('fes_aragon', 'stands', 'stand_multi_shift_demo', 'Participación en más de un turno o con demostración técnica', 'percent', 75, NULL, 30),
  ('fes_aragon', 'stands', 'stand_lead', 'Responsable del stand o coordinación de actividades', 'percent', 100, NULL, 40),

  ('fes_aragon', 'congresses', 'congress_min_activities', 'Asistencia al mínimo de actividades requeridas', 'percent', 50, NULL, 10),
  ('fes_aragon', 'congresses', 'congress_full_program', 'Participación completa en el programa del congreso', 'percent', 60, NULL, 20),
  ('fes_aragon', 'congresses', 'congress_workshops', 'Participación en talleres o actividades académicas adicionales', 'percent', 75, NULL, 30),
  ('fes_aragon', 'congresses', 'congress_poster_talk', 'Presentación de cartel o ponencia', 'percent', 90, NULL, 40),
  ('fes_aragon', 'congresses', 'congress_outstanding', 'Participación destacada u organización académica', 'percent', 100, NULL, 50),

  ('fes_aragon', 'courses', 'course_defined_duration', 'Curso o taller con duración definida (horas × 2)', 'course_duration', NULL, NULL, 10),
  ('fes_aragon', 'courses', 'course_ref_basic', 'Sin horas definidas: asistencia básica', 'fixed_hours', NULL, 20, 20),
  ('fes_aragon', 'courses', 'course_ref_full_evidence', 'Sin horas definidas: participación completa con evidencia', 'fixed_hours', NULL, 30, 30),
  ('fes_aragon', 'courses', 'course_ref_specialized', 'Sin horas definidas: curso especializado con producto final', 'fixed_hours', NULL, 40, 40),
  ('fes_aragon', 'courses', 'course_ref_intensive', 'Sin horas definidas: curso intensivo validado académicamente', 'fixed_hours', NULL, 50, 50),

  ('fes_aragon', 'seminars', 'seminar_min_attendance', 'Participación con asistencia mínima requerida', 'percent', 37.5, NULL, 10),
  ('fes_aragon', 'seminars', 'seminar_constant', 'Participación constante en sesiones', 'percent', 50, NULL, 20),
  ('fes_aragon', 'seminars', 'seminar_active', 'Participación activa en discusiones o relatorías', 'percent', 62.5, NULL, 30),
  ('fes_aragon', 'seminars', 'seminar_presentation', 'Presentación de tema o trabajo académico', 'percent', 75, NULL, 40),
  ('fes_aragon', 'seminars', 'seminar_coordination', 'Coordinación o apoyo académico relevante', 'percent', 100, NULL, 50),

  ('fes_aragon', 'academic_events', 'academic_general', 'Asistencia general', 'percent', 20, NULL, 10),
  ('fes_aragon', 'academic_events', 'academic_specific', 'Participación en actividad específica', 'percent', 40, NULL, 20),
  ('fes_aragon', 'academic_events', 'academic_active_support', 'Participación activa o apoyo en actividades', 'percent', 60, NULL, 30),
  ('fes_aragon', 'academic_events', 'academic_presentation', 'Presentación o demostración académica', 'percent', 80, NULL, 40),
  ('fes_aragon', 'academic_events', 'academic_coordination', 'Coordinación o liderazgo en el evento', 'percent', 100, NULL, 50),

  ('fes_aragon', 'institutional_participation', 'institutional_basic_staff', 'Apoyo básico como brigadista o staff', 'percent', 25, NULL, 10),
  ('fes_aragon', 'institutional_participation', 'institutional_logistics', 'Participación en logística institucional', 'percent', 50, NULL, 20),
  ('fes_aragon', 'institutional_participation', 'institutional_organization', 'Apoyo relevante en organización', 'percent', 75, NULL, 30),
  ('fes_aragon', 'institutional_participation', 'institutional_team_coordination', 'Coordinación de equipo o actividad', 'percent', 100, NULL, 40),

  ('fes_aragon', 'research', 'research_basic', 'Apoyo básico en proyecto de investigación', 'percent', 20, NULL, 10),
  ('fes_aragon', 'research', 'research_continuous', 'Participación continua en actividades del proyecto', 'percent', 40, NULL, 20),
  ('fes_aragon', 'research', 'research_technical', 'Participación técnica o metodológica', 'percent', 60, NULL, 30),
  ('fes_aragon', 'research', 'research_products', 'Participación con resultados o productos académicos', 'percent', 80, NULL, 40),
  ('fes_aragon', 'research', 'research_outstanding', 'Participación destacada con contribución académica', 'percent', 100, NULL, 50),

  ('fes_aragon', 'entrepreneurship', 'entrepreneurship_basic', 'Participación básica en reto o hackathon', 'percent', 27, NULL, 10),
  ('fes_aragon', 'entrepreneurship', 'entrepreneurship_full', 'Participación completa en actividad', 'percent', 40, NULL, 20),
  ('fes_aragon', 'entrepreneurship', 'entrepreneurship_prototype', 'Desarrollo de prototipo o propuesta', 'percent', 60, NULL, 30),
  ('fes_aragon', 'entrepreneurship', 'entrepreneurship_presentation', 'Presentación formal del proyecto', 'percent', 80, NULL, 40),
  ('fes_aragon', 'entrepreneurship', 'entrepreneurship_outstanding', 'Proyecto destacado o incubación', 'percent', 100, NULL, 50),

  ('fes_aragon', 'social_responsibility', 'social_basic', 'Participación básica en brigada o campaña', 'percent', 20, NULL, 10),
  ('fes_aragon', 'social_responsibility', 'social_continuous', 'Participación continua', 'percent', 40, NULL, 20),
  ('fes_aragon', 'social_responsibility', 'social_defined_tasks', 'Participación con tareas definidas', 'percent', 60, NULL, 30),
  ('fes_aragon', 'social_responsibility', 'social_coordination', 'Apoyo en coordinación', 'percent', 80, NULL, 40),
  ('fes_aragon', 'social_responsibility', 'social_operational', 'Responsabilidad operativa relevante', 'percent', 100, NULL, 50),

  ('fes_aragon', 'outreach', 'outreach_basic', 'Participación básica', 'fixed_hours', NULL, 20, 10),
  ('fes_aragon', 'outreach', 'outreach_collaboration_project', 'Participación en proyecto de colaboración', 'fixed_hours', NULL, 40, 20),
  ('fes_aragon', 'outreach', 'outreach_active_evidence', 'Participación activa con evidencia', 'fixed_hours', NULL, 60, 30),
  ('fes_aragon', 'outreach', 'outreach_representation', 'Representación institucional', 'fixed_hours', NULL, 90, 40),
  ('fes_aragon', 'outreach', 'outreach_leadership', 'Liderazgo o gestión relevante', 'fixed_hours', NULL, 120, 50),

  ('fes_aragon', 'human_development', 'human_attendance', 'Asistencia a actividad formativa', 'fixed_hours', NULL, 20, 10),
  ('fes_aragon', 'human_development', 'human_continuous', 'Participación continua', 'fixed_hours', NULL, 40, 20),
  ('fes_aragon', 'human_development', 'human_active_evidence', 'Participación activa con evidencia', 'fixed_hours', NULL, 60, 30),
  ('fes_aragon', 'human_development', 'human_organization', 'Organización o facilitación', 'fixed_hours', NULL, 80, 40),

  ('external', 'ext_course_defined', 'course_defined_duration', 'Curso o taller con duración definida (horas × 2)', 'course_duration', NULL, NULL, 10),
  ('external', 'ext_course_undefined', 'course_ref_basic', 'Asistencia básica', 'fixed_hours', NULL, 20, 10),
  ('external', 'ext_course_undefined', 'course_ref_full_evidence', 'Participación completa con evidencia', 'fixed_hours', NULL, 30, 20),
  ('external', 'ext_course_undefined', 'course_ref_specialized', 'Curso especializado con producto final', 'fixed_hours', NULL, 40, 30),
  ('external', 'ext_course_undefined', 'course_ref_intensive', 'Curso intensivo validado académicamente', 'fixed_hours', NULL, 50, 40)
) AS s(origin, type_key, key, label, kind, percent, fixed_hours, sort_order)
JOIN afc_activity_types t ON t.origin = s.origin AND t.key = s.type_key
ON CONFLICT (activity_type_id, key) DO NOTHING;

-- Actividades que pueden organizarse en varias sesiones (eventos con % mínimo de asistencia).
-- La marca inicial solo se aplica al crear la columna para no pisar cambios hechos desde el catálogo.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'afc_activity_types' AND column_name = 'multi_session'
  ) THEN
    ALTER TABLE afc_activity_types ADD COLUMN multi_session BOOLEAN NOT NULL DEFAULT false;
    UPDATE afc_activity_types
    SET multi_session = true
    WHERE (origin, key) IN (
      ('fes_aragon', 'courses'), ('fes_aragon', 'seminars'), ('fes_aragon', 'congresses'),
      ('fes_aragon', 'academic_events'), ('fes_aragon', 'committee'),
      ('external', 'ext_course_defined'), ('external', 'ext_course_undefined'),
      ('external', 'ext_congress'), ('external', 'ext_committee')
    );
  END IF;
END $$;

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
-- Archivos subidos (evidencias AFC y, a futuro, evidencias de participación o requisitos de inscripción)
-- ----------
-- El contenido vive en el almacenamiento configurado (volumen Docker); aquí solo la ubicación y metadatos.
-- status: staged = subido pero aún no ligado a su entidad; se depura tras 24 h.

CREATE TABLE IF NOT EXISTS files (
  id                BIGSERIAL PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  storage_provider  TEXT NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local')),
  storage_key       TEXT NOT NULL UNIQUE,
  original_name     TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  purpose           TEXT NOT NULL CHECK (purpose IN (
                      'afc_hours_evidence',
                      'participation_evidence',
                      'registration_requirement',
                      'event_cover',
                      'other'
                    )),
  status            TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'attached', 'deleted')),
  uploaded_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_id          BIGINT REFERENCES events(id) ON DELETE SET NULL,
  registration_id   BIGINT REFERENCES registrations(id) ON DELETE SET NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  attached_at       TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_files_event ON files (event_id, created_at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_registration ON files (registration_id) WHERE registration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_staged ON files (uploaded_by, created_at) WHERE status = 'staged';
CREATE INDEX IF NOT EXISTS idx_files_purpose ON files (purpose, created_at DESC);

-- Evidencia de horas AFC vigente del evento (obligatoria en Comité de Carrera).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS afc_evidence_file_id BIGINT;

DO $$ BEGIN
  ALTER TABLE events
    ADD CONSTRAINT fk_events_afc_evidence_file
    FOREIGN KEY (afc_evidence_file_id) REFERENCES files(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


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
  CONSTRAINT chk_event_sessions_time_range CHECK (ends_at > starts_at),
  CONSTRAINT chk_event_sessions_hours_range CHECK (hours_value IS NULL OR hours_value BETWEEN 0 AND 100)
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
  category              TEXT REFERENCES event_categories(key) ON DELETE SET NULL,
  request_id            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent double-crediting the same check-in
  UNIQUE (source_checkin_id)
);

CREATE INDEX IF NOT EXISTS idx_hours_ledger_user ON hours_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hours_ledger_event ON hours_ledger (event_id);

ALTER TABLE hours_ledger
  ADD COLUMN IF NOT EXISTS request_id UUID,
  ADD COLUMN IF NOT EXISTS category TEXT REFERENCES event_categories(key) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hours_ledger_request_id
  ON hours_ledger (request_id)
  WHERE request_id IS NOT NULL;

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
