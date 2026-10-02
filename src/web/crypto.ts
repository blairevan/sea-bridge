import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Generate a 256-bit opaque browser credential. */
export function randomToken(): string { return randomBytes(32).toString("base64url"); }

/** Hash only high-entropy session and CSRF tokens. */
export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

/** Compare secret-derived strings without prefix-dependent timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Canonicalize JSON-compatible request data using stable object-key ordering. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("operation_payload_invalid");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** HMAC raw prompts so low-entropy requests cannot be guessed from the database alone. */
export function operationDigest(pepper: Uint8Array, payload: unknown): string {
  return createHmac("sha256", pepper).update(canonical(payload)).digest("hex");
}

/** Load an owner-private install key; never regenerate after persisted operations exist. */
export function loadOperationPepper(path: string, operationsExist: boolean): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || operationsExist) throw new Error("web_pepper_unavailable");
    const key = randomBytes(32);
    writeFileSync(path, key, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("web_pepper_invalid");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
