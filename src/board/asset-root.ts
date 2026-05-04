import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BoardAssetError } from "./types";

export const BOARD_BUNDLED_ASSET_DIRNAME = "assets";
export const BOARD_ENTRY_FILENAME = "index.html";
export const BOARD_ASSET_ROOT_ENV_VAR = "TREKOON_BOARD_ASSET_ROOT";

export type BoardAssetRootSource = "override" | "environment" | "package";

export interface BoardAssetRoot {
  readonly assetRoot: string;
  readonly entryFile: string;
  readonly source: BoardAssetRootSource;
}

export interface ResolveBoardAssetRootOptions {
  readonly assetRootOverride?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function resolvePackageBoardAssetRoot(): string {
  return fileURLToPath(new URL(`./${BOARD_BUNDLED_ASSET_DIRNAME}`, import.meta.url));
}

interface SelectedAssetRoot {
  readonly rootPath: string;
  readonly source: BoardAssetRootSource;
}

function selectAssetRoot(options: ResolveBoardAssetRootOptions): SelectedAssetRoot {
  if (options.assetRootOverride !== undefined) {
    return { rootPath: resolve(options.assetRootOverride), source: "override" };
  }

  const env = options.env ?? process.env;
  const envOverride = env[BOARD_ASSET_ROOT_ENV_VAR];
  if (typeof envOverride === "string" && envOverride.length > 0) {
    return { rootPath: resolve(envOverride), source: "environment" };
  }

  return { rootPath: resolvePackageBoardAssetRoot(), source: "package" };
}

export function resolveBoardAssetRoot(options: ResolveBoardAssetRootOptions = {}): BoardAssetRoot {
  const { rootPath, source } = selectAssetRoot(options);

  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new BoardAssetError("missing_asset", `Board asset root not found at ${rootPath}`, {
      assetRoot: rootPath,
      source,
    });
  }

  const entryFile = resolve(rootPath, BOARD_ENTRY_FILENAME);
  if (!existsSync(entryFile)) {
    throw new BoardAssetError("missing_asset", `Board entry file not found at ${entryFile}`, {
      assetRoot: rootPath,
      entryFile,
      source,
      missingFile: BOARD_ENTRY_FILENAME,
    });
  }

  return {
    assetRoot: rootPath,
    entryFile,
    source,
  };
}
