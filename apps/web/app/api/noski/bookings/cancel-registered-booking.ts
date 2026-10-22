import prisma from '@calcom/prisma';
import { credentialForCalendarServiceSelect } from '@calcom/prisma/selects/credential';
import { CalendarAuth } from '@calcom/app-store/googlecalendar/lib/CalendarAuth';
import handleCancelBooking from '@calcom/features/bookings/lib/handleCancelBooking';
import { verifyGoogleCancellation } from './verify-google-cancellation';

/** Called only after the bridge verifies signature, mode and the original payload hash. */
export async function cancelRegisteredBooking(input: {
  operationId: string; payloadHash: string; ownerId: number; eventTypeId: number;
  startsAt: string; endsAt: string; attendeeEmail: string; allowCancel: boolean;
}): Promise<{ status: 'canceled'; uid: string } | { status: 'review' }> {
  const operation = await prisma.noskiBookingOperation.findUnique({where:{id:input.operationId}});
  if (!operation || operation.payloadHash !== input.payloadHash || !operation.bookingUid) return {status:'review'};
  const booking = await prisma.booking.findUnique({where:{uid:operation.bookingUid},include:{
    attendees:true,references:true,payment:true,
  }});
  if (!booking || booking.userId !== input.ownerId || booking.eventTypeId !== input.eventTypeId ||
    booking.startTime.getTime() !== Date.parse(input.startsAt) || booking.endTime.getTime() !== Date.parse(input.endsAt) ||
    !booking.attendees.some(a=>a.email.toLowerCase()===input.attendeeEmail.toLowerCase()) ||
    booking.recurringEventId || booking.payment.length || !booking.iCalUID) return {status:'review'};
  const refs=booking.references.filter(r=>r.type==='google_calendar');
  if (!refs.length || refs.some(r=>!r.credentialId || !r.externalCalendarId || !r.uid)) return {status:'review'};
  if (booking.status !== 'CANCELLED') {
    if (!input.allowCancel || booking.status !== 'ACCEPTED') return {status:'review'};
    // Only one caller gets permission to invoke Cal's non-idempotent cancellation handler.
    const claimed=await prisma.noskiBookingOperation.updateMany({
      where:{id:input.operationId,payloadHash:input.payloadHash,status:'confirmed'},data:{status:'canceling'},
    });
    if (claimed.count!==1) return {status:'review'};
    try {
      await handleCancelBooking({userId:input.ownerId,bookingData:{uid:booking.uid,
        cancellationReason:'Anulowanie konsultacji przez panel Noski Noski',cancelledBy:input.attendeeEmail}});
    } catch { return {status:'review'}; }
  }
  const current=await prisma.booking.findUnique({where:{uid:booking.uid},select:{status:true}});
  if(current?.status!=='CANCELLED')return {status:'review'};
  for(const ref of refs) {
    const credential=await prisma.credential.findFirst({where:{id:ref.credentialId!,userId:input.ownerId,type:'google_calendar'},select:credentialForCalendarServiceSelect});
    if(!credential)return {status:'review'};
    try {
      const calendar=await new CalendarAuth(credential).getClient();
      const result=await verifyGoogleCancellation(calendar,{calendarId:ref.externalCalendarId!,eventId:ref.uid,
        iCalUID:booking.iCalUID,startsAt:booking.startTime,endsAt:booking.endTime},input.allowCancel);
      if(result!=='removed')return {status:'review'};
    } catch {return {status:'review'};}
  }
  await prisma.noskiBookingOperation.update({where:{id:input.operationId},data:{status:'canceled'}});
  return {status:'canceled',uid:booking.uid};
}
