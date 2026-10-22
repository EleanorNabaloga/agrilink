import { afterAll, expect, test } from "vitest";
import { closePool, query, withTransaction } from "@/lib/db";
import { resetDb } from "./helpers/db";

afterAll(closePool);

test("migrations create all tables and seed products", async () => {
  await resetDb();
  const { rows } = await query<{ n: string }>("select count(*) n from products");
  expect(Number(rows[0].n)).toBe(12);
});

test("withTransaction rolls back on error", async () => {
  await resetDb();
  await expect(
    withTransaction(async (tx) => {
      await tx.query("insert into users (phone, role, language) values ('+256772000001','buyer','en')");
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const { rows } = await query("select * from users");
  expect(rows).toHaveLength(0);
});

test("afterCommit callbacks run after the connection is released", async () => {
  await resetDb();
  // Hold 9 of the 10 pool connections, then run a transaction whose callback needs a query.
  const held: Array<() => void> = [];
  const blockers = Array.from({ length: 9 }, () => {
    let done!: () => void;
    const gate = new Promise<void>((r) => (done = r));
    held.push(done);
    return withTransaction(async () => {
      await gate;
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  let ran = false;
  await withTransaction(async (tx) => {
    tx.afterCommit(async () => {
      // With the transaction's own connection still held this would need the 10th... which is
      // taken by the transaction itself, so it would hang forever.
      await query("select 1");
      ran = true;
    });
  });
  expect(ran).toBe(true);
  held.forEach((d) => d());
  await Promise.all(blockers);
});
