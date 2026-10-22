import type { calendar_v3 } from "@googleapis/calendar";

export type CancellationReference = {
  calendarId: string;
  eventId: string;
  iCalUID: string;
  startsAt: Date;
  endsAt: Date;
};

/** Never infer deletion from Cal's local reference.deleted flag. */
export async function verifyGoogleCancellation(
  calendar: calendar_v3.Calendar,
  reference: CancellationReference,
  allowDelete: boolean
): Promise<"removed" | "present" | "review"> {
  if (!reference.calendarId || !reference.eventId || !reference.iCalUID) return "review";
  try {
    // A missing event is meaningful only while the parent calendar is accessible.
    await calendar.calendars.get({ calendarId: reference.calendarId });
    const read = async () => {
      try {
        return (await calendar.events.get({ calendarId: reference.calendarId, eventId: reference.eventId })).data;
      } catch (error) {
        const code = (error as { response?: { status?: number } }).response?.status;
        if (code === 404 || code === 410) return null;
        throw error;
      }
    };
    const event = await read();
    if (!event || event.status === "cancelled") return "removed";
    if (event.id !== reference.eventId || event.iCalUID !== reference.iCalUID ||
      Date.parse(event.start?.dateTime || "") !== reference.startsAt.getTime() ||
      Date.parse(event.end?.dateTime || "") !== reference.endsAt.getTime() ||
      event.recurringEventId || event.recurrence?.length) return "review";
    if (!allowDelete) return "present";
    await calendar.events.delete({
      calendarId: reference.calendarId, eventId: reference.eventId, sendUpdates: "all",
    });
    const after = await read();
    return !after || after.status === "cancelled" ? "removed" : "review";
  } catch {
    // Auth failures, timeouts and uncertain writes must never produce a cancellation receipt.
    return "review";
  }
}
