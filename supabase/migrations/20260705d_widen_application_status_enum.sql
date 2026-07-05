-- applications.status turns out to be a native Postgres ENUM type
-- (application_status), not text+check like the original migration files
-- assumed. Enum types need ALTER TYPE ... ADD VALUE, and Postgres does not
-- allow a newly-added enum value to be used in the SAME transaction it was
-- added in — so this must be run as ITS OWN script, separately from
-- 20260705_hiring_workflow.sql (run this one FIRST, then that one).

alter type application_status add value if not exists 'offered';
alter type application_status add value if not exists 'expired';
