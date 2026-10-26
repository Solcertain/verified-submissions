import { describe, it, expect, afterEach } from "vitest";
import { decrypt_secret, encrypt_secret, hash_password, sign_token, verify_password, verify_token } from "../lib/crypto.js";
import { api_key_prefix } from "../services/customer_store.js";

describe("secrets", () => {
  afterEach(() => {
    delete process.env["SECRETS_ENCRYPTION_KEY"];
  });

  it("round-trips an ActiveProspect key and detects tampering", () => {
    process.env["SECRETS_ENCRYPTION_KEY"] = "ab".repeat(32);
    const enc = encrypt_secret("ap-live-key");
    expect(enc).not.toContain("ap-live-key");
    expect(decrypt_secret(enc)).toBe("ap-live-key");
    const parts = enc.split(":");
    parts[3] = Buffer.from("other").toString("base64");
    expect(() => decrypt_secret(parts.join(":"))).toThrow();
  });

  it("refuses to encrypt without a 32-byte key", () => {
    expect(() => encrypt_secret("x")).toThrow(/SECRETS_ENCRYPTION_KEY/);
    process.env["SECRETS_ENCRYPTION_KEY"] = "short";
    expect(() => encrypt_secret("x")).toThrow(/32 bytes/);
  });

  it("hashes passwords with scrypt and verifies them", async () => {
    const stored = await hash_password("correct horse");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verify_password("correct horse", stored)).toBe(true);
    expect(await verify_password("wrong", stored)).toBe(false);
  });

  it("verifies signed tokens and rejects tampered or expired ones", () => {
    const now = 1_000_000;
    const t = sign_token({ email: "a@b.com", exp: now + 60 }, "s");
    expect(verify_token(t, "s", now)).toMatchObject({ email: "a@b.com" });
    expect(verify_token(t, "other", now)).toBeNull();
    expect(verify_token(t, "s", now + 120)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ email: "evil@x.com", exp: now + 60 })).toString("base64url");
    expect(verify_token(`${forged}.${sig}`, "s", now)).toBeNull();
    expect(body).toBeTruthy();
  });

  it("recognises only well-formed customer API keys", () => {
    expect(api_key_prefix("vsk_0123456789_abcdefghijklmnopqrstuvwxyz")).toBe("vsk_0123456789");
    expect(api_key_prefix("vsk_0123456789")).toBeNull();
    expect(api_key_prefix("some-internal-key")).toBeNull();
  });
});
