-- Preserve existing operations; extend the state machine for durable cancellations.
ALTER TABLE "NoskiBookingOperation" DROP CONSTRAINT "NoskiBookingOperation_status";
ALTER TABLE "NoskiBookingOperation" ADD CONSTRAINT "NoskiBookingOperation_status"
  CHECK ("status" IN ('creating','confirmed','review','canceling','canceled'));
