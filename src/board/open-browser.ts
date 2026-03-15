import { spawn } from "node:child_process";

export interface OpenBrowserResult {
  readonly launched: boolean;
  readonly url: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly errorMessage: string | null;
}

type BrowserLauncher = (command: string, args: readonly string[]) => void;

let browserLauncher: BrowserLauncher = (command: string, args: readonly string[]): void => {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

function resolveOpenCommand(url: string): { command: string; args: readonly string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

export function setBrowserLauncherForTests(nextLauncher: BrowserLauncher | null): void {
  browserLauncher = nextLauncher ?? ((command: string, args: readonly string[]): void => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  });
}

export function openBoardInBrowser(url: string): OpenBrowserResult {
  const launch = resolveOpenCommand(url);

  try {
    browserLauncher(launch.command, launch.args);
    return {
      launched: true,
      url,
      command: launch.command,
      args: launch.args,
      errorMessage: null,
    };
  } catch (error: unknown) {
    return {
      launched: false,
      url,
      command: launch.command,
      args: launch.args,
      errorMessage: error instanceof Error ? error.message : "Unknown browser launch failure",
    };
  }
}
