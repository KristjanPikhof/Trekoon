export const BOARD_ASSET_CONTRACT_VERSION = "1.0.0";
export const BOARD_BUNDLED_ASSET_DIRNAME = "assets";

export interface BoardAssetManifest {
  readonly contractVersion: string;
  readonly assetVersion: string;
  readonly entryFile: string;
  readonly files: readonly string[];
  readonly assetDigest: string;
}

export interface BoardAssetPaths {
  readonly sourceRoot: string;
  readonly runtimeRoot: string;
  readonly entryFile: string;
  readonly manifestFile: string;
}

export type BoardInstallAction = "installed" | "reinstalled" | "updated" | "unchanged";

export interface BoardInstallResult {
  readonly action: BoardInstallAction;
  readonly paths: BoardAssetPaths;
  readonly manifest: BoardAssetManifest;
}

export interface EnsureBoardInstalledOptions {
  readonly workingDirectory?: string;
  readonly assetVersion?: string;
  readonly bundledAssetRoot?: string;
}

export class BoardInstallError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BoardInstallError";
    this.code = code;
    this.details = details;
  }
}
