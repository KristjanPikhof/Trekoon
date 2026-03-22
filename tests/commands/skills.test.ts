import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runSkills } from "../../src/commands/skills";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-skills-"));
  tempDirs.push(workspace);
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("skills command", (): void => {
  test("install copies bundled SKILL.md and reruns idempotently", async (): Promise<void> => {
    const cwd = createWorkspace();

    const first = await runSkills({
      cwd,
      mode: "json",
      args: ["install"],
    });

    expect(first.ok).toBeTrue();
    const firstData = first.data as {
      sourcePath: string;
      installedPath: string;
      installedDir: string;
      linked: boolean;
      linkPath: string | null;
      linkTarget: string | null;
    };

    expect(firstData.linked).toBeFalse();
    expect(firstData.linkPath).toBeNull();
    expect(firstData.linkTarget).toBeNull();

    const sourceContents = readFileSync(firstData.sourcePath, "utf8");
    const installedContents = readFileSync(firstData.installedPath, "utf8");
    expect(installedContents).toBe(sourceContents);

    writeFileSync(firstData.installedPath, "custom overwrite check\n", "utf8");

    const second = await runSkills({
      cwd,
      mode: "json",
      args: ["install"],
    });

    expect(second.ok).toBeTrue();
    const secondData = second.data as { installedPath: string; installedDir: string; linked: boolean };
    expect(secondData.installedPath).toBe(firstData.installedPath);
    expect(secondData.installedDir).toBe(firstData.installedDir);
    expect(secondData.linked).toBeFalse();
    expect(readFileSync(secondData.installedPath, "utf8")).toBe(sourceContents);
  });

  test("install --link supports opencode, claude, and pi destinations", async (): Promise<void> => {
    const cwd = createWorkspace();

    const opencodeResult = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "opencode"],
    });

    expect(opencodeResult.ok).toBeTrue();
    const opencodeData = opencodeResult.data as {
      installedDir: string;
      linked: boolean;
      linkPath: string;
      linkTarget: string;
    };
    expect(opencodeData.linked).toBeTrue();
    expect(opencodeData.linkPath).toBe(join(cwd, ".opencode", "skills", "trekoon"));
    expect(opencodeData.linkTarget).toBe(opencodeData.installedDir);
    expect(lstatSync(opencodeData.linkPath).isSymbolicLink()).toBeTrue();
    expect(readlinkSync(opencodeData.linkPath)).toBe(relative(dirname(opencodeData.linkPath), opencodeData.installedDir));
    expect(resolve(dirname(opencodeData.linkPath), readlinkSync(opencodeData.linkPath))).toBe(opencodeData.installedDir);

    const claudeResult = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "claude"],
    });

    expect(claudeResult.ok).toBeTrue();
    const claudeData = claudeResult.data as {
      installedDir: string;
      linked: boolean;
      linkPath: string;
      linkTarget: string;
    };
    expect(claudeData.linked).toBeTrue();
    expect(claudeData.linkPath).toBe(join(cwd, ".claude", "skills", "trekoon"));
    expect(claudeData.linkTarget).toBe(claudeData.installedDir);
    expect(lstatSync(claudeData.linkPath).isSymbolicLink()).toBeTrue();
    expect(readlinkSync(claudeData.linkPath)).toBe(relative(dirname(claudeData.linkPath), claudeData.installedDir));
    expect(resolve(dirname(claudeData.linkPath), readlinkSync(claudeData.linkPath))).toBe(claudeData.installedDir);

    const piResult = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "pi"],
    });

    expect(piResult.ok).toBeTrue();
    const piData = piResult.data as {
      installedDir: string;
      linked: boolean;
      linkPath: string;
      linkTarget: string;
    };
    expect(piData.linked).toBeTrue();
    expect(piData.linkPath).toBe(join(cwd, ".pi", "skills", "trekoon"));
    expect(piData.linkTarget).toBe(piData.installedDir);
    expect(lstatSync(piData.linkPath).isSymbolicLink()).toBeTrue();
    expect(readlinkSync(piData.linkPath)).toBe(relative(dirname(piData.linkPath), piData.installedDir));
    expect(resolve(dirname(piData.linkPath), readlinkSync(piData.linkPath))).toBe(piData.installedDir);
  });

  test("install --link supports in-repo --to override and detects non-link conflicts", async (): Promise<void> => {
    const cwd = createWorkspace();
    const customRoot = join(cwd, "custom-editor", "skills");

    const linked = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "opencode", "--to", customRoot],
    });

    expect(linked.ok).toBeTrue();
    const linkedData = linked.data as {
      installedDir: string;
      linkPath: string;
      linkTarget: string;
      linked: boolean;
    };
    expect(linkedData.linked).toBeTrue();
    expect(linkedData.linkPath).toBe(join(customRoot, "trekoon"));
    expect(linkedData.linkTarget).toBe(linkedData.installedDir);
    expect(readlinkSync(linkedData.linkPath)).toBe(relative(dirname(linkedData.linkPath), linkedData.installedDir));

    // Non-link directory at link path should be replaced with symlink
    const replaceCwd = createWorkspace();
    const replacePath = join(replaceCwd, ".claude", "skills", "trekoon");
    mkdirSync(replacePath, { recursive: true });
    writeFileSync(join(replacePath, "SKILL.md"), "stale copy", "utf8");

    const replaced = await runSkills({
      cwd: replaceCwd,
      mode: "json",
      args: ["install", "--link", "--editor", "claude"],
    });

    expect(replaced.ok).toBeTrue();
    const replacedData = replaced.data as { linked: boolean; linkPath: string; installedDir: string };
    expect(replacedData.linked).toBeTrue();
    expect(replacedData.linkPath).toBe(replacePath);
    expect(lstatSync(replacePath).isSymbolicLink()).toBeTrue();
    expect(resolve(dirname(replacePath), readlinkSync(replacePath))).toBe(replacedData.installedDir);
  });

  test("install --link rejects outside-repo link targets by default", async (): Promise<void> => {
    const cwd = createWorkspace();
    const outsideRoot = mkdtempSync(join(tmpdir(), "trekoon-skills-outside-"));
    tempDirs.push(outsideRoot);

    const outsideAbsolute = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "opencode", "--to", outsideRoot],
    });

    expect(outsideAbsolute.ok).toBeFalse();
    expect(outsideAbsolute.error?.code).toBe("outside_repo_target");
    expect(outsideAbsolute.human).toContain("--allow-outside-repo");

    const outsideTraversal = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "opencode", "--to", "../outside-target"],
    });

    expect(outsideTraversal.ok).toBeFalse();
    expect(outsideTraversal.error?.code).toBe("outside_repo_target");
    const traversalData = outsideTraversal.data as {
      code: string;
      linkRoot: string;
      overrideFlag: string;
    };
    expect(traversalData.code).toBe("outside_repo_target");
    expect(traversalData.linkRoot).toBe(resolve(cwd, "../outside-target"));
    expect(traversalData.overrideFlag).toBe("--allow-outside-repo");
  });

  test("install --link enforces symlink boundary unless override is set", async (): Promise<void> => {
    const cwd = createWorkspace();
    const outsideRoot = mkdtempSync(join(tmpdir(), "trekoon-skills-outside-"));
    tempDirs.push(outsideRoot);

    const symlinkBridge = join(cwd, "bridge-outside");
    symlinkSync(outsideRoot, symlinkBridge, "dir");

    const blocked = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "claude", "--to", join(symlinkBridge, "skills")],
    });

    expect(blocked.ok).toBeFalse();
    expect(blocked.error?.code).toBe("outside_repo_target");
    const blockedData = blocked.data as {
      code: string;
      linkRoot: string;
      effectiveTargetRoot: string;
      repoRoot: string;
      overrideFlag: string;
    };
    expect(blockedData.code).toBe("outside_repo_target");
    expect(blockedData.linkRoot).toBe(join(symlinkBridge, "skills"));
    expect(blockedData.effectiveTargetRoot).toBe(realpathSync(outsideRoot));
    expect(blockedData.repoRoot).toBe(realpathSync(cwd));
    expect(blockedData.overrideFlag).toBe("--allow-outside-repo");

    const allowed = await runSkills({
      cwd,
      mode: "json",
      args: [
        "install",
        "--link",
        "--editor",
        "claude",
        "--to",
        join(symlinkBridge, "skills"),
        "--allow-outside-repo",
      ],
    });

    expect(allowed.ok).toBeTrue();
    const allowedData = allowed.data as {
      linked: boolean;
      linkPath: string;
      outsideRepoLink: boolean;
      outsideRepoOverrideUsed: boolean;
      outsideRepoOverrideFlag: string | null;
    };
    expect(allowed.human).toContain("WARNING: Linking outside repository root");
    expect(allowedData.linked).toBeTrue();
    expect(allowedData.linkPath).toBe(join(symlinkBridge, "skills", "trekoon"));
    expect(allowedData.outsideRepoLink).toBeTrue();
    expect(allowedData.outsideRepoOverrideUsed).toBeTrue();
    expect(allowedData.outsideRepoOverrideFlag).toBe("--allow-outside-repo");
  });

  test("skills update refreshes canonical skill and auto-links editors with config dirs", async (): Promise<void> => {
    const cwd = createWorkspace();

    const installForTargets = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "opencode"],
    });
    expect(installForTargets.ok).toBeTrue();
    const installData = installForTargets.data as { installedPath: string; installedDir: string };

    // Create .claude config dir so update auto-creates the link
    mkdirSync(join(cwd, ".claude"), { recursive: true });

    // Create .pi config dir with a non-link conflict at the skills path
    const piLinkPath = join(cwd, ".pi", "skills", "trekoon");
    mkdirSync(piLinkPath, { recursive: true });
    writeFileSync(join(piLinkPath, "SKILL.md"), "not a symlink", "utf8");

    writeFileSync(installData.installedPath, "stale content\n", "utf8");

    const updated = await runSkills({
      cwd,
      mode: "json",
      args: ["update"],
    });

    expect(updated.ok).toBeTrue();
    expect(updated.command).toBe("skills.update");
    const updatedData = updated.data as {
      sourcePath: string;
      installedPath: string;
      installedDir: string;
      links: Array<{
        editor: string;
        action: string;
        linkPath: string;
        expectedTarget: string;
        existingTarget: string | null;
        conflictCode: string | null;
      }>;
    };

    expect(updatedData.installedPath).toBe(installData.installedPath);
    expect(readFileSync(updatedData.installedPath, "utf8")).toBe(readFileSync(updatedData.sourcePath, "utf8"));

    const opencodeState = updatedData.links.find((entry) => entry.editor === "opencode");
    const claudeState = updatedData.links.find((entry) => entry.editor === "claude");
    const piState = updatedData.links.find((entry) => entry.editor === "pi");

    // opencode had a valid link, should be refreshed
    expect(opencodeState).toBeDefined();
    expect(opencodeState?.action).toBe("refreshed");
    expect(opencodeState?.existingTarget).toBe(updatedData.installedDir);
    expect(lstatSync(opencodeState!.linkPath).isSymbolicLink()).toBeTrue();
    expect(readlinkSync(opencodeState!.linkPath)).toBe(relative(dirname(opencodeState!.linkPath), updatedData.installedDir));

    // claude had config dir but no link, should be created
    expect(claudeState).toBeDefined();
    expect(claudeState?.action).toBe("created");
    expect(claudeState?.existingTarget).toBeNull();
    expect(lstatSync(claudeState!.linkPath).isSymbolicLink()).toBeTrue();
    expect(readlinkSync(claudeState!.linkPath)).toBe(relative(dirname(claudeState!.linkPath), updatedData.installedDir));
    expect(resolve(dirname(claudeState!.linkPath), readlinkSync(claudeState!.linkPath))).toBe(updatedData.installedDir);

    // pi had non-link directory, should be replaced with symlink
    expect(piState).toBeDefined();
    expect(piState?.action).toBe("refreshed");
    expect(piState?.conflictCode).toBeNull();
    expect(lstatSync(piState!.linkPath).isSymbolicLink()).toBeTrue();
    expect(resolve(dirname(piState!.linkPath), readlinkSync(piState!.linkPath))).toBe(updatedData.installedDir);

    const secondUpdate = await runSkills({
      cwd,
      mode: "json",
      args: ["update"],
    });

    expect(secondUpdate.ok).toBeTrue();
    const secondData = secondUpdate.data as { installedPath: string; sourcePath: string };
    expect(readFileSync(secondData.installedPath, "utf8")).toBe(readFileSync(secondData.sourcePath, "utf8"));
  });

  test("skills update skips editors with no config dir", async (): Promise<void> => {
    const cwd = createWorkspace();

    // Just install canonical, no editor dirs exist
    const installResult = await runSkills({
      cwd,
      mode: "json",
      args: ["install"],
    });
    expect(installResult.ok).toBeTrue();

    const updated = await runSkills({
      cwd,
      mode: "json",
      args: ["update"],
    });

    expect(updated.ok).toBeTrue();
    const updatedData = updated.data as {
      links: Array<{ editor: string; action: string }>;
    };

    // All editors should be skipped since no config dirs exist
    for (const link of updatedData.links) {
      expect(link.action).toBe("skipped_no_editor_dir");
    }
  });

  test("returns deterministic machine errors for invalid args", async (): Promise<void> => {
    const cwd = createWorkspace();

    const missingSubcommand = await runSkills({ cwd, mode: "json", args: [] });
    expect(missingSubcommand.ok).toBeFalse();
    expect(missingSubcommand.error?.code).toBe("invalid_args");

    const missingEditorForLink = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link"],
    });
    expect(missingEditorForLink.ok).toBeFalse();
    expect(missingEditorForLink.error?.code).toBe("invalid_args");

    const unknownEditor = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "unknown"],
    });
    expect(unknownEditor.ok).toBeFalse();
    expect(unknownEditor.error?.code).toBe("invalid_input");
    const unknownEditorData = unknownEditor.data as {
      code: string;
      editor: string;
      allowedEditors: string[];
    };
    expect(unknownEditorData.code).toBe("invalid_input");
    expect(unknownEditorData.editor).toBe("unknown");
    expect(unknownEditorData.allowedEditors).toEqual(["opencode", "claude", "pi"]);

    const editorWithoutLink = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--editor", "claude"],
    });
    expect(editorWithoutLink.ok).toBeFalse();
    expect(editorWithoutLink.error?.code).toBe("invalid_input");

    const missingEditorValue = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor"],
    });
    expect(missingEditorValue.ok).toBeFalse();
    expect(missingEditorValue.error?.code).toBe("invalid_input");
    const missingEditorData = missingEditorValue.data as { code: string; option: string };
    expect(missingEditorData.code).toBe("invalid_input");
    expect(missingEditorData.option).toBe("editor");

    const missingToValue = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--link", "--editor", "claude", "--to"],
    });
    expect(missingToValue.ok).toBeFalse();
    expect(missingToValue.error?.code).toBe("invalid_input");
    const missingToData = missingToValue.data as { code: string; option: string };
    expect(missingToData.code).toBe("invalid_input");
    expect(missingToData.option).toBe("to");

    const outsideOverrideWithoutLink = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--allow-outside-repo"],
    });
    expect(outsideOverrideWithoutLink.ok).toBeFalse();
    expect(outsideOverrideWithoutLink.error?.code).toBe("invalid_input");

    const updateWithUnexpectedOption = await runSkills({
      cwd,
      mode: "json",
      args: ["update", "--editor", "opencode"],
    });
    expect(updateWithUnexpectedOption.ok).toBeFalse();
    expect(updateWithUnexpectedOption.error?.code).toBe("invalid_args");
  });
});
