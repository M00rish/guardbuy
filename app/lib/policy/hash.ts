import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so equal data always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const hashOf = (value: unknown) => sha256Hex(canonicalJson(value));
