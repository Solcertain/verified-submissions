// Applies lib/db/migrations/*.sql in filename order, once each.
//
// The repo has drizzle-kit push, but push syncs the table shape only and drops
// the RLS statements the migrations carry. This runner applies the .sql files
// verbatim so the deployed database matches what is committed.
//
// Usage: DATABASE_URL=... node lib/db/migrate.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const migrations_dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(
    `create table if not exists _migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const { rows } = await client.query("select name from _migrations");
  const applied = new Set(rows.map((r) => r.name));
  const files = readdirSync(migrations_dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    // Each migration runs in its own transaction so a failure leaves no
    // half-applied schema and the run can be retried after a fix.
    await client.query("begin");
    try {
      await client.query(readFileSync(join(migrations_dir, file), "utf8"));
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`apply ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
    }
  }

  console.log(`Done. ${files.length} migration(s) checked.`);
} finally {
  await client.end();
}
