import { decode } from "@toon-format/toon";
import { describe, expect, test } from "bun:test";

import { okResult, renderResult, toToonEnvelope } from "../../src/io/output";
import { parseInvocation } from "../../src/runtime/cli-shell";

describe("output mode parsing", (): void => {
  test("TTY default => human", (): void => {
    const parsed = parseInvocation(["quickstart"], { stdoutIsTTY: true });
    expect(parsed.mode).toBe("human");
  });

  test("non-TTY default => json", (): void => {
    const parsed = parseInvocation(["quickstart"], { stdoutIsTTY: false });
    expect(parsed.mode).toBe("json");
  });

  test("explicit --toon wins", (): void => {
    const parsed = parseInvocation(["quickstart", "--toon"], { stdoutIsTTY: false });
    expect(parsed.mode).toBe("toon");
  });

  test("explicit --json wins", (): void => {
    const parsed = parseInvocation(["quickstart", "--json"], { stdoutIsTTY: true });
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
