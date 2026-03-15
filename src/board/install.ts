import {
  createHash,
} from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_VERSION } from "../runtime/version";
import {
  resolveStoragePaths,
  TREKOON_BOARD_ENTRY_FILENAME,
  TREKOON_BOARD_MANIFEST_FILENAME,
} from "../storage/path";
import {
  BOARD_ASSET_CONTRACT_VERSION,
  BOARD_BUNDLED_ASSET_DIRNAME,
  BoardInstallError,
  type BoardAssetManifest,
  type BoardInstallAction,
  type BoardInstallResult,
  type EnsureBoardInstalledOptions,
} from "./types";

function resolveBundledBoardAssetRoot(): string {
  return fileURLToPath(new URL(`./${BOARD_BUNDLED_ASSET_DIRNAME}`, import.meta.url));
}

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

interface ReadManifestResult {
  readonly manifest: BoardAssetManifest | null;
  readonly damaged: boolean;
}

function readManifest(manifestFile: string): ReadManifestResult {
  if (!existsSync(manifestFile)) {
    return {
      manifest: null,
      damaged: false,
    };
  }

  try {
    const rawManifest: string = readFileSync(manifestFile, "utf8");
    return {
      manifest: JSON.parse(rawManifest) as BoardAssetManifest,
      damaged: false,
    };
  } catch {
    return {
      manifest: null,
      damaged: true,
    };
  }
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

function installBoardFiles(sourceRoot: string, runtimeRoot: string, manifest: BoardAssetManifest): void {
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(dirname(runtimeRoot), { recursive: true });
  cpSync(sourceRoot, runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, TREKOON_BOARD_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function determineAction(
  runtimeRoot: string,
  entryFile: string,
  currentManifest: BoardAssetManifest | null,
  manifestDamaged: boolean,
  nextManifest: BoardAssetManifest,
): BoardInstallAction {
  if (manifestDamaged) {
    return "reinstalled";
  }

  if (!existsSync(runtimeRoot) || !existsSync(entryFile) || currentManifest === null) {
    return currentManifest === null && !existsSync(runtimeRoot) ? "installed" : "reinstalled";
  }

  if (
    currentManifest.contractVersion !== nextManifest.contractVersion ||
    currentManifest.assetVersion !== nextManifest.assetVersion ||
    currentManifest.entryFile !== nextManifest.entryFile ||
    JSON.stringify(currentManifest.files) !== JSON.stringify(nextManifest.files) ||
    currentManifest.assetDigest !== nextManifest.assetDigest
  ) {
    return "updated";
  }

  for (const relativeFile of nextManifest.files) {
    if (!existsSync(join(runtimeRoot, relativeFile))) {
      return "reinstalled";
    }
  }

  return "unchanged";
}

export function ensureBoardInstalled(options: EnsureBoardInstalledOptions = {}): BoardInstallResult {
  const paths = resolveStoragePaths(options.workingDirectory);
  const sourceRoot: string = resolve(options.bundledAssetRoot ?? resolveBundledBoardAssetRoot());
  const runtimeRoot: string = paths.boardDir;
  const entryFile: string = paths.boardEntryFile;
  const manifestFile: string = paths.boardManifestFile;

  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new BoardInstallError("missing_asset", `Bundled board asset directory not found at ${sourceRoot}`, {
      sourceRoot,
    });
  }

  const sourceFiles: string[] = listRelativeFiles(sourceRoot);
  if (!sourceFiles.includes(TREKOON_BOARD_ENTRY_FILENAME)) {
    throw new BoardInstallError("missing_asset", `Bundled board entry file not found at ${join(sourceRoot, TREKOON_BOARD_ENTRY_FILENAME)}`, {
      sourceRoot,
      missingFile: TREKOON_BOARD_ENTRY_FILENAME,
    });
  }

  const manifest: BoardAssetManifest = createManifest(sourceRoot, options.assetVersion ?? CLI_VERSION, sourceFiles);
  const currentManifestResult: ReadManifestResult = readManifest(manifestFile);
  const action: BoardInstallAction = determineAction(
    runtimeRoot,
    entryFile,
    currentManifestResult.manifest,
    currentManifestResult.damaged,
    manifest,
  );

  if (action !== "unchanged") {
    installBoardFiles(sourceRoot, runtimeRoot, manifest);
  }

  return {
    action,
    paths: {
      sourceRoot,
      runtimeRoot,
      entryFile,
      manifestFile,
    },
    manifest,
  };
}

export function updateBoardInstallation(options: EnsureBoardInstalledOptions = {}): BoardInstallResult {
  return ensureBoardInstalled(options);
}
