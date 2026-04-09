import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { atomicWrite, ExportWriteError } from "../../src/export/write";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "trekoon-write-"));
  tempDirs.push(dir);
  return dir;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("atomicWrite", () => {
  test("creates a new file when it does not exist", () => {
    const dir = createWorkspace();
    const path = join(dir, "output.md");

    const result = atomicWrite({ path, content: "hello", overwrite: false });

    expect(result.path).toBe(path);
    expect(result.overwritten).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  test("creates nested directories", () => {
    const dir = createWorkspace();
    const path = join(dir, "plans", "nested", "output.md");

    atomicWrite({ path, content: "nested content", overwrite: false });

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("nested content");
  });

  test("throws ExportWriteError when file exists and overwrite is false", () => {
    const dir = createWorkspace();
    const path = join(dir, "exists.md");
    writeFileSync(path, "original");

    try {
      atomicWrite({ path, content: "new", overwrite: false });
      expect(true).toBe(false); // should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ExportWriteError);
      expect((error as ExportWriteError).code).toBe("file_exists");
    }

    // Original content should be preserved
    expect(readFileSync(path, "utf8")).toBe("original");
  });

  test("overwrites when file exists and overwrite is true", () => {
    const dir = createWorkspace();
    const path = join(dir, "overwrite.md");
    writeFileSync(path, "old");

    const result = atomicWrite({ path, content: "new", overwrite: true });

    expect(result.overwritten).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  test("reports overwritten=false when overwrite=true but file is new", () => {
    const dir = createWorkspace();
    const path = join(dir, "fresh.md");

    const result = atomicWrite({ path, content: "fresh", overwrite: true });

    expect(result.overwritten).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("fresh");
  });

  test("does not leave temp files on success", () => {
    const dir = createWorkspace();
    const path = join(dir, "clean.md");

    atomicWrite({ path, content: "clean", overwrite: false });

    const files = require("node:fs").readdirSync(dir) as string[];
    const tmpFiles = files.filter((f: string) => f.includes(".export-") && f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});
