import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasFlag, parseArgs, readMissingOptionValue, readOption } from "./arg-parser";

import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";

const SKILLS_USAGE = [
  "Usage:",
  "  trekoon skills install [--link --editor opencode|claude|pi] [--to <path>] [--allow-outside-repo]",
  "  trekoon skills install -g|--global [--editor opencode|claude|pi]",
  "  trekoon skills update",
].join("\n");
const EDITOR_NAMES = ["opencode", "claude", "pi"] as const;
const ALLOW_OUTSIDE_REPO_FLAG = "allow-outside-repo";

type EditorName = (typeof EDITOR_NAMES)[number];
interface InstallOutcome {
  readonly sourcePath: string;
  readonly installedPath: string;
  readonly installedDir: string;
  readonly linkPath: string | null;
  readonly linkTarget: string | null;
  readonly outsideRepoLink: boolean;
}

interface LinkTargetValidation {
  readonly linkRoot: string;
  readonly outsideRepoLink: boolean;
}

type UpdateLinkAction = "created" | "refreshed" | "skipped_conflict" | "skipped_no_editor_dir";

interface UpdateLinkEntry {
  readonly editor: EditorName;
  readonly linkPath: string;
  readonly expectedTarget: string;
  readonly action: UpdateLinkAction;
  readonly conflictCode: "non_link" | "wrong_target" | null;
  readonly existingTarget: string | null;
}

interface UpdateOutcome {
  readonly sourcePath: string;
  readonly installedPath: string;
  readonly installedDir: string;
  readonly links: readonly UpdateLinkEntry[];
}

function invalidArgs(message: string): CliResult {
  return failResult({
    command: "skills",
    human: `${message}\n${SKILLS_USAGE}`,
    data: { message },
    error: {
      code: "invalid_args",
      message,
    },
  });
}

function invalidInput(command: string, message: string, data: Record<string, unknown>): CliResult {
  return failResult({
    command,
    human: message,
    data: {
      code: "invalid_input",
      ...data,
    },
    error: {
      code: "invalid_input",
      message,
    },
  });
}

function resolveBundledSkillFilePath(): string {
  return fileURLToPath(new URL("../../.agents/skills/trekoon/SKILL.md", import.meta.url));
}

function resolveBundledSkillDirPath(): string {
  return fileURLToPath(new URL("../../.agents/skills/trekoon", import.meta.url));
}

function toAbsolutePath(cwd: string, pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return pathValue;
  }

  return resolve(cwd, pathValue);
}

function resolveLinkRoot(cwd: string, editor: EditorName, toOverride: string | undefined): string {
  if (toOverride !== undefined) {
    return toAbsolutePath(cwd, toOverride);
  }

  if (editor === "opencode") {
    return join(cwd, ".opencode", "skills");
  }

  if (editor === "claude") {
    return join(cwd, ".claude", "skills");
  }

  return join(cwd, ".pi", "skills");
}

