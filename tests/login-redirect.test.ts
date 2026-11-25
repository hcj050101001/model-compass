import { describe, expect, it } from "vitest";
import { getLoginReturnPath } from "@/lib/login-return-path";

// Package G (AC-G1): the login return path reuses the existing
// getLoginReturnPath validator. Valid in-site paths (including query
// strings and fragments) return to the original page after login;
// anything else falls back to the home page.
describe("getLoginReturnPath", () => {
  it("returns valid in-site paths unchanged", () => {
    expect(getLoginReturnPath("/")).toBe("/");
    expect(getLoginReturnPath("/compare")).toBe("/compare");
    expect(getLoginReturnPath("/settings")).toBe("/settings");
  });

  it("preserves query parameters and fragments on valid paths", () => {
    expect(getLoginReturnPath("/settings?tab=sync")).toBe("/settings?tab=sync");
    expect(getLoginReturnPath("/compare?a=1&b=2#frag")).toBe(
      "/compare?a=1&b=2#frag"
    );
    expect(getLoginReturnPath("/?x=1")).toBe("/?x=1");
  });

  it("falls back to home for missing or non-path values", () => {
    expect(getLoginReturnPath(null)).toBe("/");
    expect(getLoginReturnPath("")).toBe("/");
    expect(getLoginReturnPath("compare")).toBe("/");
    expect(getLoginReturnPath("javascript:alert(1)")).toBe("/");
  });

  it("rejects external domains and absolute URLs", () => {
    expect(getLoginReturnPath("https://evil.example/x")).toBe("/");
    expect(getLoginReturnPath("http://evil.example/compare")).toBe("/");
  });

  it("rejects protocol-relative and backslash paths", () => {
    expect(getLoginReturnPath("//evil.example/x")).toBe("/");
    expect(getLoginReturnPath("/\\evil.example")).toBe("/");
    expect(getLoginReturnPath("/%2fevil.example")).toBe("/");
    expect(getLoginReturnPath("/%2F%2Fevil.example")).toBe("/");
  });

  it("rejects login loops and API paths, including encoded forms", () => {
    expect(getLoginReturnPath("/login")).toBe("/");
    expect(getLoginReturnPath("/login?next=/compare")).toBe("/");
    expect(getLoginReturnPath("/login/")).toBe("/");
    expect(getLoginReturnPath("/login;foo")).toBe("/");
    expect(getLoginReturnPath("/%6cogin")).toBe("/");
    expect(getLoginReturnPath("/api")).toBe("/");
    expect(getLoginReturnPath("/api/models")).toBe("/");
  });

  it("falls back to home on malformed percent-encoding", () => {
    expect(getLoginReturnPath("/%E0%A4%A")).toBe("/");
    expect(getLoginReturnPath("/%")).toBe("/");
    expect(getLoginReturnPath("/foo%")).toBe("/");
  });
});
