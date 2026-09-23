-- EMCC Insight — WhatsApp incident-advice messaging
-- Stores messages imported from WhatsApp group exports (EM North / EM South
-- "Incident Advice"), the message chains ("threads") they form, and the
-- links between those chains and CCIL incidents. The WhatsApp tab scores
-- each linked chain against the EM Control Messaging Standard (holding
-- message timing, update cadence, mandated content, closure) and rolls the
-- results up into KPIs and trends.
--
-- Additive: no existing table is altered. Apply in the SQL Editor or with
-- `supabase db push`.

-- One row per file dropped into the WhatsApp tab. Re-importing a cumulative
-- export is idempotent at the message level (see wa_messages unique key), so
-- new_count records how many rows were genuinely new.
CREATE TABLE IF NOT EXISTS wa_imports (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_name     text        NOT NULL,           -- 'north' | 'south' | other group key
  group_label    text,                           -- WhatsApp group title as exported
  file_name      text,
  file_sha256    text,
  first_msg_at   timestamptz,
  last_msg_at    timestamptz,
  message_count  integer     NOT NULL DEFAULT 0, -- messages parsed from the file
  new_count      integer     NOT NULL DEFAULT 0, -- messages not previously stored
  imported_by    text,                           -- free-text initials (no auth yet)
  imported_at    timestamptz NOT NULL DEFAULT now()
);

-- Every operational message. System lines (joins, leaves, privacy notices)
-- are dropped at parse time; media-only placeholders are kept with has_media
-- so a chain's picture count is visible even though the export strips images.
-- sender is the display name as exported; raw phone numbers are replaced by
-- 'Unsaved contact' at parse time and never stored.
CREATE TABLE IF NOT EXISTS wa_messages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id    uuid        REFERENCES wa_imports(id) ON DELETE SET NULL,
  group_name   text        NOT NULL,
  sent_at      timestamptz NOT NULL,             -- Europe/London wall clock converted to UTC
  sent_local   text        NOT NULL,             -- 'YYYY-MM-DDTHH:MM:SS' as it appeared in the export
  sender       text        NOT NULL,
  body         text        NOT NULL,
  body_hash    text        NOT NULL,             -- fnv1a-32 hex of body; part of the identity key
  headline     text,                             -- leading *bold* title, if any
  rag          text        CHECK (rag IN ('red','amber','yellow','green')),
  kind         text        NOT NULL,             -- open|update|holding|recovery|close|conference|advisory|offroute|other
  headcodes    text[]      NOT NULL DEFAULT '{}',
  thread_key   text        NOT NULL,             -- chain id: group|first-message-local-time|normalised-headline
  has_media    boolean     NOT NULL DEFAULT false,
  is_deleted   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_name, sent_local, sender, body_hash)
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_group_sent  ON wa_messages (group_name, sent_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_thread      ON wa_messages (thread_key);

-- Chain ↔ incident links. A chain can reference several incidents (route-wide
-- recovery posts) and an incident can have several chains (the title changes
-- as the picture develops), so the relation is many-to-many. status records
-- whether the automatic match was confirmed or rejected by a person; a
-- rejected auto link is kept so the matcher does not re-propose it.
CREATE TABLE IF NOT EXISTS wa_thread_links (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_name   text        NOT NULL,
  thread_key   text        NOT NULL,
  incident_id  uuid        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  ccil         text,
  score        numeric,
  method       text        NOT NULL CHECK (method IN ('auto','manual')),
  status       text        NOT NULL CHECK (status IN ('auto','confirmed','rejected')) DEFAULT 'auto',
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_name, thread_key, incident_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_thread_links_incident ON wa_thread_links (incident_id);
CREATE INDEX IF NOT EXISTS idx_wa_thread_links_thread   ON wa_thread_links (group_name, thread_key);

COMMENT ON TABLE wa_imports IS
  'One row per WhatsApp export file dropped into the Insight WhatsApp tab.';
COMMENT ON TABLE wa_messages IS
  'Operational messages from the EM Incident Advice WhatsApp groups, keyed uniquely so cumulative re-exports are idempotent. Phone numbers are never stored.';
COMMENT ON TABLE wa_thread_links IS
  'Links between WhatsApp message chains (thread_key) and CCIL incidents, automatic or manual, with confirm/reject state.';
