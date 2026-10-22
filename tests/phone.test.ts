import { test, expect } from "vitest";
import { normalizeUgPhone, networkOf } from "@/lib/phone";

test.each(["0772 123456", "772123456", "+256 772-123-456", "256772123456"])("%s normalises", (s) =>
  expect(normalizeUgPhone(s)).toBe("+256772123456"));
test.each(["0712", "+254712345678", "abc", "07721234567"])("%s refused", (s) => expect(normalizeUgPhone(s)).toBeNull());
test("networks", () => {
  expect(networkOf("+256772123456")).toBe("MTN");
  expect(networkOf("+256392123456")).toBe("MTN");
  expect(networkOf("+256752123456")).toBe("AIRTEL");
  expect(networkOf("+256202123456")).toBe("AIRTEL");
  expect(networkOf("+256712123456")).toBeNull();
});
