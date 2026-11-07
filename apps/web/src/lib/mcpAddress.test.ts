import { describe, expect, it } from "vitest";
import { mcpAddressIsSafe } from "./mcpAddress.js";

describe("mcpAddressIsSafe", () => {
  it("accepts HTTPS and this machine", () => {
    for (const url of [
      "https://muny.example.ts.net",
      "https://192.0.2.10:8420",
      "http://localhost:5173",
      "http://muny.localhost",
      "http://127.0.0.1:8420",
      "http://[::1]:8420",
    ])
      expect(mcpAddressIsSafe(url), url).toBe(true);
  });

  it("flags plain HTTP on anything else", () => {
    for (const url of [
      "http://192.0.2.10:8420",
      "http://muny.example.com",
      "http://muny:8420",
      "http://localhost.example.com",
    ])
      expect(mcpAddressIsSafe(url), url).toBe(false);
  });
});
