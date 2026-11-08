CREATE TABLE processing.deliveries (
  job_id bigint PRIMARY KEY REFERENCES queue.jobs(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL,
  detected_at timestamptz,
  published_at timestamptz,
  published_precision text
);
