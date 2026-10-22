import pg from "pg";
import { migrate } from "../../scripts/migrate.mjs";

/** Drop everything in the test database, then re-run migrations and seed. */
export async function resetDb(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (global setup should provide it)");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema public cascade; create schema public;");
  } finally {
    await client.end();
  }
  await migrate(url);
}
