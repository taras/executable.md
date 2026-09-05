/**
 * Tier TH — which hosts open a terminal grid, and which only describe one
 * (architecture.md §Package ownership, issue #717).
 *
 * The host-composition boundary is CLI's, so its evidence is too. The tmux
 * adapter's own topology, protocol, worker and teardown rows live with the
 * adapter in `@executablemd/terminal-tmux`; what is proved here is the part
 * only an entrypoint can answer — which runtime installs a provider and an
 * observer, which installs neither, what a real document gets in each case,
 * and that a terminal going away cancels the run rather than closing the grid.
 *
 * The fake tmux server and its client fixtures are imported from the adapter's
 * own tests. That is a test-only path: it creates no package dependency, and
 * the production graph CLI declares is unchanged by it.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, resource, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { cliCommand } from "@executablemd/test-support/launch";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { execute } from "@executablemd/core";
import { installTerminalProvider, useTerminalInstallation } from "@executablemd/terminal/lifecycle";
import type { Json } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { registerTerminalProvider, TerminalGrids } from "@executablemd/terminal";
import { installControlledLauncher } from "@executablemd/terminal/test";
import { processReachable } from "@executablemd/terminal/processes";
import { installDenoTerminalProcesses } from "@executablemd/terminal/posix";
import { PANE_WORKER_COMMAND, tmuxGridProvider } from "@executablemd/terminal-tmux";
import { foregroundSignalListeners } from "@executablemd/terminal-tmux/test";
import { createFakeTmux } from "../../terminal-tmux/tests/fixtures/fake-tmux.ts";
import { clientCommand } from "../../terminal-tmux/tests/fixtures/client-command.ts";
import { foregroundTerminalGrid, unsupportedTerminalGrid } from "../src/grid-host.ts";

/** Where a fake server and its client fixtures meet. */
function useScript(): Operation<string> {
  return resource<string>(function* (provide) {
    const file = path.join(tmpdir(), `xmd-tmux-script-${randomUUID()}.txt`);
    yield* writeTextFile(file, "");
    yield* ensure(function* () {
      yield* rm(file, { force: true });
    });
    yield* provide(file);
  });
}

/**
 * Open a grid through the provider, with the host's prerequisites answered by
 * this row rather than by the machine.
 *
 * Goes through the real factory and the real installation handshake, so what a
 * refusal proves is what a document would meet.
 */
function useProbedProvider(options: {
  isTerminal: () => boolean;
  version?: string;
}): Operation<void> {
  return (function* (): Operation<void> {
    const authority = yield* useTerminalInstallation();
    yield* registerTerminalProvider(
      "tmux",
      tmuxGridProvider({
        isTerminal: options.isTerminal,
        env: { PATH: "/usr/bin:/bin" },
        // deno-lint-ignore require-yield
        *workerCommand() {
          return [];
        },
        size: () => ({ columns: 80, rows: 24 }),
        ...(options.version === undefined
          ? {}
          : {
              // deno-lint-ignore require-yield
              *askVersion() {
                return { code: 0, stdout: options.version ?? "" };
              },
            }),
      }),
    );
    yield* installTerminalProvider("tmux", { label: "tmux" }, authority);
    yield* TerminalGrids.operations.open({
      columns: 1,
      rows: 1,
      panes: [{ ordinal: 0, title: "Only", row: 0, column: 0, form: "paired" }],
    });
  })();
}

/** A directory a row can leave markers in. */
function useScratch(): Operation<string> {
  return resource<string>(function* (provide) {
    const room = path.join(tmpdir(), `xmd-tg20-${randomUUID()}`);
    yield* ensureDir(room);
    yield* ensure(function* () {
      yield* rm(room, { recursive: true, force: true });
    });
    yield* provide(room);
  });
}

/** Settle once this child has gone, whether or not it already had. */
function exited(child: ChildProcess): Operation<void> {
  const done = withResolvers<void>();
  const onExit = (): void => done.resolve();
  if (child.exitCode !== null || child.signalCode !== null) {
    done.resolve();
  } else {
    child.on("exit", onExit);
  }
  return (function* (): Operation<void> {
    try {
      yield* done.operation;
    } finally {
      child.off("exit", onExit);
    }
  })();
}

/** A shell that says when it started, and stays until it is signalled. */
function useShellFixture(room: string): Operation<string> {
  return resource<string>(function* (provide) {
    const file = path.join(room, "shell");
    yield* writeTextFile(
      file,
      [
        "#!/bin/sh",
        // Its own environment, before anything else. A plain script sources no
        // startup file, so what this records is what the pane handed it rather
        // than what a `.zshrc` added afterwards.
        `env > "${room}/shell-env"`,
        `echo $$ > "${room}/shell-pid"`,
        "while true; do sleep 0.05; done",
        "",
      ].join("\n"),
    );
    yield* until(chmod(file, 0o755));
    yield* provide(file);
  });
}

