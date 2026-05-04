import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  BOARD_ASSET_ROOT_ENV_VAR,
  resolveBoardAssetRoot,
} from "../../src/board/asset-root";
import { BoardAssetError } from "../../src/board/types";

const tempDirs: string[] = [];
const originalEnvOverride = process.env[BOARD_ASSET_ROOT_ENV_VAR];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-asset-"));
  tempDirs.push(workspace);
  return workspace;
}

function createBundledAssets(rootPath: string): void {
  writeFileSync(join(rootPath, "index.html"), "<html><body>board</body></html>\n", "utf8");
}

function clearEnvOverride(): void {
  delete process.env[BOARD_ASSET_ROOT_ENV_VAR];
}

afterEach((): void => {
  if (originalEnvOverride === undefined) {
    delete process.env[BOARD_ASSET_ROOT_ENV_VAR];
  } else {
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = originalEnvOverride;
  }
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("resolveBoardAssetRoot", (): void => {
  test("uses an explicit override and locates index.html", (): void => {
    const assetRoot: string = createWorkspace();
    createBundledAssets(assetRoot);

    const resolved = resolveBoardAssetRoot({ assetRootOverride: assetRoot });

    expect(resolved.assetRoot).toBe(assetRoot);
    expect(resolved.entryFile).toBe(join(assetRoot, "index.html"));
    expect(resolved.source).toBe("override");
  });

  test("falls back to TREKOON_BOARD_ASSET_ROOT when no override is given", (): void => {
    const assetRoot: string = createWorkspace();
    createBundledAssets(assetRoot);
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = assetRoot;

    const resolved = resolveBoardAssetRoot();

    expect(resolved.assetRoot).toBe(assetRoot);
    expect(resolved.source).toBe("environment");
  });

  test("ignores empty environment override and uses the package source", (): void => {
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = "";

    const resolved = resolveBoardAssetRoot();

    expect(resolved.source).toBe("package");
    expect(existsSync(resolved.entryFile)).toBeTrue();
  });

  test("ignores whitespace-only environment override and uses the package source", (): void => {
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = "   ";

    const resolved = resolveBoardAssetRoot();

    expect(resolved.source).toBe("package");
    expect(existsSync(resolved.entryFile)).toBeTrue();
  });

  test("trims whitespace around environment override before resolving", (): void => {
    const assetRoot: string = createWorkspace();
    createBundledAssets(assetRoot);
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = `  ${assetRoot}  `;

    const resolved = resolveBoardAssetRoot();

    expect(resolved.assetRoot).toBe(assetRoot);
    expect(resolved.source).toBe("environment");
  });

  test("fails deterministically when the asset root directory is missing", (): void => {
    clearEnvOverride();
    const missingRoot: string = join(createWorkspace(), "missing");

    expect(() => resolveBoardAssetRoot({ assetRootOverride: missingRoot })).toThrow(
      expect.objectContaining({ code: "missing_asset" }),
    );
  });

  test("fails deterministically when index.html is missing inside the asset root", (): void => {
    clearEnvOverride();
    const assetRoot: string = createWorkspace();
    writeFileSync(join(assetRoot, "static.js"), "console.log('broken');\n", "utf8");

    expect(() => resolveBoardAssetRoot({ assetRootOverride: assetRoot })).toThrow(
      expect.objectContaining({
        code: "missing_asset",
        details: expect.objectContaining({ missingFile: "index.html" }),
      }),
    );
  });

  test("error thrown is a BoardAssetError instance", (): void => {
    clearEnvOverride();
    const missingRoot: string = join(createWorkspace(), "missing");

    expect(() => resolveBoardAssetRoot({ assetRootOverride: missingRoot })).toThrow(BoardAssetError);
  });
});
