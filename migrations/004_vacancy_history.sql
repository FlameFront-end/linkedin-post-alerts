CREATE TABLE processing.vacancies (
  id uuid PRIMARY KEY,
  revision text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE processing.vacancy_aliases (
  alias text PRIMARY KEY,
  fingerprint text,
  vacancy_id uuid NOT NULL REFERENCES processing.vacancies(id) ON DELETE CASCADE
);
CREATE INDEX vacancy_aliases_id ON processing.vacancy_aliases(vacancy_id);
CREATE TABLE processing.vacancy_revisions (
  vacancy_id uuid NOT NULL REFERENCES processing.vacancies(id) ON DELETE CASCADE,
  revision text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vacancy_id, revision)
);
