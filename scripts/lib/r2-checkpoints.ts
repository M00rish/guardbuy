import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CheckpointError, checkpointKey, parseCheckpoint, type Checkpoint, type CheckpointStore } from "./checkpoints";

export class R2CheckpointStore implements CheckpointStore {
  constructor(private client: S3Client, private bucket: string) {}

  /** Test only a dedicated probe, never a real checkpoint. No config/admin access needed. */
  async verifyRetention() {
    // Rotate daily so an old probe's retention expiry cannot disable future runs.
    const Key = `checkpoints/retention-probes/${new Date().toISOString().slice(0, 10)}.txt`;
    const Body = "GuardBuy checkpoint retention probe v1\n";
    const input = { Bucket: this.bucket, Key };
    try {
      const r = await this.client.send(new GetObjectCommand(input));
      if (await r.Body!.transformToString() !== Body) throw new CheckpointError("Invalid R2 retention probe content");
    } catch (error) {
      const e = error as { $metadata?: { httpStatusCode?: number } };
      if (e.$metadata?.httpStatusCode !== 404) throw error;
      await this.client.send(new PutObjectCommand({ ...input, Body, ContentType: "text/plain", IfNoneMatch: "*" }));
    }
    // A 403 is NOT proof of a retention rule: require R2's explicit lock error.
    const locked = (error: unknown) => {
      const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
      return e.$metadata?.httpStatusCode === 409 && (e.name === "ObjectLockedByBucketPolicy" || e.Code === "ObjectLockedByBucketPolicy");
    };
    try {
      await this.client.send(new PutObjectCommand({ ...input, Body: "overwrite probe" }));
    } catch (error) {
      if (!locked(error)) throw error;
      try {
        await this.client.send(new DeleteObjectCommand(input));
      } catch (deleteError) {
        if (!locked(deleteError)) throw deleteError;
        return;
      }
      throw new CheckpointError("Invalid R2 retention: probe deletion was allowed");
    }
    // Restore the non-evidence probe if an unlocked bucket allowed the overwrite.
    await this.client.send(new PutObjectCommand({ ...input, Body }));
    throw new CheckpointError("Invalid R2 retention: probe overwrite was allowed; configure checkpoints/ bucket locks");
  }

  private async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const c = parseCheckpoint(JSON.parse(await r.Body!.transformToString()));
    if (checkpointKey(c) !== key) throw new CheckpointError("Checkpoint key disagrees with content");
    return c;
  }

  async list(stream: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: `checkpoints/v1/${stream}/`, ContinuationToken: token,
      }));
      for (const o of r.Contents ?? []) {
        if (!o.Key || !/^checkpoints\/v1\/[a-f0-9]{64}\/\d{12}\.json$/.test(o.Key)) throw new CheckpointError("Unexpected checkpoint object");
        keys.push(o.Key);
      }
      if (r.IsTruncated && !r.NextContinuationToken) throw new CheckpointError("Incomplete checkpoint listing");
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    const checkpoints: Checkpoint[] = [];
    for (const key of keys.sort()) checkpoints.push(await this.get(key));
    return checkpoints;
  }

  async create(checkpoint: Checkpoint) {
    const key = checkpointKey(checkpoint);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: JSON.stringify(checkpoint) + "\n",
        ContentType: "application/json", IfNoneMatch: "*",
      }));
      return checkpoint;
    } catch (error) {
      // R2 checks bucket locks before conditional headers, so locked duplicates return 409.
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 409 && status !== 412) throw error;
      return this.get(key);
    }
  }
}
