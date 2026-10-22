import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Uses TEST_DATABASE_URL when set. Otherwise starts a local Postgres with the
 * `embedded-postgres` package, creates a test database and points both
 * TEST_DATABASE_URL and DATABASE_URL at it for the tests.
 */
export default async function setup() {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    return;
  }

  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agrilink-pg-"));
  const port = 54329;
  const pgServer = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pgServer.initialise();
  await pgServer.start();
  await pgServer.createDatabase("agrilink_test");

  const url = `postgres://postgres:postgres@localhost:${port}/agrilink_test`;
  process.env.TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;

  return async () => {
    await pgServer.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
}
