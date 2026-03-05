import { readFileSync } from "node:fs";

interface PackageManifest {
  readonly version?: string;
}

function readCliVersion(): string {
  const packageJsonPath = new URL("../../package.json", import.meta.url);
  const packageJsonContent: string = readFileSync(packageJsonPath, "utf8");
  const packageManifest: PackageManifest = JSON.parse(packageJsonContent) as PackageManifest;
  const version: string | undefined = packageManifest.version;

  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json is missing a valid version field.");
  }

  return version;
}

export const CLI_VERSION: string = readCliVersion();
