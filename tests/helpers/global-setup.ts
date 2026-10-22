import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Asks the OS for an unused TCP port on 127.0.0.1. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

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
  const port = await findFreePort();
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
