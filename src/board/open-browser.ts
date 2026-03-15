import { spawn } from "node:child_process";

export interface OpenBrowserResult {
  readonly launched: boolean;
  readonly url: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly errorMessage: string | null;
}

type BrowserLaunchEvent = "error" | "exit" | "spawn";
type BrowserLaunchListener = (eventData?: Error | number | null) => void;

interface BrowserLaunchHandle {
  once(event: BrowserLaunchEvent, listener: BrowserLaunchListener): BrowserLaunchHandle;
  removeListener(event: BrowserLaunchEvent, listener: BrowserLaunchListener): BrowserLaunchHandle;
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
      let settled = false;
      let spawned = false;
      let launchResultScheduled = false;

      const complete = (result: OpenBrowserResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        child.removeListener("spawn", handleSpawn);
        child.removeListener("error", handleError);
        child.removeListener("exit", handleExit);
        resolve(result);
      };

      const resolveLaunchSuccess = (): void => {
        complete({
          launched: true,
          url,
          command: launch.command,
          args: launch.args,
          errorMessage: null,
        });
      };

      const handleSpawn = (): void => {
        spawned = true;
        if (launchResultScheduled) {
          return;
        }

        launchResultScheduled = true;
        setTimeout(resolveLaunchSuccess, 0);
      };

      const handleError = (eventData?: Error | number | null): void => {
        complete({
          launched: false,
          url,
          command: launch.command,
          args: launch.args,
          errorMessage: eventData instanceof Error ? eventData.message : "Unknown browser launch failure",
        });
      };

      const handleExit = (eventData?: Error | number | null): void => {
        const exitCode = typeof eventData === "number" ? eventData : Number.NaN;

        if (!spawned || exitCode === 0 || Number.isNaN(exitCode)) {
          return;
        }

        complete({
          launched: false,
          url,
          command: launch.command,
          args: launch.args,
          errorMessage: `${launch.command} exited with code ${exitCode}`,
        });
      };

      child.once("spawn", handleSpawn);
      child.once("error", handleError);
      child.once("exit", handleExit);
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
