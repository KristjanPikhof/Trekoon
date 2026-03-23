import {
  existsSync,
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
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runSkills } from "../../src/commands/skills";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-skills-"));
  tempDirs.push(workspace);
  return workspace;
}

/** Resolve the bundled skill dir the same way the production code does. */
function bundledSkillDir(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "../../.agents/skills/trekoon");
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
  test("install creates a symlink to bundled dir and reruns idempotently", async (): Promise<void> => {
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

    // Installed dir should be a symlink, not a plain directory.
    expect(lstatSync(firstData.installedDir).isSymbolicLink()).toBeTrue();
    const resolvedTarget = resolve(dirname(firstData.installedDir), readlinkSync(firstData.installedDir));
    expect(resolvedTarget).toBe(resolve(bundledSkillDir()));

    // Contents accessible through the symlink should match the source.
    const sourceContents = readFileSync(firstData.sourcePath, "utf8");
    const installedContents = readFileSync(firstData.installedPath, "utf8");
    expect(installedContents).toBe(sourceContents);

    // Idempotent rerun should succeed and resolve to the same target.
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
    expect(lstatSync(secondData.installedDir).isSymbolicLink()).toBeTrue();
  });

  test("install migrates legacy directory to symlink", async (): Promise<void> => {
    const cwd = createWorkspace();

    // Create a legacy directory install (file-copy era).
    const legacyDir = join(cwd, ".agents", "skills", "trekoon");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "SKILL.md"), "legacy copy content", "utf8");

    expect(lstatSync(legacyDir).isDirectory()).toBeTrue();
    expect(lstatSync(legacyDir).isSymbolicLink()).toBeFalse();

    const result = await runSkills({
      cwd,
      mode: "json",
      args: ["install"],
    });

    expect(result.ok).toBeTrue();

    // Should now be a symlink, not a plain directory.
    expect(lstatSync(legacyDir).isSymbolicLink()).toBeTrue();
    const resolvedTarget = resolve(dirname(legacyDir), readlinkSync(legacyDir));
    expect(resolvedTarget).toBe(resolve(bundledSkillDir()));
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

  test("install --global creates global anchor and editor symlinks", async (): Promise<void> => {
    const home = homedir();
    const globalAnchorPath = join(home, ".agents", "skills", "trekoon");
    const globalClaudePath = join(home, ".claude", "skills", "trekoon");
    const globalOpencodePath = join(home, ".config", "opencode", "skills", "trekoon");
    const globalPiPath = join(home, ".pi", "skills", "trekoon");

    // Save existing state to restore after test.
    const savedPaths: Array<{ path: string; existed: boolean; target?: string }> = [];
    for (const p of [globalAnchorPath, globalClaudePath, globalOpencodePath, globalPiPath]) {
      try {
        const stat = lstatSync(p);
        if (stat.isSymbolicLink()) {
          savedPaths.push({ path: p, existed: true, target: readlinkSync(p) });
        } else {
          savedPaths.push({ path: p, existed: true });
        }
      } catch {
        savedPaths.push({ path: p, existed: false });
      }
    }

    try {
      // Clean any existing state for a clean test.
      for (const p of [globalAnchorPath, globalClaudePath, globalOpencodePath, globalPiPath]) {
        rmSync(p, { recursive: true, force: true });
      }

      const result = await runSkills({
        cwd: createWorkspace(),
        mode: "json",
        args: ["install", "--global"],
      });

      expect(result.ok).toBeTrue();
      const data = result.data as {
        global: boolean;
        globalAnchorPath: string;
        globalAnchorAction: string;
        editorLinks: Array<{
          editor: string;
          linkPath: string;
          linkTarget: string;
          action: string;
        }>;
      };

      expect(data.global).toBeTrue();
      expect(data.globalAnchorPath).toBe(globalAnchorPath);
      expect(data.globalAnchorAction).toBe("created");

      // Anchor should be a symlink to bundled dir.
      expect(lstatSync(globalAnchorPath).isSymbolicLink()).toBeTrue();
      expect(resolve(dirname(globalAnchorPath), readlinkSync(globalAnchorPath))).toBe(resolve(bundledSkillDir()));

      // All three editors should be linked.
      expect(data.editorLinks).toHaveLength(3);
      for (const link of data.editorLinks) {
        expect(link.action).toBe("created");
        expect(lstatSync(link.linkPath).isSymbolicLink()).toBeTrue();
        expect(resolve(dirname(link.linkPath), readlinkSync(link.linkPath))).toBe(resolve(globalAnchorPath));
      }

      // Idempotent rerun should report already_ok.
      const second = await runSkills({
        cwd: createWorkspace(),
        mode: "json",
        args: ["install", "--global"],
      });

      expect(second.ok).toBeTrue();
      const secondData = second.data as {
        globalAnchorAction: string;
        editorLinks: Array<{ action: string }>;
      };
      expect(secondData.globalAnchorAction).toBe("already_ok");
      for (const link of secondData.editorLinks) {
        expect(link.action).toBe("already_ok");
      }
    } finally {
      // Restore original state.
      for (const saved of savedPaths) {
        rmSync(saved.path, { recursive: true, force: true });
        if (saved.existed && saved.target) {
          mkdirSync(dirname(saved.path), { recursive: true });
          symlinkSync(saved.target, saved.path, "dir");
        }
      }
    }
  });

  test("install --global with --editor limits to specified editor", async (): Promise<void> => {
    const home = homedir();
    const globalAnchorPath = join(home, ".agents", "skills", "trekoon");
    const globalClaudePath = join(home, ".claude", "skills", "trekoon");

    const savedPaths: Array<{ path: string; existed: boolean; target?: string }> = [];
    for (const p of [globalAnchorPath, globalClaudePath]) {
      try {
        const stat = lstatSync(p);
        if (stat.isSymbolicLink()) {
          savedPaths.push({ path: p, existed: true, target: readlinkSync(p) });
        } else {
          savedPaths.push({ path: p, existed: true });
        }
      } catch {
        savedPaths.push({ path: p, existed: false });
      }
    }

    try {
      for (const p of [globalAnchorPath, globalClaudePath]) {
        rmSync(p, { recursive: true, force: true });
      }

      const result = await runSkills({
        cwd: createWorkspace(),
        mode: "json",
        args: ["install", "--global", "--editor", "claude"],
      });

      expect(result.ok).toBeTrue();
      const data = result.data as {
        global: boolean;
        editorLinks: Array<{ editor: string; action: string }>;
      };

      expect(data.global).toBeTrue();
      expect(data.editorLinks).toHaveLength(1);
      expect(data.editorLinks[0]!.editor).toBe("claude");
      expect(data.editorLinks[0]!.action).toBe("created");
    } finally {
      for (const saved of savedPaths) {
        rmSync(saved.path, { recursive: true, force: true });
        if (saved.existed && saved.target) {
          mkdirSync(dirname(saved.path), { recursive: true });
          symlinkSync(saved.target, saved.path, "dir");
        }
      }
    }
  });

  test("skills update probes and repairs all anchors and editor links", async (): Promise<void> => {
    const cwd = createWorkspace();

    // First install locally so we have a local anchor.
    const installResult = await runSkills({
      cwd,
      mode: "json",
      args: ["install"],
    });
    expect(installResult.ok).toBeTrue();
    const installData = installResult.data as { installedDir: string };

    // Create .claude config dir so update creates a local editor link.
    mkdirSync(join(cwd, ".claude"), { recursive: true });

    // Create .pi config dir with a legacy directory (non-symlink).
    const piLinkPath = join(cwd, ".pi", "skills", "trekoon");
    mkdirSync(piLinkPath, { recursive: true });
    writeFileSync(join(piLinkPath, "SKILL.md"), "not a symlink", "utf8");

    const updated = await runSkills({
      cwd,
      mode: "json",
      args: ["update"],
    });

    expect(updated.ok).toBeTrue();
    expect(updated.command).toBe("skills.update");

    const updatedData = updated.data as {
      sourceDir: string;
      entries: Array<{
        scope: string;
        label: string;
        path: string;
        expectedTarget: string;
        status: string;
        action: string;
        currentTarget: string | null;
      }>;
    };

    // Local anchor should be ok (already a correct symlink from install).
    const localAnchor = updatedData.entries.find((e) => e.scope === "local" && e.label === "anchor");
    expect(localAnchor).toBeDefined();
    expect(localAnchor!.action).toBe("ok");
    expect(lstatSync(localAnchor!.path).isSymbolicLink()).toBeTrue();

    // Local claude editor link should be created (config dir exists, no prior link).
    const localClaude = updatedData.entries.find((e) => e.scope === "local" && e.label === "claude");
    expect(localClaude).toBeDefined();
    expect(localClaude!.action).toBe("created");
    expect(lstatSync(localClaude!.linkPath ?? localClaude!.path).isSymbolicLink()).toBeTrue();

    // Local pi editor link should be migrated from legacy directory.
    const localPi = updatedData.entries.find((e) => e.scope === "local" && e.label === "pi");
    expect(localPi).toBeDefined();
    expect(localPi!.status).toBe("legacy");
    expect(localPi!.action).toBe("migrated");
    expect(lstatSync(piLinkPath).isSymbolicLink()).toBeTrue();

    // Local opencode should be skipped (no .opencode config dir).
    const localOpencode = updatedData.entries.find((e) => e.scope === "local" && e.label === "opencode");
    expect(localOpencode).toBeDefined();
    expect(localOpencode!.action).toBe("skipped");
  });

  test("skills update skips not-installed entries without error", async (): Promise<void> => {
    const cwd = createWorkspace();

    // No prior install, no editor dirs — everything should be skipped.
    const updated = await runSkills({
      cwd,
      mode: "json",
      args: ["update"],
    });

    expect(updated.ok).toBeTrue();
    const updatedData = updated.data as {
      entries: Array<{ scope: string; label: string; action: string }>;
    };

    // All entries should be skipped.
    for (const entry of updatedData.entries) {
      expect(entry.action).toBe("skipped");
    }
  });

  test("skills update repairs stale local symlinks", async (): Promise<void> => {
    const cwd = createWorkspace();

    // Create a stale anchor symlink pointing to a wrong target.
    const anchorPath = join(cwd, ".agents", "skills", "trekoon");
    const wrongTarget = join(cwd, "wrong-target");
    mkdirSync(wrongTarget, { recursive: true });
    mkdirSync(dirname(anchorPath), { recursive: true });
    symlinkSync(relative(dirname(anchorPath), wrongTarget), anchorPath, "dir");

    expect(lstatSync(anchorPath).isSymbolicLink()).toBeTrue();

    const updated = await runSkills({
      cwd,
      mode: "json",
      args: ["update"],
    });

    expect(updated.ok).toBeTrue();
    const updatedData = updated.data as {
      entries: Array<{ scope: string; label: string; status: string; action: string }>;
    };

    const localAnchor = updatedData.entries.find((e) => e.scope === "local" && e.label === "anchor");
    expect(localAnchor).toBeDefined();
    expect(localAnchor!.status).toBe("stale");
    expect(localAnchor!.action).toBe("repointed");

    // After repair, should point to the bundled dir.
    expect(lstatSync(anchorPath).isSymbolicLink()).toBeTrue();
    expect(resolve(dirname(anchorPath), readlinkSync(anchorPath))).toBe(resolve(bundledSkillDir()));
  });

  test("trekoon update command smoke test via skills router", async (): Promise<void> => {
    const cwd = createWorkspace();

    // Run update directly (simulates `trekoon update`).
    const result = await runSkills({
      cwd,
      mode: "json",
      args: ["update"],
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("skills.update");

    const data = result.data as {
      sourceDir: string;
      entries: Array<{ scope: string; label: string; action: string }>;
    };

    expect(data.sourceDir).toBeTruthy();
    expect(data.entries.length).toBeGreaterThan(0);

    // With no prior installs and no editor dirs, all should be skipped.
    for (const entry of data.entries) {
      expect(entry.action).toBe("skipped");
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

  test("returns deterministic errors for --global validation", async (): Promise<void> => {
    const cwd = createWorkspace();

    const globalWithTo = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--global", "--to", "/some/path"],
    });
    expect(globalWithTo.ok).toBeFalse();
    expect(globalWithTo.error?.code).toBe("invalid_input");

    const globalWithLink = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--global", "--link"],
    });
    expect(globalWithLink.ok).toBeFalse();
    expect(globalWithLink.error?.code).toBe("invalid_input");

    const globalWithAllowOutside = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "--global", "--allow-outside-repo"],
    });
    expect(globalWithAllowOutside.ok).toBeFalse();
    expect(globalWithAllowOutside.error?.code).toBe("invalid_input");

    // -g short flag should work the same as --global.
    const shortFlag = await runSkills({
      cwd,
      mode: "json",
      args: ["install", "-g", "--to", "/some/path"],
    });
    expect(shortFlag.ok).toBeFalse();
    expect(shortFlag.error?.code).toBe("invalid_input");
  });
});
