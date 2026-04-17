import { describe, expect, it, vi } from "vitest";
import { retryOnBusy } from "../src/db/connection.js";

describe("retryOnBusy", () => {
  it("retries SQLITE_BUSY failures until the operation succeeds", () => {
    const operation = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        const error = new Error("SQLITE_BUSY: database is locked") as Error & { code?: string };
        error.code = "SQLITE_BUSY";
        throw error;
      })
      .mockImplementationOnce(() => {
        const error = new Error("database is locked") as Error & { code?: string };
        error.code = "SQLITE_LOCKED";
        throw error;
      })
      .mockImplementation(() => "ok");

    expect(retryOnBusy(operation, 3)).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-busy failures immediately", () => {
    const operation = vi.fn<() => void>().mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => retryOnBusy(operation, 3)).toThrow("boom");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});