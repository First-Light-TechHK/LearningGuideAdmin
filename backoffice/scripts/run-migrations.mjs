import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import pg from "pg";

import { loadEnv, projectRoot, requireEnv } from "./env.mjs";

loadEnv();

const migrationsDir = resolve(projectRoot, "db", "migrations");
const client = new pg.Client({ connectionString: requireEnv("DATABASE_URL") });

async function main() {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query("SELECT filename FROM schema_migrations")).rows.map((row) => row.filename)
  );

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }

    const sql = readFileSync(resolve(migrationsDir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`apply ${file}`);
      count += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration failed: ${file}\n${error.message}`);
    }
  }

  console.log(count === 0 ? "No pending migrations." : `Applied ${count} migration(s).`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
