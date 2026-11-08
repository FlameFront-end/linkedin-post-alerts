CREATE TABLE processing.source_state (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE processing.posts ADD COLUMN language text;
ALTER TABLE processing.posts ADD COLUMN language_evidence text;
ALTER TABLE processing.posts ADD COLUMN assessment jsonb;
CREATE TABLE processing.observations (
  id text PRIMARY KEY,
  fingerprint text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
