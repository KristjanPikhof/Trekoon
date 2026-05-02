import { describe, expect, test } from "bun:test";

import { redactSensitive } from "../../src/commands/error-utils";
import { safeErrorMessage } from "../../src/commands/error-utils";

describe("redactSensitive", (): void => {
  // --- key=value ---
  test("redacts token=value", (): void => {
    expect(redactSensitive("token=abc123")).toBe("token=REDACTED");
  });

  test("redacts secret=value", (): void => {
    expect(redactSensitive("secret=mysecret")).toBe("secret=REDACTED");
  });

  test("redacts password=value", (): void => {
    expect(redactSensitive("password=hunter2")).toBe("password=REDACTED");
  });

  test("redacts bearer=value", (): void => {
    expect(redactSensitive("bearer=tok_xyz")).toBe("bearer=REDACTED");
  });

  test("redacts authorization=value", (): void => {
    expect(redactSensitive("authorization=abc")).toBe("authorization=REDACTED");
  });

  // --- key: value ---
  test("redacts token: value", (): void => {
    expect(redactSensitive("token: abc123")).toBe("token: REDACTED");
  });

  test("redacts password: hunter2", (): void => {
    expect(redactSensitive("password: hunter2")).toBe("password: REDACTED");
  });

  // --- key="value" ---
  test('redacts token="value"', (): void => {
    expect(redactSensitive('token="abc123"')).toBe('token="REDACTED"');
  });

  test('redacts password="hunter2"', (): void => {
    expect(redactSensitive('password="hunter2"')).toBe('password="REDACTED"');
  });

  // --- Authorization: Bearer xyz ---
  test("redacts Authorization: Bearer xyz", (): void => {
    expect(redactSensitive("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(
      "Authorization: Bearer REDACTED",
    );
  });

  // --- JSON-style "key":"value" ---
  test('redacts JSON "token":"value"', (): void => {
    expect(redactSensitive('"token":"abc123"')).toBe('"token": REDACTED"');
  });

  test('redacts JSON "password":"value"', (): void => {
    expect(redactSensitive('"password":"hunter2"')).toBe('"password": REDACTED"');
  });

  // --- mixed case ---
  test("redacts TOKEN=value (uppercase)", (): void => {
    expect(redactSensitive("TOKEN=abc123")).toBe("TOKEN=REDACTED");
  });

  test("redacts Token=value (mixed case)", (): void => {
    expect(redactSensitive("Token=abc123")).toBe("Token=REDACTED");
  });

  test("redacts Authorization: Bearer with different casing", (): void => {
    expect(redactSensitive("AUTHORIZATION: BEARER secret_value")).toBe(
      "AUTHORIZATION: BEARER REDACTED",
    );
  });

  // --- multiple secrets in one message ---
  test("redacts multiple secrets in one message", (): void => {
    const input = "token=abc secret=xyz password=hunter2";
    const result = redactSensitive(input);
    expect(result).toBe("token=REDACTED secret=REDACTED password=REDACTED");
  });

  test("redacts secrets embedded in longer message", (): void => {
    const input = "Database error: connect failed, token=abc123, retrying";
    const result = redactSensitive(input);
    expect(result).toBe("Database error: connect failed, token=REDACTED, retrying");
  });

  // --- no-match passthrough ---
  test("passes through non-sensitive text unchanged", (): void => {
    expect(redactSensitive("database connection refused")).toBe("database connection refused");
  });

  test("passes through empty string", (): void => {
    expect(redactSensitive("")).toBe("");
  });

  test("passes through message with unrelated key=value", (): void => {
    expect(redactSensitive("code=ECONNREFUSED host=localhost")).toBe(
      "code=ECONNREFUSED host=localhost",
    );
  });
});

describe("safeErrorMessage redaction", (): void => {
  test("redacts token= from Error message", (): void => {
    const err = new Error("failed: token=abc123");
    expect(safeErrorMessage(err, "fallback")).toBe("failed: token=REDACTED");
  });

  test("redacts password from string error", (): void => {
    expect(safeErrorMessage("password: hunter2", "fallback")).toBe("password: REDACTED");
  });

  test("uses fallback when error has no message", (): void => {
    expect(safeErrorMessage(null, "fallback message")).toBe("fallback message");
  });

  test("preserves non-sensitive error text", (): void => {
    const err = new Error("connection refused");
    expect(safeErrorMessage(err, "fallback")).toBe("connection refused");
  });

  test("redacts Authorization: Bearer inside error", (): void => {
    const err = new Error("request failed: Authorization: Bearer secrettoken123");
    expect(safeErrorMessage(err, "fallback")).toBe(
      "request failed: Authorization: Bearer REDACTED",
    );
  });
});
