-- shifts.status turns out to be a native Postgres ENUM type (shift_status),
-- not text+check like 20260629_shifts_and_applications.sql assumed (that
-- file's own check constraint has clearly been superseded out-of-band at
-- some point -- no migration in this repo shows the conversion, but the
-- live error confirms it: "invalid input value for enum shift_status:
-- 'closed'" when 20260811_shift_close_applications.sql tried to add it via
-- ALTER TABLE ... ADD CONSTRAINT ... CHECK). Same exact situation already
-- hit once before for applications.status -- see
-- 20260705d_widen_application_status_enum.sql for the precedent this
-- mirrors.
--
-- Enum types need ALTER TYPE ... ADD VALUE, and Postgres does not allow a
-- newly-added enum value to be used in the SAME transaction it was added
-- in -- so this must run as ITS OWN script, separately from and BEFORE
-- 20260811_shift_close_applications.sql (which no longer touches the
-- status constraint at all -- see that file's updated version).

alter type shift_status add value if not exists 'closed';
