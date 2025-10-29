// ABOUTME: Validates forwarding registry handler logic with Envio test helpers
// ABOUTME: Ensures intervals and registrations track union delegators accurately
import assert from "node:assert/strict";
import { TestHelpers } from "../generated";
import "../eventHandlers";

const STAKE_DAO_FORWARDER = "0xae86a3993d13c8d77ab77dbb8ccdb9b7bc18cd09";
const { MockDb, ForwarderRegistry: HelperRegistry } = TestHelpers;

const baseEventMeta = (blockNumber: number, timestamp: number, txHash: string) => ({
  block: { number: blockNumber, timestamp },
  transaction: { hash: txHash },
});

async function processSetReg(
  mockDb: ReturnType<typeof MockDb.createMockDb>,
  from: string,
  start: bigint,
  to: string = STAKE_DAO_FORWARDER,
  metaIndex = 0
) {
  const event = HelperRegistry.SetReg.createMockEvent({
    _from: from,
    _to: to,
    _start: start,
    mockEventData: baseEventMeta(100 + metaIndex, 1_700_000_000 + metaIndex, `0xset${metaIndex}`),
  });
  return HelperRegistry.SetReg.processEvent({ event, mockDb });
}

async function processExpReg(
  mockDb: ReturnType<typeof MockDb.createMockDb>,
  from: string,
  end: bigint,
  metaIndex = 0   
) { 
  const event = HelperRegistry.ExpReg.createMockEvent({
    _from: from,
    _end: end,
    mockEventData: baseEventMeta(200 + metaIndex, 1_700_001_000 + metaIndex, `0xexp${metaIndex}`),
  }); 
  return HelperRegistry.ExpReg.processEvent({ event, mockDb });
}

const getUnionIntervals = (mockDb: ReturnType<typeof MockDb.createMockDb>) =>
  mockDb.entities.Interval.getAll()
    .filter((interval) => interval.to === UNION)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

const getRegistration = (
  mockDb: ReturnType<typeof MockDb.createMockDb>,
  from: string
) => mockDb.entities.Registration.get(from.toLowerCase());

async function runSequence() {
  let db = MockDb.createMockDb();
  db = await processSetReg(db, "0x1111111111111111111111111111111111111111", 100n, UNION, 0);
  db = await processSetReg(db, "0x2222222222222222222222222222222222222222", 200n, UNION, 1);
  db = await processSetReg(db, "0x3333333333333333333333333333333333333333", 300n, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", 2);
  db = await processExpReg(db, "0x1111111111111111111111111111111111111111", 400n, 0);
  db = await processExpReg(db, "0x2222222222222222222222222222222222222222", 200n, 1); // cancellation
  return db;
}

async function testUnionCoverage() {
  const db = await runSequence();
  const unionIntervals = getUnionIntervals(db);
  assert.equal(unionIntervals.length, 2, "Tracks both delegators forwarding to union");
  const [first] = unionIntervals;
  assert.equal(first.from, "0x1111111111111111111111111111111111111111");
  assert.equal(first.to, UNION);
  assert.equal(first.canceled, false);
  assert.equal(first.expiration, 400n);
  assert.equal(first.txHash.startsWith("0xexp"), true);
}

async function testCancellation() {
  const db = await runSequence();
  const registration = getRegistration(
    db,
    "0x2222222222222222222222222222222222222222"
  );
  assert.ok(registration);
  assert.equal(registration?.expiration, 200n);
  const [_, second] = getUnionIntervals(db);
  assert.equal(second.canceled, true);
  assert.equal(second.expiration, 200n);
}

async function testNonUnionIgnored() {
  const db = await runSequence();
  const others = db.entities.Interval.getAll().filter((it) => it.to !== UNION);
  assert.equal(others.length, 1);
  assert.equal(others[0].from, "0x3333333333333333333333333333333333333333");
}

export async function runForwarderTests() {
  await testUnionCoverage();
  await testCancellation();
  await testNonUnionIgnored();
}

if (require.main === module) {
  runForwarderTests()
    .then(() => {
      console.log("Forwarding registry handler tests passed");
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
