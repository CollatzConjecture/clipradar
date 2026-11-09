/**
 * No relative imports and no TS-only syntax, so Node 24's built-in type
 * stripping runs it without a build step.
 */
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const MIGRATION_LOCK = 0x63_6c_69_70;

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

const pool = new pg.Pool({ connectionString: url });
const lock = await pool.connect();
try {
  await lock.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
  await migrate(drizzle({ client: pool }), {
    migrationsFolder: join(import.meta.dirname, "migrations"),
  });
} finally {
  // Ending the pool closes the lock's session, which releases the advisory lock.
  lock.release();
  await pool.end();
}
