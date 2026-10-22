import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getRegularBookingService } from "@calcom/features/bookings/di/RegularBookingService.container";
import prisma from "@calcom/prisma";
import { CreationSource } from "@calcom/prisma/enums";
import { cancelRegisteredBooking } from "./cancel-registered-booking";

export const runtime = "nodejs";
const requestSchema = z.object({
  rescheduleUid: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/).optional(),
  action: z.enum(["create", "lookup", "cancel", "cancel_lookup"]),
  bookingId: z.string().uuid(),
  tenantId: z.number().int().positive(),
  stripeSession: z.string().regex(/^cs_[a-zA-Z0-9_]+$/),
  live: z.boolean(),
  attendee: z.object({ email: z.string().email().max(254), name: z.string().trim().min(1).max(200) }),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
}).strict().refine(v => Date.parse(v.endsAt) - Date.parse(v.startsAt) === 3600000);

export async function POST(req: Request) {
  const secret = process.env.NOSKI_BOOKING_BRIDGE_SECRET;
  const mode = process.env.NOSKI_BOOKING_BRIDGE_MODE;
  const eventTypeId = Number(process.env.NOSKI_BOOKING_EVENT_TYPE_ID);
  const ownerId = Number(process.env.NOSKI_BOOKING_OWNER_ID);
  if (!secret || secret.length < 64 || !["test", "live"].includes(mode || "") ||
    !Number.isSafeInteger(eventTypeId) || eventTypeId <= 0 || !Number.isSafeInteger(ownerId) || ownerId <= 0)
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 8192) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const timestamp = req.headers.get("x-noski-timestamp") || "";
  const signature = req.headers.get("x-noski-signature") || "";
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300000 ||
    !/^[a-f0-9]{64}$/.test(signature))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${raw}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let parsed;
  try { parsed = requestSchema.safeParse(JSON.parse(raw)); }
  catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const { action, ...input } = parsed.data;
  if (input.live !== (mode === "live") || !input.stripeSession.startsWith(input.live ? "cs_live_" : "cs_test_")) return NextResponse.json({ error: "wrong_environment" }, { status: 409 });
  const id = `${mode}:${input.bookingId}`;
  const payloadHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const event = await prisma.eventType.findFirst({
    where: { id: eventTypeId, userId: ownerId },
    select: { slug: true, length: true, owner: { select: { username: true } } },
  });
  if (!event?.owner?.username || event.length !== 60)
    return NextResponse.json({ error: "event_configuration" }, { status: 503 });

  // This committed insert is the right to create once. A lost response only permits lookup.
  let created = false;
  if (action === "create") {
    const inserted = await prisma.noskiBookingOperation.createMany({
      data: [{ id, payloadHash, status: "creating" }], skipDuplicates: true,
    });
    created = inserted.count === 1;
  }
  const operation = await prisma.noskiBookingOperation.findUnique({
    where: { id }, select: { payloadHash: true, status: true },
  });
  if (!operation) return NextResponse.json({ status: "not_found" }, { status: 404 });
  if (operation.payloadHash !== payloadHash)
    return NextResponse.json({ error: "idempotency_conflict" }, { status: 409 });

  if (action === "cancel" || action === "cancel_lookup") {
    if (process.env.NOSKI_BOOKING_CANCELLATION_ENABLED !== "true")
      return NextResponse.json({ error: "cancellation_disabled" }, { status: 503 });
    const result = await cancelRegisteredBooking({
      operationId: id, payloadHash, ownerId, eventTypeId,
      startsAt: input.startsAt, endsAt: input.endsAt,
      attendeeEmail: input.attendee.email, allowCancel: action === "cancel",
    });
    return NextResponse.json({ ...result, bookingId: input.bookingId },
      { status: result.status === "canceled" ? 200 : 202 });
  }

  if (created) {
    try {
      // Cal validates event-specific responses dynamically in getBookingDataSchema.
      // Keep them on the runtime object alongside the statically typed base fields.
      if(input.rescheduleUid){
        const previous=await prisma.booking.findUnique({where:{uid:input.rescheduleUid},select:{status:true,startTime:true,userId:true,eventTypeId:true,metadata:true,attendees:{select:{email:true}}}});
        const meta=z.object({noskiTenantId:z.string(),noskiStripeSession:z.string()}).safeParse(previous?.metadata);
        if(!previous||previous.status!=="ACCEPTED"||previous.userId!==ownerId||previous.eventTypeId!==eventTypeId||previous.startTime.getTime()<Date.now()+86400000||!meta.success||meta.data.noskiTenantId!==String(input.tenantId)||meta.data.noskiStripeSession!==input.stripeSession||!previous.attendees.some(a=>a.email.toLowerCase()===input.attendee.email.toLowerCase()))throw Error("reschedule_not_allowed");
      }
      const bookingData = {
          ...(input.rescheduleUid ? {rescheduleUid:input.rescheduleUid,rescheduledBy:input.attendee.email} : {}),
          eventTypeId, eventTypeSlug: event.slug, user: event.owner.username,
          start: input.startsAt, end: input.endsAt, timeZone: "Europe/Warsaw", language: "pl",
          metadata: { noskiOperationId: id, noskiPayloadHash: payloadHash,
            noskiTenantId: String(input.tenantId), noskiStripeSession: input.stripeSession },
          responses: { name: input.attendee.name, email: input.attendee.email,
            location: { value: "integrations:google:meet", optionValue: "" } },
          creationSource: CreationSource.WEBAPP,
      };
      await getRegularBookingService().createBooking({
        bookingData,
        bookingMeta: { userId: ownerId, hostname: "konsultacje.noski-noski.pl" },
      });
    } catch {
      // Provider writes may have succeeded. Never retry creation after any unknown outcome.
      await prisma.noskiBookingOperation.update({ where: { id }, data: { status: "review" } });
    }
  }
  const found = await prisma.booking.findMany({
    where: { metadata: { path: ["noskiOperationId"], equals: id } }, take: 2,
    select: { uid: true, status: true, eventTypeId: true, userId: true, startTime: true, endTime: true,
      attendees: { select: { email: true } }, metadata: true,
      references: { where: { OR: [{ deleted: false }, { deleted: null }] }, select: { type: true, meetingUrl: true } } },
  });
  const booking = found.length === 1 ? found[0] : null;
  const meet = booking?.references.find(r => r.type === "google_meet_video")?.meetingUrl;
  const metadata = z.object({ noskiPayloadHash: z.string() }).safeParse(booking?.metadata);
  const validMeet = meet && /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meet);
  if (booking && metadata.success && metadata.data.noskiPayloadHash === payloadHash &&
    booking.status === "ACCEPTED" && booking.eventTypeId === eventTypeId && booking.userId === ownerId &&
    booking.startTime.getTime() === Date.parse(input.startsAt) && booking.endTime.getTime() === Date.parse(input.endsAt) &&
    booking.attendees.some(a => a.email.toLowerCase() === input.attendee.email.toLowerCase()) &&
    booking.references.some(r => r.type === "google_calendar") && validMeet) {
    const receipt = { status: "confirmed", bookingId: input.bookingId, uid: booking.uid,
      startsAt: input.startsAt, endsAt: input.endsAt, meetingUrl: meet };
    await prisma.noskiBookingOperation.update({ where: { id },
      data: { status: "confirmed", bookingUid: booking.uid, receipt } });
    return NextResponse.json(receipt);
  }
  return NextResponse.json({ status: "review", bookingId: input.bookingId }, { status: 202 });
}
