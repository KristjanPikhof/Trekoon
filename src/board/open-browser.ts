import { spawn } from "node:child_process";

export interface OpenBrowserResult {
  readonly launched: boolean;
  readonly url: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly errorMessage: string | null;
}

type BrowserLaunchEvent = "error" | "spawn";

interface BrowserLaunchHandle {
  once(event: BrowserLaunchEvent, listener: (error?: Error) => void): BrowserLaunchHandle;
  removeListener(event: BrowserLaunchEvent, listener: (error?: Error) => void): BrowserLaunchHandle;
  unref(): void;
}

type BrowserLauncher = (command: string, args: readonly string[]) => BrowserLaunchHandle;

function spawnBrowserProcess(command: string, args: readonly string[]): BrowserLaunchHandle {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

let browserLauncher: BrowserLauncher = spawnBrowserProcess;

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
  browserLauncher = nextLauncher ?? spawnBrowserProcess;
}

export async function openBoardInBrowser(url: string): Promise<OpenBrowserResult> {
  const launch = resolveOpenCommand(url);

  try {
    const child = browserLauncher(launch.command, launch.args);

    return await new Promise<OpenBrowserResult>((resolve) => {
      const handleSpawn = (): void => {
        child.removeListener("error", handleError);
        resolve({
          launched: true,
          url,
          command: launch.command,
          args: launch.args,
          errorMessage: null,
        });
      };
      const handleError = (error?: Error): void => {
        child.removeListener("spawn", handleSpawn);
        resolve({
          launched: false,
          url,
          command: launch.command,
          args: launch.args,
          errorMessage: error?.message ?? "Unknown browser launch failure",
        });
      };

      child.once("spawn", handleSpawn);
      child.once("error", handleError);
    });
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
