import { extname, isAbsolute, resolve } from "node:path";

const PLANS_DIRNAME = "plans";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function defaultFilename(epicTitle: string, epicId: string): string {
  const slug = slugify(epicTitle) || epicId;
  return `${slug}.md`;
}

function looksLikeFilePath(path: string): boolean {
  return extname(path) !== "";
}

export function resolveExportPath(options: {
  readonly customPath: string | undefined;
  readonly epicId: string;
  readonly epicTitle: string;
  readonly worktreeRoot: string;
  readonly cwd: string;
}): string {
  const filename = defaultFilename(options.epicTitle, options.epicId);

  if (!options.customPath) {
    return resolve(options.worktreeRoot, PLANS_DIRNAME, filename);
  }

  const resolved = isAbsolute(options.customPath)
    ? options.customPath
    : resolve(options.cwd, options.customPath);

  // If the path has a file extension, treat it as a file path.
  // Otherwise treat it as a directory and place the default-named file inside.
  if (looksLikeFilePath(resolved)) {
    return resolved;
  }

  return resolve(resolved, filename);
}
