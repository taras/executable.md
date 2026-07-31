/**
 * Getting a person to the form.
 *
 * The URL is printed before anything tries to open it. Opening is the part that
 * fails — no browser, no display, no `xdg-open`, a workflow over SSH or in a
 * container — and none of that should end a form that is already listening. So a
 * failed launch is a warning, the printed URL stands on its own, and the workflow
 * keeps waiting.
 *
 * Contextual rather than a parameter, so browser-launching stays out of the
 * authoring contract entirely.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import { spawn } from "effection";
import type { Operation, Task } from "effection";
import { exec, platform } from "@executablemd/runtime";

export interface FormOpenerApi {
  /** Ask the host to open this URL. Failure is the caller's to tolerate. */
  open(url: string): Operation<void>;
}

/** `start` reads a lone quoted argument as a window title, hence the empty one. */
function openCommand(os: string, url: string): string[] {
  if (os === "darwin") {
    return ["open", url];
  }
  if (os === "win32") {
    return ["cmd", "/c", "start", "", url];
  }
  return ["xdg-open", url];
}

export const FormOpener: Api<FormOpenerApi> = createApi<FormOpenerApi>("FormOpener", {
  *open(url: string): Operation<void> {
    const { os } = yield* platform();
    const command = openCommand(os, url);
    const result = yield* exec({ command });
    if (result.exitCode !== 0) {
      throw new Error(
        `the browser command exited ${result.exitCode}: ${command[0]}` +
          (result.stderr.trim() ? ` — ${result.stderr.trim()}` : ""),
      );
    }
  },
});

export const open: Operations<FormOpenerApi>["open"] = FormOpener.operations.open;

/** Where the URL and any warning go. Stderr, never the document. */
export interface OpenerOutput {
  url(text: string): void;
  warn(text: string): void;
}

const consoleOutput: OpenerOutput = {
  url(text: string): void {
    console.error(text);
  },
  warn(text: string): void {
    console.error(text);
  },
};

/**
 * Print the form's URL, then try to open it, and return without waiting.
 *
 * Nothing awaits the launch: a browser command that blocks until the browser
 * quits would hold the workflow open long after the person had answered. The task
 * belongs to the calling scope, so leaving it halts a launch still in flight.
 */
export function* announceForm(
  url: string,
  output: OpenerOutput = consoleOutput,
): Operation<Task<void>> {
  output.url(url);

  return yield* spawn(function* () {
    try {
      yield* open(url);
    } catch (error) {
      // Caught rather than left to the scope: an unobserved failure here would
      // take the form down with it, the one outcome a failed launch must not have.
      const reason = error instanceof Error ? error.message : String(error);
      output.warn(
        `could not open a browser automatically (${reason}). Open the URL above to continue.`,
      );
    }
  });
}
