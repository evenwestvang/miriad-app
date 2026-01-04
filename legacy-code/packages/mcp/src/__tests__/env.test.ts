/**
 * Tests for environment variable resolution
 */

import {
  resolveEnvVarString,
  resolveEnvVars,
  hasEnvVarRefs,
  extractEnvVarNames,
} from "../env.js";

describe("resolveEnvVarString", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should resolve a single env var", () => {
    process.env.API_KEY = "secret123";
    expect(resolveEnvVarString("Bearer ${API_KEY}")).toBe("Bearer secret123");
  });

  it("should resolve multiple env vars", () => {
    process.env.USER = "admin";
    process.env.PASS = "hunter2";
    expect(resolveEnvVarString("${USER}:${PASS}")).toBe("admin:hunter2");
  });

  it("should leave unresolved vars unchanged", () => {
    expect(resolveEnvVarString("${MISSING_VAR}")).toBe("${MISSING_VAR}");
  });

  it("should handle mixed resolved and unresolved", () => {
    process.env.FOUND = "yes";
    expect(resolveEnvVarString("${FOUND}-${NOT_FOUND}")).toBe("yes-${NOT_FOUND}");
  });

  it("should handle strings without env vars", () => {
    expect(resolveEnvVarString("no vars here")).toBe("no vars here");
  });

  it("should handle empty string", () => {
    expect(resolveEnvVarString("")).toBe("");
  });

  it("should handle empty env var value", () => {
    process.env.EMPTY = "";
    expect(resolveEnvVarString("prefix${EMPTY}suffix")).toBe("prefixsuffix");
  });
});

describe("resolveEnvVars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.TOKEN = "abc123";
    process.env.HOST = "localhost";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should resolve all values in object", () => {
    const result = resolveEnvVars({
      Authorization: "Bearer ${TOKEN}",
      Host: "${HOST}:3000",
    });

    expect(result).toEqual({
      Authorization: "Bearer abc123",
      Host: "localhost:3000",
    });
  });

  it("should not modify values without env vars", () => {
    const result = resolveEnvVars({
      ContentType: "application/json",
      Authorization: "Bearer ${TOKEN}",
    });

    expect(result).toEqual({
      ContentType: "application/json",
      Authorization: "Bearer abc123",
    });
  });

  it("should handle empty object", () => {
    expect(resolveEnvVars({})).toEqual({});
  });
});

describe("hasEnvVarRefs", () => {
  it("should return true for string with env var", () => {
    expect(hasEnvVarRefs("${VAR}")).toBe(true);
    expect(hasEnvVarRefs("prefix${VAR}suffix")).toBe(true);
  });

  it("should return false for string without env var", () => {
    expect(hasEnvVarRefs("no vars")).toBe(false);
    expect(hasEnvVarRefs("$VAR")).toBe(false); // Missing braces
    expect(hasEnvVarRefs("${")).toBe(false); // Incomplete
  });
});

describe("extractEnvVarNames", () => {
  it("should extract single var name", () => {
    expect(extractEnvVarNames("${FOO}")).toEqual(["FOO"]);
  });

  it("should extract multiple var names", () => {
    expect(extractEnvVarNames("${FOO} and ${BAR}")).toEqual(["FOO", "BAR"]);
  });

  it("should return empty array for no vars", () => {
    expect(extractEnvVarNames("no vars")).toEqual([]);
  });

  it("should handle duplicate var names", () => {
    expect(extractEnvVarNames("${FOO}${FOO}")).toEqual(["FOO", "FOO"]);
  });
});
