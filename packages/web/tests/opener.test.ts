import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, suspend, withResolvers } from "effection";
import { API } from "@executablemd/runtime";

import { announceForm, FormOpener } from "../src/opener.ts";
import type { OpenerOutput } from "../src/opener.ts";
import { useFormServer } from "../src/server.ts";
import { addressOf, formInput, portRefuses } from "./server-support.ts";

/** What a person would have been shown, without capturing process stderr. */
function recorder(): { output: OpenerOutput; urls: string[]; warnings: string[] } {
  const urls: string[] = [];
  const warnings: string[] = [];
  return {
    urls,
    warnings,
    output: {
      url(text: string): void {
        urls.push(text);
      },
      warn(text: string): void {
        warnings.push(text);
      },
    },
  };
}

describe("opener: what the person is told", () => {
  it("prints the exact token-scoped URL and hands the same one to the opener", function* () {
    const opened: string[] = [];
    const seen = withResolvers<void>();
    const shown = recorder();

    yield* scoped(function* () {
      yield* FormOpener.around({
        // deno-lint-ignore require-yield
        *open([url]) {
          opened.push(url);
          seen.resolve();
        },
      });

      const server = yield* useFormServer(formInput());
      yield* announceForm(server.url, shown.output);
      yield* seen.operation;

      expect(shown.urls).toEqual([server.url]);
      expect(opened).toEqual([server.url]);
      // The URL is the form's own, token and trailing slash included.
      expect(server.url.endsWith("/")).toBe(true);
      expect(opened[0]).toContain(addressOf(server.url).prefix);
    });
  });

  /**
   * Printing comes first because it is the part that cannot fail. If the order
   * were reversed, a host with no browser would produce a warning about a URL the
   * person had never been shown.
   */
  it("prints before opening, so a failing opener still leaves a usable URL", function* () {
    const shown = recorder();
    const attempted = withResolvers<void>();

    yield* scoped(function* () {
      yield* FormOpener.around({
        // deno-lint-ignore require-yield
        *open() {
          attempted.resolve();
          throw new Error("no browser here");
        },
      });

      const server = yield* useFormServer(formInput());
      yield* announceForm(server.url, shown.output);
      yield* attempted.operation;

      expect(shown.urls).toEqual([server.url]);
    });
  });
});

describe("opener: failure is a warning, not an ending", () => {
  it("warns and leaves the server serving", function* () {
    const shown = recorder();
    const done = withResolvers<void>();

    yield* scoped(function* () {
      yield* FormOpener.around({
        // deno-lint-ignore require-yield
        *open() {
          throw new Error("xdg-open is missing");
        },
      });

      const server = yield* useFormServer(formInput());
      const launch = yield* announceForm(server.url, shown.output);
      // The task settles rather than failing: a rejected task would take the
      // enclosing scope, and the form, down with it.
      yield* launch;
      done.resolve();

      expect(shown.warnings.length).toBe(1);
      expect(shown.warnings[0]).toContain("xdg-open is missing");
      expect(shown.warnings[0]).toContain("Open the URL above");

      // Still listening, still the one submission to give.
      expect(yield* portRefuses(addressOf(server.url).port)).toBe(false);
    });

    yield* done.operation;
  });

  it("reports a non-zero exit from the platform command", function* () {
    const shown = recorder();

    yield* scoped(function* () {
      yield* API.Env.around({
        // deno-lint-ignore require-yield
        *platform() {
          return { os: "linux", arch: "x64" };
        },
      });
      yield* API.Process.around({
        // deno-lint-ignore require-yield
        *exec() {
          return { exitCode: 3, stdout: "", stderr: "no display" };
        },
      });

      const launch = yield* announceForm("http://127.0.0.1:1/f/token/", shown.output);
      yield* launch;

      expect(shown.warnings.length).toBe(1);
      expect(shown.warnings[0]).toContain("exited 3");
      expect(shown.warnings[0]).toContain("no display");
    });
  });

  it("chooses the platform's own command", function* () {
    const commands: string[][] = [];

    for (const os of ["darwin", "linux", "win32"]) {
      yield* scoped(function* () {
        yield* API.Env.around({
          // deno-lint-ignore require-yield
          *platform() {
            return { os, arch: "x64" };
          },
        });
        yield* API.Process.around({
          // deno-lint-ignore require-yield
          *exec([options]) {
            commands.push(options.command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        });
        yield* yield* announceForm("http://127.0.0.1:1/f/t/", recorder().output);
      });
    }

    expect(commands).toEqual([
      ["open", "http://127.0.0.1:1/f/t/"],
      ["xdg-open", "http://127.0.0.1:1/f/t/"],
      // The empty title is not decoration: `start` reads a lone quoted argument
      // as the window title rather than the thing to open.
      ["cmd", "/c", "start", "", "http://127.0.0.1:1/f/t/"],
    ]);
  });
});

describe("opener: the launch belongs to its scope", () => {
  /**
   * A browser command can outlive the tab it opened — `open` on macOS returns
   * quickly, but a command that blocks until the browser quits would otherwise
   * hold the workflow open long after the person answered. Leaving the scope must
   * end it.
   */
  it("halts an opener still running when the scope goes away", function* () {
    const started = withResolvers<void>();
    const cleaned = withResolvers<void>();

    yield* scoped(function* () {
      yield* FormOpener.around({
        *open() {
          started.resolve();
          try {
            // Stands in for a command that does not return on its own.
            yield* suspend();
          } finally {
            cleaned.resolve();
          }
        },
      });

      yield* announceForm("http://127.0.0.1:1/f/t/", recorder().output);
      yield* started.operation;
    });

    // The scope closed; the launch was halted and its cleanup observed.
    yield* cleaned.operation;
  });

  it("does not wait for the opener before returning", function* () {
    const shown = recorder();

    yield* scoped(function* () {
      yield* FormOpener.around({
        *open() {
          yield* suspend();
        },
      });

      // Returning at all is the assertion: a blocking opener would never let
      // `announceForm` finish, and this test would time out instead.
      const launch = yield* announceForm("http://127.0.0.1:1/f/t/", shown.output);

      expect(shown.urls.length).toBe(1);
      expect(launch).toBeDefined();
    });
  });
});
