import { decode } from "@toon-format/toon";
import { describe, expect, test } from "bun:test";

import { okResult, renderResult, toToonEnvelope } from "../../src/io/output";
import { parseInvocation } from "../../src/runtime/cli-shell";

describe("output mode parsing", (): void => {
  test("parses --json mode", (): void => {
    const parsed = parseInvocation(["quickstart", "--json"]);
    expect(parsed.mode).toBe("json");
  });

  test("parses --toon mode", (): void => {
    const parsed = parseInvocation(["--toon", "quickstart"]);
    expect(parsed.mode).toBe("toon");
  });

  test("uses last global output flag", (): void => {
    const parsed = parseInvocation(["--toon", "quickstart", "--json"]);
    expect(parsed.mode).toBe("json");
  });
});

describe("output rendering", (): void => {
  test("renders JSON envelope with --json mode", (): void => {
    const result = okResult({
      command: "quickstart",
      human: "Trekoon quickstart",
      data: { examples: ["trekoon quickstart --json"] },
    });

    const jsonOutput = renderResult(result, "json");
    expect(JSON.parse(jsonOutput)).toEqual(toToonEnvelope(result));
  });

  test("renders TOON output with --toon mode", (): void => {
    const result = okResult({
      command: "sync.status",
      human: "sync human",
      data: { branch: "main", conflicts: [] },
    });

    const toonOutput = renderResult(result, "toon");
    const jsonOutput = renderResult(result, "json");

    expect(toonOutput).not.toBe(jsonOutput);
    expect(decode(toonOutput) as unknown).toEqual(toToonEnvelope(result));
  });
});
