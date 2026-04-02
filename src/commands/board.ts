import { parseArgs, readUnexpectedPositionals } from "./arg-parser";

import { ensureBoardInstalled, updateBoardInstallation } from "../board/install";
import { openBoardInBrowser, type OpenBrowserResult } from "../board/open-browser";
import { startBoardServer, type BoardServerInfo } from "../board/server";
import { BoardInstallError, type EnsureBoardInstalledOptions } from "../board/types";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";

type EnsureBoardInstalledFn = (options: EnsureBoardInstalledOptions) => ReturnType<typeof ensureBoardInstalled>;
type StartBoardServerFn = (options: { cwd: string }) => BoardServerInfo;
type OpenBoardInBrowserFn = (url: string) => Promise<OpenBrowserResult> | OpenBrowserResult;

let ensureInstalledImpl: EnsureBoardInstalledFn = ensureBoardInstalled;
let updateInstalledImpl: EnsureBoardInstalledFn = updateBoardInstallation;
let startBoardServerImpl: StartBoardServerFn = (options) => startBoardServer(options);
let openBoardInBrowserImpl: OpenBoardInBrowserFn = openBoardInBrowser;

function usageResult(): CliResult {
  return failResult({
    command: "board",
    human: "Usage: trekoon board <open|update>",
    data: {},
    error: {
      code: "invalid_subcommand",
      message: "Invalid board subcommand",
    },
  });
}

function boardInstallOptions(context: CliContext): EnsureBoardInstalledOptions {
  const bundledAssetRoot: string | undefined = process.env.TREKOON_BOARD_ASSET_ROOT;
  return {
    workingDirectory: context.cwd,
    ...(bundledAssetRoot === undefined ? {} : { bundledAssetRoot }),
  };
}

function boardInstallFailure(command: string, error: BoardInstallError): CliResult {
  return failResult({
    command,
    human: error.message,
    data: {
      code: error.code,
      ...error.details,
    },
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

export function setBoardCommandHooksForTests(hooks: {
  ensureInstalled?: EnsureBoardInstalledFn;
  updateInstalled?: EnsureBoardInstalledFn;
  startBoardServer?: StartBoardServerFn;
  openBoardInBrowser?: OpenBoardInBrowserFn;
} | null): void {
  ensureInstalledImpl = hooks?.ensureInstalled ?? ensureBoardInstalled;
  updateInstalledImpl = hooks?.updateInstalled ?? updateBoardInstallation;
  startBoardServerImpl = hooks?.startBoardServer ?? ((options) => startBoardServer(options));
  openBoardInBrowserImpl = hooks?.openBoardInBrowser ?? openBoardInBrowser;
}

export async function runBoard(context: CliContext): Promise<CliResult> {
  const parsed = parseArgs(context.args);
  const subcommand: string | undefined = parsed.positional[0];

  if (parsed.options.size > 0 || parsed.flags.size > 0) {
    return failResult({
      command: subcommand ? `board.${subcommand}` : "board",
      human: "Board commands do not accept options yet.",
      data: {
        options: [...parsed.providedOptions].map((option) => `--${option}`),
      },
      error: {
        code: "invalid_input",
        message: "Board commands do not accept options",
      },
    });
  }

  if (!subcommand) {
    return usageResult();
  }

  const unexpectedPositionals = readUnexpectedPositionals(parsed, 1);
  if (unexpectedPositionals.length > 0) {
    return failResult({
      command: `board.${subcommand}`,
      human: `Unexpected positional arguments: ${unexpectedPositionals.join(", ")}.`,
      data: {
        unexpectedPositionals,
      },
      error: {
        code: "invalid_input",
        message: "Unexpected positional arguments",
      },
    });
  }

  try {
    switch (subcommand) {
      case "update": {
        const install = updateInstalledImpl(boardInstallOptions(context));
        return okResult({
          command: "board.update",
          human: `Board assets ${install.action} at ${install.paths.runtimeRoot}`,
          data: {
            action: install.action,
            paths: install.paths,
            manifest: install.manifest,
          },
        });
      }
      case "open": {
        const install = ensureInstalledImpl(boardInstallOptions(context));
        const server = startBoardServerImpl({ cwd: context.cwd });
        const launch = await openBoardInBrowserImpl(server.url);
        return okResult({
          command: "board.open",
          human: [
            `Board ready at ${server.fallbackUrl}`,
            launch.launched
              ? `Browser launched with ${launch.command}`
              : `Browser launch failed: ${launch.errorMessage ?? "unknown failure"}`,
            `Open manually if needed: ${server.fallbackUrl}`,
          ].join("\n"),
          data: {
            install: {
              action: install.action,
              paths: install.paths,
              manifest: install.manifest,
            },
            server: {
              origin: server.origin,
              url: server.url,
              fallbackUrl: server.fallbackUrl,
              hostname: server.hostname,
              port: server.port,
              token: server.token,
            },
            launch,
          },
        });
      }
      default:
        return usageResult();
    }
  } catch (error: unknown) {
    if (error instanceof BoardInstallError) {
      return boardInstallFailure(`board.${subcommand}`, error);
    }

    throw error;
  }
}
