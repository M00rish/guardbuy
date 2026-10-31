import assert from "node:assert/strict";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { canonicalJson, sha256Hex } from "../app/lib/policy/hash";
import { checkpointHash, parseStreams, publishCheckpoints, streamId, verifyHistory,
  type AuditRow, type Checkpoint, type CheckpointStore, type Stream } from "./lib/checkpoints";
import { R2CheckpointStore } from "./lib/r2-checkpoints";

const shop = "checkpoint-test.myshopify.com";
function history(events: unknown[]): AuditRow[] {
  let prevHash = "0".repeat(64);
  return events.map((event, seq) => {
    const value = { shop, seq, at: "2026-10-30T00:00:00.000Z", event };
    const row = { ...value, prevHash, hash: sha256Hex(prevHash + canonicalJson(value)) };
    prevHash = row.hash;
    return row;
  });
}
const original = history([{ amount: 10 }, { amount: 20 }, { amount: 30 }]);
const stream: Stream = { shop, baseline: { seq: 0, hash: original[0].hash } };
const first: Checkpoint = { version: 1, stream: streamId(shop), seq: 1, hash: original[1].hash,
  publishedAt: "2026-10-30T01:00:00.000Z", previous: null };
const second: Checkpoint = { ...first, seq: 2, hash: original[2].hash, previous: checkpointHash(first) };
let passed = 0;
async function test(name: string, fn: () => unknown) {
  await fn(); passed++; console.log(`PASS ${name}`);
}
function memory(initial = [first]) {
  const values = structuredClone(initial);
  let writes = 0;
  const store: CheckpointStore = {
    list: async () => structuredClone(values),
    create: async (c) => {
      const existing = values.find((v) => v.seq === c.seq);
      if (existing) return structuredClone(existing);
      writes++; values.push(structuredClone(c)); return c;
    },
  };
  return { values, store, writes: () => writes };
}

