import { describe, expect, it } from "vitest";
import { unreachable } from "./compatible.js";

// What fetch throws when it never gets an answer: a TypeError whose cause carries the code.
const failed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
const BASE = "https://ai.example.test:8443/v1";

describe("why the AI server couldn't be reached", () => {
  it("names a certificate Muny doesn't trust and how to fix it", () => {
    for (const code of ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"]) {
      const m = unreachable(failed(code), BASE, 120);
      expect(m).toContain("doesn't trust the certificate on ai.example.test:8443");
      expect(m).toContain("NODE_EXTRA_CA_CERTS");
    }
  });

  it("tells lookups, refusals, timeouts and expired certificates apart", () => {
    expect(unreachable(failed("ENOTFOUND"), BASE, 120)).toContain("couldn't look up");
    expect(unreachable(failed("ECONNREFUSED"), BASE, 120)).toContain("refused the connection");
    expect(unreachable(failed("CERT_HAS_EXPIRED"), BASE, 120)).toContain("has expired");
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(unreachable(timeout, BASE, 120)).toBe("The AI server didn't answer within 2 minutes.");
  });

  it("never shows a password from the address", () => {
    const m = unreachable(failed("ECONNRESET"), "https://me:hunter2@ai.example.test/v1", 120);
    expect(m).toBe("Couldn't reach the AI server at ai.example.test.");
  });
});
