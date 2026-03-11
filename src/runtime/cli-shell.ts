import { runHelp } from "../commands/help";
import { runDep } from "../commands/dep";
import { runEpic } from "../commands/epic";
import { runEvents } from "../commands/events";
import { runInit } from "../commands/init";
import { runMigrate } from "../commands/migrate";
import { runQuickstart } from "../commands/quickstart";
import { runSkills } from "../commands/skills";
import { runSubtask } from "../commands/subtask";
import { runSync } from "../commands/sync";
import { runTask } from "../commands/task";
import { runWipe } from "../commands/wipe";
import { failResult, okResult, renderResult } from "../io/output";
import { resolveStorageResolutionDiagnostics } from "../storage/database";
import { type CliContext, type CliResult, type CompatibilityMode, type OutputMode } from "./command-types";
import { CLI_VERSION } from "./version";
import { resolveStoragePaths } from "../storage/path";

const SUPPORTED_ROOT_COMMANDS: readonly string[] = [
  "help",
  "init",
  "quickstart",
  "epic",
  "task",
  "subtask",
  "dep",
  "events",
  "migrate",
  "sync",
  "skills",
  "wipe",
];

export interface ParsedInvocation {
  readonly mode: OutputMode;
  readonly compatibilityMode: CompatibilityMode | null;
  readonly compatibilityModeRaw: string | null;
  readonly compatibilityModeMissingValue: boolean;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly wantsHelp: boolean;
  readonly wantsVersion: boolean;
}

export interface ParseInvocationOptions {
  readonly stdoutIsTTY?: boolean;
}