await test("legitimate append publishes; repeated run does not write", async () => {
  const m = memory();
  assert.equal((await publishCheckpoints([stream], async () => original, m.store))[0].published, true);
  assert.equal((await publishCheckpoints([stream], async () => original, m.store))[0].published, false);
  assert.equal(m.writes(), 1);
});
await test("fully recomputed rewrite after pinned baseline is caught by external checkpoint", () => {
  const rewritten = history([{ amount: 10 }, { amount: 999 }, { amount: 30 }]);
  // These rows form a valid internal hash chain and still match the older baseline.
  assert.throws(() => verifyHistory(stream, rewritten, [first]), /rewritten or truncated/);
});
await test("changed baseline cannot be silently enrolled", () => {
  assert.throws(() => verifyHistory(stream, history([{ amount: 999 }]), [], true), /pinned baseline/);
});
await test("truncation and empty/missing store fail", () => {
  assert.throws(() => verifyHistory(stream, original.slice(0, 1), [first]), /truncated/);
  assert.throws(() => verifyHistory(stream, [], [first]), /missing/);
});
await test("missing row and content changes fail", () => {
  assert.throws(() => verifyHistory(stream, [original[0], original[2]], [first]), /missing/);
  const rows = structuredClone(original); rows[1].event = { amount: 77 };
  assert.throws(() => verifyHistory(stream, rows, [first]), /changed content/);
});
await test("external checkpoint removal, conflicts, reordering and foreign streams fail", () => {
  assert.throws(() => verifyHistory(stream, original, []), /explicit bootstrap/);
  assert.throws(() => verifyHistory(stream, original, [second]), /external checkpoint history/);
  assert.throws(() => verifyHistory(stream, original, [first, { ...first, hash: "a".repeat(64) }]), /duplicate/);
  assert.throws(() => verifyHistory(stream, original, [{ ...first, stream: "a".repeat(64) }]), /foreign/);
});
await test("bootstrap is explicit and pinned; subsequent missing state is not reset", async () => {
  const m = memory([]);
  await assert.rejects(publishCheckpoints([stream], async () => original, m.store), /bootstrap/);
  await publishCheckpoints([stream], async () => original, m.store, true);
  assert.equal(m.values[0].previous, null);
  assert.equal(m.writes(), 1);
});
await test("one failed stream prevents publication for all streams", async () => {
  const m = memory();
  const other = { ...stream, shop: "missing-store.myshopify.com" };
  await assert.rejects(publishCheckpoints([stream, other], async (s) => s === shop ? original : [], m.store));
  assert.equal(m.writes(), 0);
});
await test("publication failures are retryable and cannot claim success", async () => {
  const m = memory();
  await assert.rejects(publishCheckpoints([stream], async () => original, {
    ...m.store, create: async () => { throw new Error("network unavailable"); },
  }), /network unavailable/);
  await publishCheckpoints([stream], async () => original, m.store);
  assert.equal(m.writes(), 1);
});
await test("concurrent equivalent creation accepted; conflicting creation rejected", async () => {
  const m = memory();
  const concurrent: CheckpointStore = { ...m.store, create: async (c) => ({ ...c, publishedAt: "2026-10-30T02:00:00.000Z" }) };
  await publishCheckpoints([stream], async () => original, concurrent);
  await assert.rejects(publishCheckpoints([stream], async () => original, {
    ...concurrent, create: async (c) => ({ ...c, hash: "b".repeat(64) }),
  }), /Conflicting checkpoint/);
});
await test("invalid and duplicate stream configurations rejected", () => {
  assert.throws(() => parseStreams([]));
  assert.throws(() => parseStreams([stream, stream]));
  assert.throws(() => parseStreams([{ ...stream, baseline: { seq: -1, hash: "bad" } }]));
});
await test("R2 adapter paginates, sorts and checks object names against content", async () => {
  const keys = [first, second].map((c) => `checkpoints/v1/${c.stream}/${String(c.seq).padStart(12, "0")}.json`);
  let pages = 0;
  const client = { send: async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      pages++;
      return command.input.ContinuationToken
        ? { Contents: [{ Key: keys[0] }], IsTruncated: false }
        : { Contents: [{ Key: keys[1] }], IsTruncated: true, NextContinuationToken: "page2" };
    }
    assert(command instanceof GetObjectCommand);
    const c = command.input.Key === keys[0] ? first : second;
    return { Body: { transformToString: async () => JSON.stringify(c) } };
  } } as unknown as S3Client;
  assert.deepEqual(await new R2CheckpointStore(client, "test").list(first.stream), [first, second]);
  assert.equal(pages, 2);
});
await test("R2 locked/conditional duplicates are read back, never overwritten", async () => {
  for (const status of [409, 412]) {
    let puts = 0;
    const client = { send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        puts++; assert.equal(command.input.IfNoneMatch, "*");
        throw { $metadata: { httpStatusCode: status } };
      }
      assert(command instanceof GetObjectCommand);
      return { Body: { transformToString: async () => JSON.stringify(first) } };
    } } as unknown as S3Client;
    assert.deepEqual(await new R2CheckpointStore(client, "test").create(first), first);
    assert.equal(puts, 1);
  }
});
await test("retention probe requires explicit lock rejection for overwrite and deletion", async () => {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown) => {
    commands.push(command);
    if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => "GuardBuy checkpoint retention probe v1\n" } };
    assert(command instanceof PutObjectCommand || command instanceof DeleteObjectCommand);
    assert.match(command.input.Key!, /^checkpoints\/retention-probes\/\d{4}-\d{2}-\d{2}\.txt$/);
    throw { name: "ObjectLockedByBucketPolicy", $metadata: { httpStatusCode: 409 } };
  } } as unknown as S3Client;
  await new R2CheckpointStore(client, "test").verifyRetention();
  assert(commands.some((c) => c instanceof PutObjectCommand));
  assert(commands.some((c) => c instanceof DeleteObjectCommand));
});
await test("unlocked bucket and generic permission errors cannot pass retention checks", async () => {
  for (const denied of [false, true]) {
    const client = { send: async (command: unknown) => {
      if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => "GuardBuy checkpoint retention probe v1\n" } };
      if (denied) throw { name: "AccessDenied", $metadata: { httpStatusCode: 403 } };
      return {};
    } } as unknown as S3Client;
    await assert.rejects(new R2CheckpointStore(client, "test").verifyRetention());
  }
});
console.log(`${passed} checkpoint checks passed; no network, database or payment calls.`);
