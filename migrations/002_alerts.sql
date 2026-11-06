-- Operational alerts for the owner are delivered by notifier like notifications.
ALTER TABLE queue.jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE queue.jobs
  ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('post', 'notification', 'alert'));
