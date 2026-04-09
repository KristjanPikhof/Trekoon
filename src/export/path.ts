import { isAbsolute, resolve } from "node:path";

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

export function resolveExportPath(options: {
  readonly customPath: string | undefined;
  readonly epicId: string;
  readonly epicTitle: string;
  readonly worktreeRoot: string;
  readonly cwd: string;
}): string {
  if (options.customPath) {
    if (isAbsolute(options.customPath)) {
      return options.customPath;
    }
    return resolve(options.cwd, options.customPath);
  }

  const slug = slugify(options.epicTitle) || options.epicId;
  const filename = `${slug}.md`;
  return resolve(options.worktreeRoot, PLANS_DIRNAME, filename);
}
