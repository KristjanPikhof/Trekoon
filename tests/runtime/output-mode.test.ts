import { decode } from "@toon-format/toon";
import { describe, expect, test } from "bun:test";

import { okResult, renderResult, toToonEnvelope } from "../../src/io/output";
import { parseInvocation, renderShellResult } from "../../src/runtime/cli-shell";

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

  test("parses explicit compatibility mode", (): void => {
    const parsed = parseInvocation(["sync", "status", "--json", "--compat", "legacy-sync-command-ids"], {
      stdoutIsTTY: false,
    });

    expect(parsed.mode).toBe("json");
    expect(parsed.compatibilityMode).toBe("legacy-sync-command-ids");
  });
});

describe("output rendering", (): void => {
  test("envelope exposes top-level contract metadata", (): void => {
    const envelope = toToonEnvelope(
      okResult({
        command: "task.list",
        human: "ok",
        data: { tasks: [] },
      }),
    );

    expect(envelope.metadata.contractVersion).toBe("1.0.0");
    expect(envelope.metadata.requestId).toMatch(/^req-[0-9a-f]{8}$/);
  });

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

  test("renders legacy sync command IDs in compatibility mode", (): void => {
    const result = okResult({
      command: "sync.status",
      human: "sync human",
      data: { branch: "main" },
    });

    const jsonOutput = renderResult(result, "json", { compatibilityMode: "legacy-sync-command-ids" });
    const envelope = JSON.parse(jsonOutput) as {
      command: string;
      metadata: {
        compatibility: {
          mode: string;
          canonicalCommand: string;
          compatibilityCommand: string;
          removalAfter: string;
        };
      };
    };

    expect(envelope.command).toBe("sync_status");
    expect(envelope.metadata.compatibility.mode).toBe("legacy-sync-command-ids");
    expect(envelope.metadata.compatibility.canonicalCommand).toBe("sync.status");
    expect(envelope.metadata.compatibility.compatibilityCommand).toBe("sync_status");
    expect(envelope.metadata.compatibility.removalAfter).toBe("2026-09-30");
  });

  test("does not add compatibility metadata to rendered help envelopes", (): void => {
    const result = okResult({
      command: "help",
      human: "help text",
      data: { topic: "sync" },
    });

    const jsonOutput = renderShellResult(result, "json", "legacy-sync-command-ids");
    const envelope = JSON.parse(jsonOutput) as {
      command: string;
      metadata: {
        compatibility?: unknown;
      };
    };

    expect(envelope.command).toBe("help");
    expect(envelope.metadata.compatibility).toBeUndefined();
  });

  test("does not add compatibility metadata to rendered version envelopes", (): void => {
    const result = okResult({
      command: "version",
      human: "0.2.0",
      data: { version: "0.2.0" },
    });

    const jsonOutput = renderShellResult(result, "json", "legacy-sync-command-ids");
    const envelope = JSON.parse(jsonOutput) as {
      command: string;
      metadata: {
        compatibility?: unknown;
      };
    };

    expect(envelope.command).toBe("version");
    expect(envelope.metadata.compatibility).toBeUndefined();
  });
});