/** One entrypoint's source, for the rows about what a host assembles. */
function entrypointSource(name: string): Operation<string> {
  return readTextFile(path.resolve("packages/cli/src", name));
}

describe("Tier TH — host installation", () => {
  it("TD9: a teardown that fails refuses the run, and nothing after the grid goes", function* () {
    // The document-level end of the same claim: a grid whose teardown could not
    // establish the terminal was given back is a failed run, not a run with a
    // warning in it.
    const room = yield* useScratch();
    const shell = yield* useShellFixture(room);
    const script = yield* useScript();
    const invocation = cliCommand([]);
    // The server refuses to be killed the first time it is asked, so the last
    // phase of the teardown cannot establish it is gone.
    const tmux = createFakeTmux({
      script,
      clientCommand,
      spawnPanes: true,
      failOnce: { command: "kill-server", message: "refused" },
    });
    yield* ensure(() => {
      tmux.stopPanes();
    });
    yield* writeTextFile(
      path.join(room, "doc.md"),
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Only" />',
        "</Terminal.Grid>",
        "",
        "AFTER_THE_GRID",
        "",
      ].join("\n"),
    );
    yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });

    let outcome: Result<Json> | undefined;
    let output = "";
    yield* scoped(function* () {
      yield* foregroundTerminalGrid({
        isTerminal: () => true,
        createTmux: () => tmux,
        env: { PATH: "/usr/bin:/bin", SHELL: shell },
        // deno-lint-ignore require-yield
        *askVersion() {
          return { code: 0, stdout: "tmux 3.6a" };
        },
        workerCommand: function* (ordinal, at) {
          return [
            invocation.command,
            ...invocation.arguments,
            PANE_WORKER_COMMAND,
            String(ordinal),
            at,
          ];
        },
      })();

      yield* spawn(function* () {
        while (!(yield* exists(`${room}/shell-pid`))) {
          yield* sleep(15);
        }
        while (tmux.clients.length === 0) {
          yield* sleep(15);
        }
        yield* tmux.say(`%client-detached ${tmux.clients[0] ?? ""}`);
      });

      const execution = yield* execute({
        path: path.join(room, "doc.md"),
        stream: new InMemoryStream(),
        includes: [room],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        output = next.value;
        next = yield* subscription.next();
      }
      outcome = yield* execution;
    });

    expect(outcome?.ok).toBe(false);
    const refusal = outcome?.ok === false ? String(outcome.error) : "";
    expect(refusal).toContain("terminal server");
    // Nothing private in it, and nothing after the grid ran.
    expect(refusal).not.toContain(room);
    expect(output).not.toContain("AFTER_THE_GRID");
  });

  it("TH1: without a terminal, a grid refuses before anything exists", function* () {
    const before = yield* until(readdir(tmpdir()));
    let refusal = "";
    try {
      yield* scoped(function* () {
        yield* installDenoTerminalProcesses();
        yield* useProbedProvider({ isTerminal: () => false });
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    expect(refusal).toContain("cannot open a terminal grid");
    expect(refusal).toContain("no terminal");
    // Before a directory, a socket, a token, a worker, a server or a pane: the
    // host left nothing behind for having tried.
    const after = yield* until(readdir(tmpdir()));
    expect(after.filter((name) => name.startsWith("xmd-grid-")).length).toBe(
      before.filter((name) => name.startsWith("xmd-grid-")).length,
    );
  });

  it("TH2: without a usable tmux, a grid refuses the same way", function* () {
    let refusal = "";
    try {
      yield* scoped(function* () {
        yield* installDenoTerminalProcesses();
        yield* useProbedProvider({
          isTerminal: () => true,
          // A tmux far too old for an explicit layout string.
          version: "tmux 1.8",
        });
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("cannot open a terminal grid");
    expect(refusal).toContain("older than tmux");
  });

  it("TH4: the installed SIGHUP listener cancels the run and tears the grid down", function* () {
    const room = yield* useScratch();
    const shell = yield* useShellFixture(room);
    const script = yield* useScript();
    const invocation = cliCommand([]);
    const tmux = createFakeTmux({ script, clientCommand, spawnPanes: true });
    yield* ensure(() => {
      tmux.stopPanes();
    });
    yield* writeTextFile(
      path.join(room, "doc.md"),
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Only" />',
        "</Terminal.Grid>",
        "",
        "AFTER_THE_GRID",
        "",
      ].join("\n"),
    );
    // The run's foreground lease, which a grid takes before any provider.
    yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });

    const sighupBefore = foregroundSignalListeners("SIGHUP");
    let directory = "";
    let installed = 0;
    let outcome: Result<Json> | undefined;
    let output = "";
    yield* scoped(function* () {
      yield* foregroundTerminalGrid({
        isTerminal: () => true,
        createTmux: () => tmux,
        env: { PATH: "/usr/bin:/bin", SHELL: shell },
        // deno-lint-ignore require-yield
        *askVersion() {
          return { code: 0, stdout: "tmux 3.6a" };
        },
        workerCommand: function* (ordinal, at) {
          directory = at;
          return [
            invocation.command,
            ...invocation.arguments,
            PANE_WORKER_COMMAND,
            String(ordinal),
            at,
          ];
        },
      })();
      // The listener is the installer's, and this row uses that one.
      installed = foregroundSignalListeners("SIGHUP");

      yield* spawn(function* () {
        // Driven by the pane child's own start: the worker spawned, its channel
        // authenticated, and the shell it launched said so.
        while (!(yield* exists(`${room}/shell-pid`))) {
          yield* sleep(15);
        }
        process.kill(process.pid, "SIGHUP");
      });

      const execution = yield* execute({
        path: path.join(room, "doc.md"),
        stream: new InMemoryStream(),
        includes: [room],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        output = next.value;
        next = yield* subscription.next();
      }
      outcome = yield* execution;
    });

    // The installer put its listener on, and took it off with the run.
    expect(installed).toBe(sighupBefore + 1);
    expect(foregroundSignalListeners("SIGHUP")).toBe(sighupBefore);

    // Cancellation, not a reader close: the run failed and nothing after the
    // grid ran in that attempt.
    expect(outcome?.ok).toBe(false);
    expect(output).not.toContain("AFTER_THE_GRID");

    // Every teardown phase completed before the result was observed. The pane's
    // child is gone, the worker is gone, the server is gone, and the private
    // directory — which is removed last, after its sockets have closed — is
    // gone with them.
    const shellPid = Number((yield* readTextFile(`${room}/shell-pid`)).trim());
    expect(shellPid).toBeGreaterThan(0);
    yield* installDenoTerminalProcesses();
    expect(yield* processReachable(shellPid)).toBe(false);
    // Awaited on each process's own exit event, not sampled: a worker that had
    // not quite gone yet would make a sampled check pass or fail by timing.
    for (const child of tmux.started) {
      yield* exited(child);
    }
    expect(tmux.alive()).toBe(false);
    expect(directory).not.toBe("");
    expect(yield* exists(directory)).toBe(false);
  });

  it("TH5: an ordinary run shows the grid, and the reader's detach ends it", function* () {
    // The same host, the same document and the same live grid as TH4. What
    // differs is the ending: the reader leaves rather than the terminal going
    // away, so the grid settles and the document carries on — which is the
    // branch `useHangupCancellation()` has to hand the result back through.
    const room = yield* useScratch();
    const shell = yield* useShellFixture(room);
    const script = yield* useScript();
    const invocation = cliCommand([]);
    const tmux = createFakeTmux({ script, clientCommand, spawnPanes: true });
    yield* ensure(() => {
      tmux.stopPanes();
    });
    yield* writeTextFile(
      path.join(room, "doc.md"),
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Only" />',
        "</Terminal.Grid>",
        "",
        "AFTER_THE_GRID",
        "",
      ].join("\n"),
    );
    yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });

    let directory = "";
    let outcome: Result<Json> | undefined;
    let output = "";
    yield* scoped(function* () {
      yield* foregroundTerminalGrid({
        isTerminal: () => true,
        createTmux: () => tmux,
        env: { PATH: "/usr/bin:/bin", SHELL: shell },
        // deno-lint-ignore require-yield
        *askVersion() {
          return { code: 0, stdout: "tmux 3.6a" };
        },
        workerCommand: function* (ordinal, at) {
          directory = at;
          return [
            invocation.command,
            ...invocation.arguments,
            PANE_WORKER_COMMAND,
            String(ordinal),
            at,
          ];
        },
      })();

      yield* spawn(function* () {
        // Driven by the grid's own progress: the pane child started, and the
        // server has a reader's client to report the detach of. No SIGHUP.
        while (!(yield* exists(`${room}/shell-pid`))) {
          yield* sleep(15);
        }
        while (tmux.clients.length === 0) {
          yield* sleep(15);
        }
        yield* tmux.say(`%client-detached ${tmux.clients[0] ?? ""}`);
      });

      const execution = yield* execute({
        path: path.join(room, "doc.md"),
        stream: new InMemoryStream(),
        includes: [room],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        output = next.value;
        next = yield* subscription.next();
      }
      outcome = yield* execution;
    });

    // The exact result, handed back through the hangup wrapper rather than
    // swallowed by it: a handler that answered with nothing would be refused
    // for having returned before the document produced a result.
    expect(outcome).toEqual(Ok("\n\nAFTER_THE_GRID\n"));
    // The reader closed the grid; the document went on.
    expect(output).toContain("AFTER_THE_GRID");

    // And it went on over a grid that had actually been taken down: the pane's
    // child, the workers, the server and the private directory are all gone.
    const shellPid = Number((yield* readTextFile(`${room}/shell-pid`)).trim());
    expect(shellPid).toBeGreaterThan(0);
    yield* installDenoTerminalProcesses();
    expect(yield* processReachable(shellPid)).toBe(false);
    for (const child of tmux.started) {
      yield* exited(child);
    }
    expect(tmux.alive()).toBe(false);
    expect(directory).not.toBe("");
    expect(yield* exists(directory)).toBe(false);
  });

  it("TH6: the Deno and compiled entrypoints present grids; Node and Bun do not", function* () {
    for (const name of ["deno.ts", "compiled.ts"]) {
      expect((yield* entrypointSource(name)).includes("foregroundTerminalGrid()")).toBe(true);
    }
    for (const name of ["node.ts", "bun.ts"]) {
      // Not a different grid: no grid at all, and therefore the default the
      // shared entry declares — which is the installation that validates a grid
      // and presents none.
      expect((yield* entrypointSource(name)).includes("foregroundTerminalGrid")).toBe(false);
    }
    expect(yield* entrypointSource("cli.ts")).toContain(
      "installTerminalGrid: TerminalGridInstaller = unsupportedTerminalGrid",
    );
  });

  it("TH7: a pane's child is told the terminal's colour depth without a shell startup", function* () {
    // The reported defect: an agent launched into a pane was colourless while
    // the same program run by hand in the grid's Shell pane had colour. By
    // hand it had colour because an interactive shell sources the reader's
    // startup files, and theirs export `COLORTERM`. A pane's direct child
    // sources nothing, so what it knows about the terminal is only what the
    // host hands it — and `COLORTERM` was not in that list.
    //
    // Deliberately without an `env` override, so `paneEnvironment()` is what
    // builds the environment. The shell here is a plain script: it records what
    // it was given before doing anything, so nothing a startup file might add
    // can be mistaken for what the pane provided.
    const room = yield* useScratch();
    const shell = yield* useShellFixture(room);
    const script = yield* useScript();
    const invocation = cliCommand([]);
    const tmux = createFakeTmux({ script, clientCommand, spawnPanes: true });
    yield* ensure(() => {
      tmux.stopPanes();
    });

    const hadColor = process.env.COLORTERM;
    const hadShell = process.env.SHELL;
    process.env.COLORTERM = "truecolor";
    process.env.SHELL = shell;
    yield* ensure(() => {
      if (hadColor === undefined) {
        delete process.env.COLORTERM;
      } else {
        process.env.COLORTERM = hadColor;
      }
      if (hadShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = hadShell;
      }
    });

    yield* writeTextFile(
      path.join(room, "doc.md"),
      ["<Terminal.Grid columns={1}>", '<Terminal title="Only" />', "</Terminal.Grid>", ""].join(
        "\n",
      ),
    );
    yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });

    yield* scoped(function* () {
      yield* foregroundTerminalGrid({
        isTerminal: () => true,
        createTmux: () => tmux,
        // deno-lint-ignore require-yield
        *askVersion() {
          return { code: 0, stdout: "tmux 3.6a" };
        },
        workerCommand: function* (ordinal, at) {
          return [
            invocation.command,
            ...invocation.arguments,
            PANE_WORKER_COMMAND,
            String(ordinal),
            at,
          ];
        },
      })();

      yield* spawn(function* () {
        while (!(yield* exists(`${room}/shell-pid`))) {
          yield* sleep(15);
        }
        while (tmux.clients.length === 0) {
          yield* sleep(15);
        }
        yield* tmux.say(`%client-detached ${tmux.clients[0] ?? ""}`);
      });

      const execution = yield* execute({
        path: path.join(room, "doc.md"),
        stream: new InMemoryStream(),
        includes: [room],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      yield* execution;
    });

    const given = yield* readTextFile(`${room}/shell-env`);
    // What the terminal is, and how much of it the child may use.
    expect(given).toContain("TERM=");
    expect(given).toContain("COLORTERM=truecolor");
  });

  it("TH3: a host that installs no provider still validates the grid", function* () {
    // Node and Bun: the same language and the same validation, and core's own
    // refusal rather than a provider that half-works.
    yield* unsupportedTerminalGrid();
    let refusal = "";
    try {
      yield* TerminalGrids.operations.open({
        columns: 1,
        rows: 1,
        panes: [{ ordinal: 0, title: "Only", row: 0, column: 0, form: "paired" }],
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("no terminal provider is installed");
  });
});
