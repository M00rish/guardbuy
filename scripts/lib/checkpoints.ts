import { canonicalJson, sha256Hex } from "../../app/lib/policy/hash";

// Only these deliberate, data-free errors may be shown in Actions logs.
export class CheckpointError extends Error {}

export type AuditRow = { shop: string; seq: number; at: string; event: unknown; prevHash: string; hash: string };
export type Stream = { shop: string; baseline: { seq: number; hash: string } };
export type Checkpoint = {
  version: 1;
  stream: string;
  seq: number;
  hash: string;
  publishedAt: string;
  previous: string | null;
};
const HASH = /^[a-f0-9]{64}$/;
export const streamId = (shop: string) => sha256Hex(shop);
export const checkpointHash = (checkpoint: Checkpoint) => sha256Hex(canonicalJson(checkpoint));
export const checkpointKey = (checkpoint: Pick<Checkpoint, "stream" | "seq">) =>
  `checkpoints/v1/${checkpoint.stream}/${String(checkpoint.seq).padStart(12, "0")}.json`;

export function parseStreams(value: unknown): Stream[] {
  if (!Array.isArray(value) || !value.length) throw new CheckpointError("Configure at least one trusted audit stream");
  const streams = value as Stream[];
  for (const s of streams) {
    if (!s || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s.shop) ||
        !Number.isSafeInteger(s.baseline?.seq) || s.baseline.seq < 0 || !HASH.test(s.baseline.hash)) {
      throw new CheckpointError("Invalid audit stream or pinned baseline");
    }
  }
  if (new Set(streams.map((s) => s.shop)).size !== streams.length) throw new CheckpointError("Duplicate audit stream");
  return streams;
}

export function parseCheckpoint(value: unknown): Checkpoint {
  const c = value as Checkpoint;
  if (!c || c.version !== 1 || !HASH.test(c.stream) || !Number.isSafeInteger(c.seq) || c.seq < 0 ||
      !HASH.test(c.hash) || typeof c.publishedAt !== "string" ||
      !Number.isFinite(Date.parse(c.publishedAt)) || (c.previous !== null && !HASH.test(c.previous))) {
    throw new CheckpointError("Invalid external checkpoint");
  }
  return c;
}

/** Recompute content, rather than trusting hashes supplied by the database. */
export function verifyHistory(stream: Stream, rows: AuditRow[], checkpoints: Checkpoint[], bootstrap = false) {
  const id = streamId(stream.shop);
  const fail = (why: string): never => { throw new CheckpointError(`${id.slice(0, 12)}: ${why}`); };
  let previous = "0".repeat(64);
  for (const [seq, row] of rows.entries()) {
    if (row.shop !== stream.shop || row.seq !== seq) fail("missing, reordered or foreign audit entry");
    if (row.prevHash !== previous) fail(`broken chain at ${seq}`);
    const { shop, at, event } = row;
    if (sha256Hex(previous + canonicalJson({ seq, shop, at, event })) !== row.hash) fail(`changed content at ${seq}`);
    previous = row.hash;
  }
  if (rows[stream.baseline.seq]?.hash !== stream.baseline.hash) fail("history disagrees with pinned baseline or is missing");
  if (!checkpoints.length && !bootstrap) fail("external checkpoints missing; explicit bootstrap required");
  let prior: Checkpoint | undefined;
  for (const raw of checkpoints) {
    const c = parseCheckpoint(raw);
    if (c.stream !== id || c.seq < stream.baseline.seq) fail("foreign checkpoint or checkpoint before baseline");
    if (prior && c.seq <= prior.seq) fail("duplicate or reordered checkpoint sequence");
    if (c.previous !== (prior ? checkpointHash(prior) : null)) fail("external checkpoint history is missing or changed");
    if (rows[c.seq]?.hash !== c.hash) fail(`database rewritten or truncated at checkpoint ${c.seq}`);
    prior = c;
  }
  const head = rows.at(-1)!;
  return { stream: id, seq: head.seq, hash: head.hash, unchanged: prior?.seq === head.seq, previous: prior ? checkpointHash(prior) : null };
}

export interface CheckpointStore {
  list(stream: string): Promise<Checkpoint[]>;
  // Must create only. On retry, return the already-present object; never overwrite.
  create(checkpoint: Checkpoint): Promise<Checkpoint>;
}

/** Verify every enrolled stream before writing any checkpoint. No implicit discovery/enrollment. */
export async function publishCheckpoints(
  streams: Stream[],
  read: (shop: string) => Promise<AuditRow[]>,
  store: CheckpointStore,
  bootstrap = false,
) {
  const plans = [];
  for (const stream of streams) {
    plans.push(verifyHistory(stream, await read(stream.shop), await store.list(streamId(stream.shop)), bootstrap));
  }
  const results = [];
  for (const plan of plans) {
    if (!plan.unchanged) {
      const proposed: Checkpoint = {
        version: 1, stream: plan.stream, seq: plan.seq, hash: plan.hash,
        publishedAt: new Date().toISOString(), previous: plan.previous,
      };
      const stored = parseCheckpoint(await store.create(proposed));
      if (stored.stream !== proposed.stream || stored.seq !== proposed.seq || stored.hash !== proposed.hash || stored.previous !== proposed.previous) {
        throw new CheckpointError("Conflicting checkpoint: refusing to replace evidence");
      }
    }
    results.push({ stream: plan.stream, protectedThrough: plan.seq, hash: plan.hash, published: !plan.unchanged });
  }
  return results;
}
