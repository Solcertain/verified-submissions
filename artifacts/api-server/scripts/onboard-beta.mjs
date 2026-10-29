// Sets up one beta tester through the admin API: an active customer with no
// Stripe subscription (usage counted, never billed), an API key and an outcome
// URL. Optionally stores their ActiveProspect key.
//
// Usage (from artifacts/api-server, with INTERNAL_API_KEY in the environment or .env.local):
//   node scripts/onboard-beta.mjs --name "Acme Leads" --email ops@acme.com [--role buyer] [--tier founder]
//
// To store the tester's ActiveProspect key as well, put it in the environment as
// CUSTOMER_ACTIVEPROSPECT_KEY rather than on the command line, so it stays out of
// shell history. Needs SECRETS_ENCRYPTION_KEY set in Vercel.
//
// The API key and outcome URL are printed once and cannot be shown again.
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env["VS_API_BASE"] ?? "https://verified-submissions-api.vercel.app/api";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function internal_key() {
  if (process.env["INTERNAL_API_KEY"]) return process.env["INTERNAL_API_KEY"];
  if (existsSync(".env.local")) {
    const m = /^INTERNAL_API_KEY="?([^"\r\n]+)"?/m.exec(readFileSync(".env.local", "utf8"));
    if (m) return m[1];
  }
  throw new Error("INTERNAL_API_KEY is not set (environment or .env.local)");
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-api-key": internal_key(), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error ?? "failed"}`);
  return json;
}

const name = arg("name");
const email = arg("email");
if (!name || !email) {
  console.error('Usage: node scripts/onboard-beta.mjs --name "Company" --email person@company.com [--role seller|buyer|both] [--tier founder]');
  process.exit(1);
}

const { customer_id } = await call("POST", "/admin/customers", {
  name,
  email,
  role: arg("role"),
  tier: arg("tier"),
});
const { key } = await call("POST", `/admin/customers/${customer_id}/api-keys`, { label: "beta" });
const { path } = await call("POST", `/admin/customers/${customer_id}/outcome-tokens`, { label: "beta" });

let ap = "not set: store it later with PUT /api/admin/customers/<id>/activeprospect-key";
if (process.env["CUSTOMER_ACTIVEPROSPECT_KEY"]) {
  await call("PUT", `/admin/customers/${customer_id}/activeprospect-key`, {
    key: process.env["CUSTOMER_ACTIVEPROSPECT_KEY"],
  });
  ap = "stored (encrypted)";
}

const public_base = BASE.replace(/\/api$/, "");
console.log(`
Customer     ${name} <${email}>
Customer id  ${customer_id}
API key      ${key}
Verify URL   ${public_base}/api/v1/verify
Outcome URL  ${public_base}${path}
ActiveProspect key: ${ap}

Send the API key and outcome URL to the tester over a private channel; neither can be shown again.`);