export function parseInvocation(argv: readonly string[], options: ParseInvocationOptions = {}): ParsedInvocation {
  const stdoutIsTTY: boolean = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  let explicitMode: OutputMode | null = null;
  let compatibilityModeRaw: string | null = null;
  let compatibilityModeMissingValue = false;
  let wantsHelp = false;
  let wantsVersion = false;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token: string | undefined = argv[index];
    if (!token) {
      continue;
    }

    if (token === "--json") {
      explicitMode = "json";
      continue;
    }

    if (token === "--toon") {
      explicitMode = "toon";
      continue;
    }

    if (token === "--help" || token === "-h") {
      wantsHelp = true;
      continue;
    }

    if (token === "--version" || token === "-v") {
      wantsVersion = true;
      continue;
    }

    if (token === "--compat") {
      const maybeValue: string | undefined = argv[index + 1];
      if (!maybeValue || maybeValue.startsWith("--")) {
        compatibilityModeMissingValue = true;
        continue;
      }

      compatibilityModeRaw = maybeValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  const compatibilityMode: CompatibilityMode | null =
    compatibilityModeRaw === "legacy-sync-command-ids" ? compatibilityModeRaw : null;

  return {
    mode: explicitMode ?? (stdoutIsTTY ? "human" : "json"),
    compatibilityMode,
    compatibilityModeRaw,
    compatibilityModeMissingValue,
    command: positionals[0] ?? null,
    args: positionals.slice(1),
    wantsHelp,
    wantsVersion,
  };
}

export function renderShellResult(result: CliResult, mode: OutputMode, compatibilityMode: CompatibilityMode | null = null): string {
  const effectiveCompatibilityMode: CompatibilityMode | null =
    compatibilityMode === "legacy-sync-command-ids" && result.command.startsWith("sync.")
      ? compatibilityMode
      : null;

  return renderResult(result, mode, { compatibilityMode: effectiveCompatibilityMode });
}

function withStorageRootDiagnostics(result: CliResult, cwd: string): CliResult {
  const paths = resolveStoragePaths(cwd);
  const diagnostics = paths.diagnostics;
  const resolutionDiagnostics = resolveStorageResolutionDiagnostics(cwd);

  if (!resolutionDiagnostics.legacyStateDetected && diagnostics.warnings.length === 0 && diagnostics.errors.length === 0) {
    return result;
  }

  return {
    ...result,
    meta: {
      ...(result.meta ?? {}),
      storageRootDiagnostics: {
        invocationCwd: diagnostics.invocationCwd,
        storageMode: diagnostics.storageMode,
        repoCommonDir: diagnostics.repoCommonDir,
        worktreeRoot: diagnostics.worktreeRoot,
        sharedStorageRoot: diagnostics.sharedStorageRoot,
        databaseFile: diagnostics.databaseFile,
        legacyStateDetected: resolutionDiagnostics.legacyStateDetected,
        recoveryRequired: resolutionDiagnostics.recoveryRequired,
        recoveryStatus: resolutionDiagnostics.recoveryStatus,
        legacyDatabaseFiles: resolutionDiagnostics.legacyDatabaseFiles,
        backupFiles: resolutionDiagnostics.backupFiles,
        trackedStorageFiles: resolutionDiagnostics.trackedStorageFiles,
        autoMigratedLegacyState: resolutionDiagnostics.autoMigratedLegacyState,
        importedFromLegacyDatabase: resolutionDiagnostics.importedFromLegacyDatabase,
        operatorAction: resolutionDiagnostics.operatorAction,
        warnings: diagnostics.warnings,
        errors: diagnostics.errors,
      },
    },
  };
}

export async function executeShell(parsed: ParsedInvocation, cwd: string = process.cwd()): Promise<CliResult> {
  if (parsed.compatibilityModeMissingValue) {
    return failResult({
      command: "shell",
      human: "--compat requires an explicit mode value.",
      data: {
        option: "--compat",
        allowedModes: ["legacy-sync-command-ids"],
      },
      error: {
        code: "invalid_args",
        message: "Missing compatibility mode value for --compat.",
      },
    });
  }

  if (parsed.compatibilityModeRaw !== null && parsed.compatibilityMode === null) {
    return failResult({
      command: "shell",
      human: `Unsupported compatibility mode '${parsed.compatibilityModeRaw}'.`,
      data: {
        providedMode: parsed.compatibilityModeRaw,
        allowedModes: ["legacy-sync-command-ids"],
      },
      error: {
        code: "invalid_args",
        message: `Unsupported compatibility mode '${parsed.compatibilityModeRaw}'.`,
      },
    });
  }

  if (parsed.compatibilityMode !== null && parsed.mode === "human") {
    return failResult({
      command: "shell",
      human: "Compatibility mode is machine-only; use --json or --toon.",
      data: {
        mode: parsed.mode,
        compatibilityMode: parsed.compatibilityMode,
      },
      error: {
        code: "invalid_args",
        message: "Compatibility mode requires machine output mode.",
      },
    });
  }

  if (parsed.compatibilityMode === "legacy-sync-command-ids" && parsed.command !== "sync") {
    return failResult({
      command: "shell",
      human: "--compat legacy-sync-command-ids only supports sync commands.",
      data: {
        compatibilityMode: parsed.compatibilityMode,
        command: parsed.command,
      },
      error: {
        code: "invalid_args",
        message: "Compatibility mode can only be used with the sync command.",
      },
    });
  }

  if (parsed.wantsVersion) {
    return okResult({
      command: "version",
      human: CLI_VERSION,
      data: { version: CLI_VERSION },
    });
  }

  if (parsed.wantsHelp) {
    const helpContext: CliContext = {
      mode: parsed.mode,
      cwd,
      args: parsed.command ? [parsed.command] : [],
    };

    return withStorageRootDiagnostics(await runHelp(helpContext), cwd);
  }

  if (!parsed.command) {
    return withStorageRootDiagnostics(
      await runHelp({
      mode: parsed.mode,
      args: [],
      cwd,
      }),
      cwd,
    );
  }

  if (!SUPPORTED_ROOT_COMMANDS.includes(parsed.command)) {
    return withStorageRootDiagnostics(
      failResult({
      command: "shell",
      human: `Unknown command: ${parsed.command}\nRun 'trekoon --help' for usage.`,
      data: {
        command: parsed.command,
        supportedCommands: SUPPORTED_ROOT_COMMANDS,
      },
      error: {
        code: "unknown_command",
        message: `Unknown command '${parsed.command}'`,
      },
      }),
      cwd,
    );
  }

  const context: CliContext = {
    mode: parsed.mode,
    args: parsed.args,
    cwd,
  };

  let result: CliResult;

  switch (parsed.command) {
    case "help":
      result = await runHelp(context);
      break;
    case "init":
      result = await runInit(context);
      break;
    case "quickstart":
      result = await runQuickstart(context);
      break;
    case "wipe":
      result = await runWipe(context);
      break;
    case "epic":
      result = await runEpic(context);
      break;
    case "task":
      result = await runTask(context);
      break;
    case "subtask":
      result = await runSubtask(context);
      break;
    case "dep":
      result = await runDep(context);
      break;
    case "events":
      result = await runEvents(context);
      break;
    case "migrate":
      result = await runMigrate(context);
      break;
    case "sync":
      result = await runSync(context);
      break;
    case "skills":
      result = await runSkills(context);
      break;
    default:
      result = failResult({
        command: "shell",
        human: `Unhandled command: ${parsed.command}`,
        data: { command: parsed.command },
        error: {
          code: "unhandled_command",
          message: `No shell handler for '${parsed.command}'`,
        },
      });
      break;
  }

  return withStorageRootDiagnostics(result, cwd);
}
