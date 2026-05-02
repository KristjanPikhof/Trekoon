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
    expect(redactSensitive('"token":"abc123"')).toBe('"token":"REDACTED"');
  });

  test('redacts JSON "password":"value"', (): void => {
    expect(redactSensitive('"password":"hunter2"')).toBe('"password":"REDACTED"');
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

  // --- expanded key coverage ---
  test("redacts api_key=value", (): void => {
    expect(redactSensitive("api_key=abc123")).toBe("api_key=REDACTED");
  });

  test("redacts apikey=value", (): void => {
    expect(redactSensitive("apikey=abc123")).toBe("apikey=REDACTED");
  });

  test("redacts api-key=value", (): void => {
    expect(redactSensitive("api-key=abc123")).toBe("api-key=REDACTED");
  });

  test("redacts client_secret=value", (): void => {
    expect(redactSensitive("client_secret=mysecret")).toBe("client_secret=REDACTED");
  });

  test("redacts private_key=value", (): void => {
    expect(redactSensitive("private_key=pem-contents")).toBe("private_key=REDACTED");
  });

  test("redacts cookie=value", (): void => {
    expect(redactSensitive("cookie=session=abc")).toBe("cookie=REDACTED");
  });

  test("redacts session_id=value", (): void => {
    expect(redactSensitive("session_id=sess_xyz")).toBe("session_id=REDACTED");
  });

  // --- single-quoted values ---
  test("redacts single-quoted token='value'", (): void => {
    expect(redactSensitive("token='abc123'")).toBe("token='REDACTED'");
  });

  test("redacts single-quoted JSON 'password':'hunter2'", (): void => {
    expect(redactSensitive("'password':'hunter2'")).toBe("'password':'REDACTED'");
  });

  // --- angle-bracket / tag-style values ---
  test("redacts tag-style <token>value</token>", (): void => {
    expect(redactSensitive("<token>abc123</token>")).toBe("<token>REDACTED</token>");
  });

  test("redacts tag-style <password>hunter2</password>", (): void => {
    expect(redactSensitive("<password>hunter2</password>")).toBe(
      "<password>REDACTED</password>",
    );
  });

  // --- standalone Bearer / Basic tokens ---
  test("redacts standalone Bearer token", (): void => {
    expect(redactSensitive("got Bearer eyJhbGciOiJIUzI1NiJ9 from header")).toBe(
      "got Bearer REDACTED from header",
    );
  });

  test("redacts standalone Basic token", (): void => {
    expect(redactSensitive("auth: Basic dXNlcjpwYXNz here")).toBe("auth: Basic REDACTED here");
  });

  // --- JWT-shape heuristic (three eyJ segments + signature) ---
  test("redacts bare JWT in message", (): void => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `decode failed for ${jwt} in handler`;
    const result = redactSensitive(input);
    expect(result).toBe("decode failed for REDACTED in handler");
  });

  test("redacts JWT with hyphen and underscore base64url chars", (): void => {
    const jwt = "eyJhbGc-A_B.eyJzdWI-X_Y.sig-_value";
    expect(redactSensitive(jwt)).toBe("REDACTED");
  });

  test("does not match non-JWT three-dot strings", (): void => {
    expect(redactSensitive("version=1.2.3.4")).toBe("version=1.2.3.4");
  });

  test("redacts multiple JWTs in one message", (): void => {
    const jwt1 = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sigA";
    const jwt2 = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJiIn0.sigB";
    const result = redactSensitive(`${jwt1} and ${jwt2}`);
    expect(result).toBe("REDACTED and REDACTED");
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
