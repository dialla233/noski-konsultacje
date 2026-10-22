\set ON_ERROR_STOP on
BEGIN;
\ir ../packages/prisma/migrations/20261020193000_noski_booking_operations/migration.sql
INSERT INTO "NoskiBookingOperation" (id,"payloadHash",status,"updatedAt") VALUES ('kept','hash','confirmed',now());
\ir ../packages/prisma/migrations/20261020211000_noski_booking_cancellation_states/migration.sql
DO $$
DECLARE state text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM "NoskiBookingOperation" WHERE id='kept' AND status='confirmed') THEN
    RAISE EXCEPTION 'Existing operation changed';
  END IF;
  FOREACH state IN ARRAY ARRAY['creating','confirmed','review','canceling','canceled'] LOOP
    UPDATE "NoskiBookingOperation" SET status=state WHERE id='kept';
  END LOOP;
  BEGIN
    UPDATE "NoskiBookingOperation" SET status='invalid' WHERE id='kept';
    RAISE EXCEPTION 'Invalid status accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
