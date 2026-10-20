import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@calcom/prisma";
import { getAvailableSlotsService } from "@calcom/features/di/containers/AvailableSlots";

export const runtime = "nodejs";
export const maxDuration = 60;
const inputSchema = z.object({
  live: z.boolean(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
}).strict().refine(v => {
  const duration = Date.parse(v.endTime) - Date.parse(v.startTime);
  return duration > 0 && duration <= 14 * 86400000;
});
const reply = (body: object, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});

export async function POST(req: Request) {
  const secret = process.env.NOSKI_BOOKING_BRIDGE_SECRET;
  const mode = process.env.NOSKI_BOOKING_BRIDGE_MODE;
  const eventTypeId = Number(process.env.NOSKI_BOOKING_EVENT_TYPE_ID);
  const ownerId = Number(process.env.NOSKI_BOOKING_OWNER_ID);
  if (!secret || secret.length < 64 || !["test", "live"].includes(mode || "") ||
    !Number.isSafeInteger(eventTypeId) || eventTypeId <= 0 ||
    !Number.isSafeInteger(ownerId) || ownerId <= 0)
    return reply({ error: "not_configured" }, 503);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 1024) return reply({ error: "too_large" }, 413);
  const timestamp = req.headers.get("x-noski-timestamp") || "";
  const signature = req.headers.get("x-noski-signature") || "";
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300000 ||
    !/^[a-f0-9]{64}$/.test(signature)) return reply({ error: "unauthorized" }, 401);
  // Bind the signature to this operation, so a booking request cannot be replayed here.
  const expected = createHmac("sha256", secret).update(`availability\n${timestamp}\n${raw}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    return reply({ error: "unauthorized" }, 401);
  let input;
  try { input = inputSchema.safeParse(JSON.parse(raw)); }
  catch { return reply({ error: "invalid_request" }, 400); }
  if (!input.success) return reply({ error: "invalid_request" }, 400);
  if (input.data.live !== (mode === "live")) return reply({ error: "wrong_environment" }, 409);
  const start = Date.parse(input.data.startTime), end = Date.parse(input.data.endTime);
  const now = Date.now();
  if (start < now - 60000 || end > now + 61 * 86400000)
    return reply({ error: "invalid_range" }, 400);
  try {
    const event = await prisma.eventType.findFirst({
      where: { id: eventTypeId, userId: ownerId }, select: { id: true, length: true },
    });
    if (!event || event.length !== 60) return reply({ error: "event_configuration" }, 503);
    const result = await getAvailableSlotsService().getAvailableSlots({ input: {
      eventTypeId, startTime: input.data.startTime, endTime: input.data.endTime,
      timeZone: "Europe/Warsaw", isTeamEvent: false,
      _bypassCalendarBusyTimes: false, _silentCalendarFailures: false,
    } });
    const slots = Array.from(new Set(Object.values(result.slots).flat().map(slot => slot.time)))
      .filter(time => Number.isFinite(Date.parse(time)) && Date.parse(time) >= start &&
        Date.parse(time) < end && Date.parse(time) >= now + 86400000).sort();
    return reply({ startTime: input.data.startTime, endTime: input.data.endTime, slots });
  } catch {
    // A provider failure is not proof that the owner's calendar is free.
    return reply({ error: "availability_unavailable" }, 503);
  }
}
