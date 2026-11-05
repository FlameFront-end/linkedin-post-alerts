CREATE SCHEMA IF NOT EXISTS queue;
CREATE SCHEMA IF NOT EXISTS processing;

CREATE TABLE queue.jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('post','notification')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  lock_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error text,
  UNIQUE (kind, dedupe_key)
);
CREATE INDEX jobs_ready ON queue.jobs (kind, available_at, id) WHERE status IN ('pending','running');
CREATE TABLE processing.posts (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  roles text[] NOT NULL,
  russian boolean NOT NULL,
  decision text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
