CREATE TABLE "NoskiBookingOperation" (
  "id" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'creating',
  "bookingUid" TEXT,
  "receipt" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NoskiBookingOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NoskiBookingOperation_status" CHECK ("status" IN ('creating','confirmed','review'))
);
CREATE UNIQUE INDEX "NoskiBookingOperation_bookingUid_key" ON "NoskiBookingOperation"("bookingUid");
