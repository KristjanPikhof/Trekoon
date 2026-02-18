import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasFlag, parseArgs, readMissingOptionValue, readOption } from "./arg-parser";

import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";

const SKILLS_USAGE = "Usage: trekoon skills install [--link --editor opencode|claude] [--to <path>]";
const EDITOR_NAMES = ["opencode", "claude"] as const;

type EditorName = (typeof EDITOR_NAMES)[number];

interface InstallOutcome {
  readonly sourcePath: string;
  readonly installedPath: string;
  readonly installedDir: string;
  readonly linkPath: string | null;
  readonly linkTarget: string | null;
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

  return join(cwd, ".claude", "skills");
}

function replaceOrCreateSymlink(linkPath: string, targetPath: string): CliResult | null {
  if (!existsSync(linkPath)) {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(targetPath, linkPath, "dir");
    return null;
  }

  const existing = lstatSync(linkPath);
  if (!existing.isSymbolicLink()) {
    return failResult({
      command: "skills.install",
      human: `Cannot create symlink: path exists and is not a link (${linkPath}).`,
      data: {
        code: "path_conflict",
        linkPath,
        targetPath,
      },
      error: {
        code: "path_conflict",
        message: "Symlink destination exists as a non-link path",
      },
    });
  }

  const existingRawTarget: string = readlinkSync(linkPath);
  const existingAbsoluteTarget: string = toAbsolutePath(dirname(linkPath), existingRawTarget);
  const expectedTarget: string = resolve(targetPath);
  if (existingAbsoluteTarget !== expectedTarget) {
    return failResult({
      command: "skills.install",
      human: `Cannot replace existing link at ${linkPath}; it points to ${existingAbsoluteTarget}.`,
      data: {
        code: "path_conflict",
        linkPath,
        existingTarget: existingAbsoluteTarget,
        expectedTarget,
      },
      error: {
        code: "path_conflict",
        message: "Symlink destination points to a different target",
      },
    });
  }

  rmSync(linkPath, { force: true });
  symlinkSync(targetPath, linkPath, "dir");
  return null;
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

  const wantsLink: boolean = hasFlag(parsed.flags, "link");
  const rawEditor: string | undefined = readOption(parsed.options, "editor");
  const rawTo: string | undefined = readOption(parsed.options, "to");

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
    return invalidArgs("skills install --link requires --editor opencode|claude.");
  }

  if (rawEditor !== undefined && !EDITOR_NAMES.includes(rawEditor as EditorName)) {
    return invalidInput("skills.install", "Invalid --editor value. Use: opencode, claude", {
      editor: rawEditor,
      allowedEditors: EDITOR_NAMES,
    });
  }

  const editor: EditorName | undefined = rawEditor as EditorName | undefined;

  const sourcePath: string = resolveBundledSkillFilePath();
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

  const installPath = join(context.cwd, ".agents", "skills", "trekoon", "SKILL.md");
  const installDir = dirname(installPath);

  let outcome: InstallOutcome;

  try {
    mkdirSync(installDir, { recursive: true });
    copyFileSync(sourcePath, installPath);

    let linkPath: string | null = null;
    let linkTarget: string | null = null;

    if (wantsLink && editor !== undefined) {
      const linkRoot: string = resolveLinkRoot(context.cwd, editor, rawTo);
      linkPath = join(linkRoot, "trekoon");
      linkTarget = installDir;
      const linkFailure = replaceOrCreateSymlink(linkPath, linkTarget);
      if (linkFailure) {
        return linkFailure;
      }
    }

    outcome = {
      sourcePath,
      installedPath: installPath,
      installedDir: installDir,
      linkPath,
      linkTarget,
    };
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
    default:
      return invalidArgs(`Unknown skills subcommand '${subcommand}'.`);
  }
}
