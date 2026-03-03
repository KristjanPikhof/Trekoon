import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
    expect(resolve(dirname(claudeData.linkPath), readlinkSync(claudeData.linkPath))).toBe(claudeData.installedDir);
  });

  test("install --link supports --to override and detects non-link conflicts", async (): Promise<void> => {
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

    const conflictCwd = createWorkspace();
    const conflictPath = join(conflictCwd, ".claude", "skills", "trekoon");
    mkdirSync(conflictPath, { recursive: true });

    const conflict = await runSkills({
      cwd: conflictCwd,
      mode: "json",
      args: ["install", "--link", "--editor", "claude"],
    });

    expect(conflict.ok).toBeFalse();
    expect(conflict.error?.code).toBe("path_conflict");
    const conflictData = conflict.data as { code: string; linkPath: string };
    expect(conflictData.code).toBe("path_conflict");
    expect(conflictData.linkPath).toBe(conflictPath);
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
    const unknownEditorData = unknownEditor.data as { code: string; editor: string };
    expect(unknownEditorData.code).toBe("invalid_input");
    expect(unknownEditorData.editor).toBe("unknown");

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
  });
});
