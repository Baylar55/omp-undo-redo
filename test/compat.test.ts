import { describe, expect, it } from "vitest";
import "../src/core/compat.js";

describe("Node compatibility", () => {
  it("provides Promise.withResolvers when missing or preserves native implementation", async () => {
    expect(typeof Promise.withResolvers).toBe("function");

    const { promise, resolve } = Promise.withResolvers<string>();
    resolve("compat-ok");
    await expect(promise).resolves.toBe("compat-ok");

    const failing = Promise.withResolvers<void>();
    failing.reject(new Error("compat-fail"));
    await expect(failing.promise).rejects.toThrow("compat-fail");
  });
});