function isPathInsideRoot(pathValue: string, rootPath: string): boolean {
  const normalizedPath: string = resolve(pathValue);
  const normalizedRoot: string = resolve(rootPath);
  const relativePath: string = relative(normalizedRoot, normalizedPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function realpathNearestExistingAncestor(pathValue: string): string {
  let cursor: string = resolve(pathValue);

  while (!existsSync(cursor)) {
    const parent: string = dirname(cursor);
    if (parent === cursor) {
      break;
    }

    cursor = parent;
  }

  return realpathSync(cursor);
}

function validateLinkRoot(
  cwd: string,
  editor: EditorName,
  toOverride: string | undefined,
  allowOutsideRepo: boolean,
): CliResult | LinkTargetValidation {
  const linkRoot: string = resolveLinkRoot(cwd, editor, toOverride);
  const repoRoot: string = realpathSync(cwd);
  const effectiveTargetRoot: string = realpathNearestExistingAncestor(linkRoot);
  const insideRepo: boolean = isPathInsideRoot(effectiveTargetRoot, repoRoot);

  if (insideRepo) {
    return {
      linkRoot,
      outsideRepoLink: false,
    };
  }

  if (!allowOutsideRepo) {
    return failResult({
      command: "skills.install",
      human: [
        "Refusing to link skills outside repository root by default.",
        `Requested link root: ${linkRoot}`,
        `Resolved existing target ancestor: ${effectiveTargetRoot}`,
        `Repository root: ${repoRoot}`,
        `If intentional, re-run with --${ALLOW_OUTSIDE_REPO_FLAG} to override.`,
      ].join("\n"),
      data: {
        code: "outside_repo_target",
        linkRoot,
        effectiveTargetRoot,
        repoRoot,
        overrideFlag: `--${ALLOW_OUTSIDE_REPO_FLAG}`,
      },
      error: {
        code: "outside_repo_target",
        message: "Link target is outside repository root",
      },
    });
  }

  return {
    linkRoot,
    outsideRepoLink: true,
  };
}

function revalidateLinkParentBoundary(
  repoRoot: string,
  linkPath: string,
  allowOutsideRepo: boolean,
): CliResult | null {
  if (allowOutsideRepo) {
    return null;
  }

  const linkParentRealpath: string = realpathSync(dirname(linkPath));
  const insideRepo: boolean = isPathInsideRoot(linkParentRealpath, repoRoot);
  if (insideRepo) {
    return null;
  }

  return failResult({
    command: "skills.install",
    human: [
      "Refusing to link skills outside repository root by default.",
      `Requested link root: ${dirname(linkPath)}`,
      `Resolved existing target ancestor: ${linkParentRealpath}`,
      `Repository root: ${repoRoot}`,
      `If intentional, re-run with --${ALLOW_OUTSIDE_REPO_FLAG} to override.`,
    ].join("\n"),
    data: {
      code: "outside_repo_target",
      linkRoot: dirname(linkPath),
      effectiveTargetRoot: linkParentRealpath,
      repoRoot,
      overrideFlag: `--${ALLOW_OUTSIDE_REPO_FLAG}`,
    },
    error: {
      code: "outside_repo_target",
      message: "Link target is outside repository root",
    },
  });
}

function resolveDefaultLinkPath(cwd: string, editor: EditorName): string {
  return join(resolveLinkRoot(cwd, editor, undefined), "trekoon");
}

function toRelativeSymlinkTarget(linkPath: string, targetPath: string): string {
  const relativeTarget: string = relative(dirname(linkPath), resolve(targetPath));
  return relativeTarget === "" ? "." : relativeTarget;
}

function resolveEditorConfigDir(cwd: string, editor: EditorName): string {
  if (editor === "opencode") {
    return join(cwd, ".opencode");
  }

  if (editor === "claude") {
    return join(cwd, ".claude");
  }

  return join(cwd, ".pi");
}

function resolveGlobalEditorSkillsDir(editor: EditorName): string {
  const home: string = homedir();
  if (editor === "opencode") {
    return join(home, ".config", "opencode", "skills");
  }

  if (editor === "claude") {
    return join(home, ".claude", "skills");
  }

  return join(home, ".pi", "skills");
}

function installCanonicalSkill(cwd: string): CliResult | { sourcePath: string; installedPath: string; installedDir: string } {
  const sourcePath: string = resolveBundledSkillFilePath();
  const sourceDir: string = resolveBundledSkillDirPath();
  if (!existsSync(sourcePath)) {
    return failResult({
      command: "skills.install",
      human: `Bundled skill asset not found at ${sourcePath}`,
      data: {
        code: "missing_asset",
        sourcePath,
      },
      error: {
        code: "missing_asset",
        message: "Bundled skill asset not found",
      },
    });
  }

  const installedDir: string = join(cwd, ".agents", "skills", "trekoon");
  const installedPath: string = join(installedDir, "SKILL.md");
  const parentDir: string = dirname(installedDir);
  const resolvedSourceDir: string = resolve(sourceDir);

  try {
    mkdirSync(parentDir, { recursive: true });

    // Check what currently occupies the install path (lstat does not follow symlinks).
    let existingIsSymlink = false;
    let existingIsDir = false;
    let pathOccupied = false;

    try {
      const stat = lstatSync(installedDir);
      pathOccupied = true;
      existingIsSymlink = stat.isSymbolicLink();
      existingIsDir = stat.isDirectory();
    } catch {
      // Nothing at the path — proceed to create.
    }

    if (pathOccupied) {
      if (existingIsSymlink) {
        // Already a symlink — check whether it points to the correct target.
        const currentTarget: string = resolve(dirname(installedDir), readlinkSync(installedDir));
        if (currentTarget === resolvedSourceDir) {
          // Symlink is already correct; idempotent success.
          return { sourcePath, installedPath, installedDir };
        }
        // Stale symlink pointing elsewhere — remove and recreate.
        rmSync(installedDir, { force: true });
      } else if (existingIsDir) {
        // Legacy directory install (file-copy era) — migrate by removing.
        rmSync(installedDir, { recursive: true, force: true });
      } else {
        // Unexpected file — remove.
        rmSync(installedDir, { force: true });
      }
    }

    const symlinkTarget: string = toRelativeSymlinkTarget(installedDir, resolvedSourceDir);
    symlinkSync(symlinkTarget, installedDir, "dir");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown skills install failure";
    return failResult({
      command: "skills.install",
      human: `Failed to install skill: ${message}`,
      data: {
        code: "install_failed",
        message,
      },
      error: {
        code: "install_failed",
        message,
      },
    });
  }

  return {
    sourcePath,
    installedPath,
    installedDir,
  };
}

function replaceOrCreateSymlink(
  linkPath: string,
  targetPath: string,
  repoRoot: string,
  allowOutsideRepo: boolean,
): CliResult | null {
  const symlinkTarget: string = toRelativeSymlinkTarget(linkPath, targetPath);

  if (!existsSync(linkPath)) {
    mkdirSync(dirname(linkPath), { recursive: true });
    const boundaryFailure = revalidateLinkParentBoundary(repoRoot, linkPath, allowOutsideRepo);
    if (boundaryFailure) {
      return boundaryFailure;
    }
    symlinkSync(symlinkTarget, linkPath, "dir");
    return null;
  }

  const existing = lstatSync(linkPath);
  if (!existing.isSymbolicLink()) {
    // Replace stale directory or file with symlink to the canonical location.
    rmSync(linkPath, { recursive: true, force: true });
    const boundaryFailure = revalidateLinkParentBoundary(repoRoot, linkPath, allowOutsideRepo);
    if (boundaryFailure) {
      return boundaryFailure;
    }
    symlinkSync(symlinkTarget, linkPath, "dir");
    return null;
  }

  const existingRawTarget: string = readlinkSync(linkPath);
  const existingAbsoluteTarget: string = toAbsolutePath(dirname(linkPath), existingRawTarget);
  const expectedTarget: string = resolve(targetPath);
  if (existingAbsoluteTarget !== expectedTarget) {
    // Replace symlink pointing to a different target.
    rmSync(linkPath, { force: true });
    const boundaryFailure = revalidateLinkParentBoundary(repoRoot, linkPath, allowOutsideRepo);
    if (boundaryFailure) {
      return boundaryFailure;
    }
    symlinkSync(symlinkTarget, linkPath, "dir");
    return null;
  }

  rmSync(linkPath, { force: true });
  const boundaryFailure = revalidateLinkParentBoundary(repoRoot, linkPath, allowOutsideRepo);
  if (boundaryFailure) {
    return boundaryFailure;
  }
  symlinkSync(symlinkTarget, linkPath, "dir");
  return null;
}

interface GlobalEditorLinkEntry {
  readonly editor: EditorName;
  readonly linkPath: string;
  readonly linkTarget: string;
  readonly action: "created" | "refreshed" | "already_ok";
}

interface GlobalInstallOutcome {
  readonly sourcePath: string;
  readonly sourceDir: string;
  readonly globalAnchorPath: string;
  readonly globalAnchorAction: "created" | "refreshed" | "already_ok";
  readonly editorLinks: readonly GlobalEditorLinkEntry[];
}

function ensureSymlink(
  linkPath: string,
  targetPath: string,
): "created" | "refreshed" | "already_ok" {
  const resolvedTarget: string = resolve(targetPath);
  const symlinkTarget: string = toRelativeSymlinkTarget(linkPath, resolvedTarget);

  let existingIsSymlink = false;
  let pathOccupied = false;

  try {
    const stat = lstatSync(linkPath);
    pathOccupied = true;
    existingIsSymlink = stat.isSymbolicLink();
  } catch {
    // Nothing at the path.
  }

  if (pathOccupied) {
    if (existingIsSymlink) {
      const currentTarget: string = resolve(dirname(linkPath), readlinkSync(linkPath));
      if (currentTarget === resolvedTarget) {
        return "already_ok";
      }
      rmSync(linkPath, { force: true });
    } else {
      rmSync(linkPath, { recursive: true, force: true });
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(symlinkTarget, linkPath, "dir");
    return "refreshed";
  }

  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(symlinkTarget, linkPath, "dir");
  return "created";
}

function runGlobalInstall(editors: readonly EditorName[]): CliResult {
  const sourcePath: string = resolveBundledSkillFilePath();
  const sourceDir: string = resolveBundledSkillDirPath();
  if (!existsSync(sourcePath)) {
    return failResult({
      command: "skills.install",
      human: `Bundled skill asset not found at ${sourcePath}`,
      data: { code: "missing_asset", sourcePath },
      error: { code: "missing_asset", message: "Bundled skill asset not found" },
    });
  }

  try {
    // Step 1: Global anchor  ~/.agents/skills/trekoon → bundled package dir.
    const globalAnchorPath: string = join(homedir(), ".agents", "skills", "trekoon");
    const globalAnchorAction = ensureSymlink(globalAnchorPath, sourceDir);

    // Step 2: Editor links  <editor-global-skills>/trekoon → global anchor.
    const editorLinks: GlobalEditorLinkEntry[] = editors.map((editor) => {
      const editorSkillsDir: string = resolveGlobalEditorSkillsDir(editor);
      const linkPath: string = join(editorSkillsDir, "trekoon");
      const action = ensureSymlink(linkPath, globalAnchorPath);
      return { editor, linkPath, linkTarget: globalAnchorPath, action };
    });

    const outcome: GlobalInstallOutcome = {
      sourcePath,
      sourceDir,
      globalAnchorPath,
      globalAnchorAction,
      editorLinks,
    };

    const editorSummary: string = editorLinks
      .map((entry) => `- ${entry.editor}: ${entry.action} (${entry.linkPath})`)
      .join("\n");

    return okResult({
      command: "skills.install",
      human: [
        "Installed Trekoon skill globally.",
        `Global anchor: ${globalAnchorPath} (${globalAnchorAction})`,
        "Editor links:",
        editorSummary,
      ].join("\n"),
      data: {
        global: true,
        sourcePath: outcome.sourcePath,
        sourceDir: outcome.sourceDir,
        globalAnchorPath: outcome.globalAnchorPath,
        globalAnchorAction: outcome.globalAnchorAction,
        editorLinks: outcome.editorLinks,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown global install failure";
    return failResult({
      command: "skills.install",
      human: `Failed to install skill globally: ${message}`,
      data: { code: "install_failed", message },
      error: { code: "install_failed", message },
    });
  }
}

function runSkillsInstall(context: CliContext): CliResult {
  const parsed = parseArgs(context.args);
  const missingValue = readMissingOptionValue(parsed.missingOptionValues, "editor", "to");
  if (missingValue !== undefined) {
    return invalidInput("skills.install", `Option --${missingValue} requires a value.`, {
      option: missingValue,
    });
  }

  if (parsed.positional.length > 1) {
    return invalidArgs("Unexpected positional arguments for skills install.");
  }

  const wantsGlobal: boolean = hasFlag(parsed.flags, "global", "g");
  const wantsLink: boolean = hasFlag(parsed.flags, "link");
  const allowOutsideRepo: boolean = hasFlag(parsed.flags, ALLOW_OUTSIDE_REPO_FLAG);
  const rawEditor: string | undefined = readOption(parsed.options, "editor");
  const rawTo: string | undefined = readOption(parsed.options, "to");

  // Validate editor early (shared by both modes).
  if (rawEditor !== undefined && !EDITOR_NAMES.includes(rawEditor as EditorName)) {
    return invalidInput("skills.install", "Invalid --editor value. Use: opencode, claude, pi", {
      editor: rawEditor,
      allowedEditors: EDITOR_NAMES,
    });
  }

  // Global mode validation.
  if (wantsGlobal) {
    if (rawTo !== undefined) {
      return invalidInput("skills.install", "--to is not supported with --global.", { to: rawTo });
    }

    if (wantsLink) {
      return invalidInput("skills.install", "--link is not supported with --global.", {});
    }

    if (allowOutsideRepo) {
      return invalidInput("skills.install", `--${ALLOW_OUTSIDE_REPO_FLAG} is not supported with --global.`, {});
    }

    const editors: readonly EditorName[] = rawEditor
      ? [rawEditor as EditorName]
      : EDITOR_NAMES;
    return runGlobalInstall(editors);
  }

  // Local mode validation.
  if (allowOutsideRepo && !wantsLink) {
    return invalidInput("skills.install", `--${ALLOW_OUTSIDE_REPO_FLAG} requires --link.`, {
      allowOutsideRepo,
    });
  }

  if (!wantsLink && rawEditor !== undefined) {
    return invalidInput("skills.install", "--editor requires --link.", {
      editor: rawEditor,
    });
  }

  if (!wantsLink && rawTo !== undefined) {
    return invalidInput("skills.install", "--to requires --link.", {
      to: rawTo,
    });
  }

  if (wantsLink && rawEditor === undefined) {
    return invalidArgs("skills install --link requires --editor opencode|claude|pi.");
  }

  const editor: EditorName | undefined = rawEditor as EditorName | undefined;

  const installResult = installCanonicalSkill(context.cwd);
  if ("ok" in installResult) {
    return installResult;
  }

  let outcome: InstallOutcome;

  try {
    let linkPath: string | null = null;
    let linkTarget: string | null = null;

    if (wantsLink && editor !== undefined) {
      const validation = validateLinkRoot(context.cwd, editor, rawTo, allowOutsideRepo);
      if ("ok" in validation) {
        return validation;
      }

      const linkRoot: string = validation.linkRoot;
      linkPath = join(linkRoot, "trekoon");
      linkTarget = installResult.installedDir;
      const linkFailure = replaceOrCreateSymlink(
        linkPath,
        linkTarget,
        realpathSync(context.cwd),
        allowOutsideRepo,
      );
      if (linkFailure) {
        return linkFailure;
      }

      outcome = {
        sourcePath: installResult.sourcePath,
        installedPath: installResult.installedPath,
        installedDir: installResult.installedDir,
        linkPath,
        linkTarget,
        outsideRepoLink: validation.outsideRepoLink,
      };
    } else {
      outcome = {
        sourcePath: installResult.sourcePath,
        installedPath: installResult.installedPath,
        installedDir: installResult.installedDir,
        linkPath,
        linkTarget,
        outsideRepoLink: false,
      };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown skills install failure";
    return failResult({
      command: "skills.install",
      human: `Failed to install skill: ${message}`,
      data: {
        code: "install_failed",
        message,
      },
      error: {
        code: "install_failed",
        message,
      },
    });
  }

  return okResult({
    command: "skills.install",
    human: outcome.linkPath
      ? [
          ...(outcome.outsideRepoLink
            ? [
                `WARNING: Linking outside repository root because --${ALLOW_OUTSIDE_REPO_FLAG} was provided.`,
              ]
            : []),
          "Installed Trekoon skill and linked editor path.",
          `Source: ${outcome.sourcePath}`,
          `Installed file: ${outcome.installedPath}`,
          `Link path: ${outcome.linkPath}`,
          `Link target: ${outcome.linkTarget}`,
        ].join("\n")
      : [
          "Installed Trekoon skill.",
          `Source: ${outcome.sourcePath}`,
          `Installed file: ${outcome.installedPath}`,
        ].join("\n"),
    data: {
      sourcePath: outcome.sourcePath,
      installedPath: outcome.installedPath,
      installedDir: outcome.installedDir,
      linked: outcome.linkPath !== null,
      linkPath: outcome.linkPath,
      linkTarget: outcome.linkTarget,
      outsideRepoLink: outcome.outsideRepoLink,
      outsideRepoOverrideUsed: outcome.outsideRepoLink,
      outsideRepoOverrideFlag: outcome.outsideRepoLink ? `--${ALLOW_OUTSIDE_REPO_FLAG}` : null,
    },
  });
}

function updateEditorLink(
  cwd: string,
  editor: EditorName,
  installedDir: string,
): UpdateLinkEntry {
  const linkPath: string = resolveDefaultLinkPath(cwd, editor);
  const expectedTarget: string = resolve(installedDir);
  const symlinkTarget: string = toRelativeSymlinkTarget(linkPath, expectedTarget);
  const editorConfigDir: string = resolveEditorConfigDir(cwd, editor);

  if (!existsSync(editorConfigDir)) {
    return {
      editor,
      linkPath,
      expectedTarget,
      action: "skipped_no_editor_dir",
      conflictCode: null,
      existingTarget: null,
    };
  }

  if (!existsSync(linkPath)) {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(symlinkTarget, linkPath, "dir");
    return {
      editor,
      linkPath,
      expectedTarget,
      action: "created",
      conflictCode: null,
      existingTarget: null,
    };
  }

  const entry = lstatSync(linkPath);
  if (!entry.isSymbolicLink()) {
    // Replace stale directory or file with symlink to the canonical location.
    rmSync(linkPath, { recursive: true, force: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(symlinkTarget, linkPath, "dir");
    return {
      editor,
      linkPath,
      expectedTarget,
      action: "refreshed",
      conflictCode: null,
      existingTarget: null,
    };
  }

  const existingRawTarget: string = readlinkSync(linkPath);
  const existingTarget: string = toAbsolutePath(dirname(linkPath), existingRawTarget);

  if (existingTarget !== expectedTarget) {
    // Replace symlink pointing to a different target.
    rmSync(linkPath, { force: true });
    symlinkSync(symlinkTarget, linkPath, "dir");
    return {
      editor,
      linkPath,
      expectedTarget,
      action: "refreshed",
      conflictCode: null,
      existingTarget,
    };
  }

  rmSync(linkPath, { force: true });
  symlinkSync(symlinkTarget, linkPath, "dir");
  return {
    editor,
    linkPath,
    expectedTarget,
    action: "refreshed",
    conflictCode: null,
    existingTarget,
  };
}

function runSkillsUpdate(context: CliContext): CliResult {
  const parsed = parseArgs(context.args);
  if (parsed.positional.length > 1) {
    return invalidArgs("Unexpected positional arguments for skills update.");
  }

  if (parsed.flags.size > 0 || parsed.options.size > 0) {
    return invalidArgs("skills update takes no options.");
  }

  const installResult = installCanonicalSkill(context.cwd);
  if ("ok" in installResult) {
    return failResult({
      command: "skills.update",
      human: installResult.human,
      data: installResult.data,
      error:
        installResult.error ?? {
          code: "install_failed",
          message: "Failed to refresh canonical skill",
        },
    });
  }

  const links: readonly UpdateLinkEntry[] = EDITOR_NAMES.map((editor) =>
    updateEditorLink(context.cwd, editor, installResult.installedDir),
  );

  const outcome: UpdateOutcome = {
    sourcePath: installResult.sourcePath,
    installedPath: installResult.installedPath,
    installedDir: installResult.installedDir,
    links,
  };

  const linkSummary: string = outcome.links
    .map((entry) => {
      if (entry.action === "created") {
        return `- ${entry.editor}: created (${entry.linkPath} -> ${entry.expectedTarget})`;
      }

      if (entry.action === "refreshed") {
        return `- ${entry.editor}: refreshed (${entry.linkPath} -> ${entry.expectedTarget})`;
      }

      if (entry.action === "skipped_no_editor_dir") {
        return `- ${entry.editor}: skipped (no editor config dir)`;
      }

      if (entry.conflictCode === "non_link") {
        return `- ${entry.editor}: conflict (non-link path at ${entry.linkPath})`;
      }

      return `- ${entry.editor}: conflict (points to ${entry.existingTarget})`;
    })
    .join("\n");

  return okResult({
    command: "skills.update",
    human: [
      "Updated Trekoon skill in canonical path.",
      `Source: ${outcome.sourcePath}`,
      `Installed file: ${outcome.installedPath}`,
      "Editor links:",
      linkSummary,
    ].join("\n"),
    data: {
      sourcePath: outcome.sourcePath,
      installedPath: outcome.installedPath,
      installedDir: outcome.installedDir,
      links: outcome.links,
    },
  });
}

export async function runSkills(context: CliContext): Promise<CliResult> {
  const parsed = parseArgs(context.args);
  const subcommand: string | undefined = parsed.positional[0];
  if (!subcommand) {
    return invalidArgs("Missing skills subcommand.");
  }

  switch (subcommand) {
    case "install":
      return runSkillsInstall(context);
    case "update":
      return runSkillsUpdate(context);
    default:
      return invalidArgs(`Unknown skills subcommand '${subcommand}'.`);
  }
}
