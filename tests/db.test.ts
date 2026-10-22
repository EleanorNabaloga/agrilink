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
