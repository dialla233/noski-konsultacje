import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleCancellation } from './verify-google-cancellation.ts';
const reference = { calendarId: 'primary', eventId: 'event1', iCalUID: 'noski1', startsAt: new Date('2026-11-01T10:00:00Z'), endsAt: new Date('2026-11-01T11:00:00Z') };
const event = { id: 'event1', iCalUID: 'noski1', status: 'confirmed', start: { dateTime: reference.startsAt.toISOString() }, end: { dateTime: reference.endsAt.toISOString() } };
const failure = status => Object.assign(new Error('provider'), { response: { status } });
function fake(reads, calendarError, deleteError) {
  let deletes = 0, gets = 0;
  return { client: { calendars: { get: async () => { if(calendarError)throw calendarError;return {data:{id:'primary'}}; } }, events: {
    get: async () => { gets++;const next=reads.shift();if(next instanceof Error)throw next;return {data:next}; },
    delete: async args => { deletes++;assert.equal(args.sendUpdates,'all');if(deleteError)throw deleteError;return {}; },
  } }, counts: () => ({deletes,gets}) };
}
test('inaccessible parent calendar never proves event removal',async()=>{
  const f=fake([failure(404)],failure(404));assert.equal(await verifyGoogleCancellation(f.client,reference,true),'review');assert.deepEqual(f.counts(),{deletes:0,gets:0});
});
test('event absent in accessible calendar is removed without another delete',async()=>{
  for(const code of [404,410]) { const f=fake([failure(code)]);assert.equal(await verifyGoogleCancellation(f.client,reference,true),'removed');assert.equal(f.counts().deletes,0); }
});
test('foreign UID, changed time and recurring events cannot be deleted',async()=>{
  for(const altered of [{...event,iCalUID:'other'},{...event,start:{dateTime:'2026-11-02T10:00:00Z'}},{...event,recurringEventId:'series'}]) {
    const f=fake([altered]);assert.equal(await verifyGoogleCancellation(f.client,reference,true),'review');assert.equal(f.counts().deletes,0);
  }
});
test('lookup does not mutate a matching live event',async()=>{
  const f=fake([event]);assert.equal(await verifyGoogleCancellation(f.client,reference,false),'present');assert.equal(f.counts().deletes,0);
});
test('delete requires independent readback',async()=>{
  const f=fake([event,failure(410)]);assert.equal(await verifyGoogleCancellation(f.client,reference,true),'removed');assert.deepEqual(f.counts(),{deletes:1,gets:2});
  const remains=fake([event,event]);assert.equal(await verifyGoogleCancellation(remains.client,reference,true),'review');
});
test('write timeout or read authorization failure remains unknown',async()=>{
  const timeout=fake([event],undefined,new Error('timeout'));assert.equal(await verifyGoogleCancellation(timeout.client,reference,true),'review');
  const forbidden=fake([event,failure(403)]);assert.equal(await verifyGoogleCancellation(forbidden.client,reference,true),'review');
});
