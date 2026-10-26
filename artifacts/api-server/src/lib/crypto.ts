import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

// Small, dependency-free helpers for the secrets customer accounts introduce:
// API keys and outcome tokens (stored as sha256), portal passwords (scrypt),
// each customer's ActiveProspect key (AES-256-GCM) and signed invite tokens.

// Constant-time string comparison to avoid leaking a secret via timing.
export function safe_equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sha256_hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function random_token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ── Passwords ───────────────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

function scrypt_async(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

// Stored as scrypt$N$salt$hash so the cost can be raised without breaking
// existing hashes.
export async function hash_password(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt_async(password, salt);
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verify_password(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: 8, p: 1 }, (err, k) =>
      err ? reject(err) : resolve(k),
    );
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ── Encrypted secrets ───────────────────────────────────────────────────────

// SECRETS_ENCRYPTION_KEY is 32 bytes, given as 64 hex characters or base64.
function encryption_key(): Buffer {
  const raw = process.env["SECRETS_ENCRYPTION_KEY"];
  if (!raw) throw new Error("SECRETS_ENCRYPTION_KEY is not set");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
  return key;
}

// v1:<iv>:<tag>:<ciphertext>, each base64.
export function encrypt_secret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryption_key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt_secret(stored: string): string {
  const [version, iv, tag, ct] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", encryption_key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// ── Signed tokens ───────────────────────────────────────────────────────────

// <base64url(json)>.<base64url(hmac-sha256)>. The payload carries its own
// expiry (exp, unix seconds); a token past it does not verify.
export function sign_token(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verify_token<T extends Record<string, unknown>>(
  token: string,
  secret: string,
  now_seconds = Math.floor(Date.now() / 1000),
): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safe_equal(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    const exp = payload["exp"];
    if (typeof exp !== "number" || exp < now_seconds) return null;
    return payload;
  } catch {
    return null;
  }
}
