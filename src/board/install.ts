import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { CLI_VERSION } from "../runtime/version";
import {
  TREKOON_BOARD_ENTRY_FILENAME,
  TREKOON_BOARD_MANIFEST_FILENAME,
} from "../storage/path";
import { resolveBoardAssetRoot, type BoardAssetRoot } from "./asset-root";
import {
  BOARD_ASSET_CONTRACT_VERSION,
  type BoardAssetManifest,
  type BoardInstallResult,
  type EnsureBoardInstalledOptions,
} from "./types";

function listRelativeFiles(rootPath: string, currentPath: string = rootPath): string[] {
  const entries = readdirSync(currentPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath: string = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(rootPath, entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(relative(rootPath, entryPath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function createAssetDigest(sourceRoot: string, files: readonly string[]): string {
  const hash = createHash("sha256");

  for (const relativeFile of files) {
    hash.update(relativeFile);
    hash.update("\0");
    hash.update(readFileSync(join(sourceRoot, relativeFile)));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function createManifest(sourceRoot: string, assetVersion: string, files: readonly string[]): BoardAssetManifest {
  return {
    contractVersion: BOARD_ASSET_CONTRACT_VERSION,
    assetVersion,
    entryFile: TREKOON_BOARD_ENTRY_FILENAME,
    files,
    assetDigest: createAssetDigest(sourceRoot, files),
  };
}

// Compatibility wrapper. Resolves board assets in place (no copy to repo
// storage). Kept temporarily so commands/init.ts and commands/board.ts keep
// compiling while the CLI cleanup lane retires this surface in favor of
// resolveBoardAssetRoot.
export function ensureBoardInstalled(options: EnsureBoardInstalledOptions = {}): BoardInstallResult {
  const root: BoardAssetRoot = resolveBoardAssetRoot(
    options.bundledAssetRoot === undefined
      ? {}
      : { assetRootOverride: options.bundledAssetRoot },
  );

  const files: string[] = listRelativeFiles(root.assetRoot);
  const manifest: BoardAssetManifest = createManifest(
    root.assetRoot,
    options.assetVersion ?? CLI_VERSION,
    files,
  );

  return {
    action: "installed",
    paths: {
      sourceRoot: root.assetRoot,
      runtimeRoot: root.assetRoot,
      entryFile: root.entryFile,
      manifestFile: join(root.assetRoot, TREKOON_BOARD_MANIFEST_FILENAME),
    },
    manifest,
  };
}

export function updateBoardInstallation(options: EnsureBoardInstalledOptions = {}): BoardInstallResult {
  return ensureBoardInstalled(options);
}
