import { ensureDir, exists, writeTextFile } from "@effectionx/fs";
import { keyToAnsi, parseKey } from "@termless/core";
import { createXtermBackend } from "@termless/xtermjs";
import {
  all,
  ensure,
  type Operation,
  race,
  resource,
  sleep,
  scoped,
  spawn,
  until,
  withResolvers,
} from "effection";
import process from "node:process";
import { join } from "node:path";
import { decodeLocation } from "../../../packages/cli/src/repl/route.ts";
import type { Command, Launch, Point, WaitOptions } from "./protocol.ts";
import { denoCommand } from "./run.ts";
import { viewport } from "./screen.ts";

interface Pty {
  write(input: string | Uint8Array): void;
  resize(columns: number, rows: number): void;
  close(): void;
}
interface PtyChild {
  pid: number;
  terminal: Pty;
  exited: Promise<number>;
  kill(signal: number): void;
}
// Bun's PTY API is confined to this runtime entry point. Deno typechecks its consumers too.
declare const Bun: {
  spawn(
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      terminal: {
        cols: number;
        rows: number;
        data(terminal: Pty, bytes: Uint8Array): void;
        exit(): void;
      };
    },
  ): PtyChild;
  write(path: string, data: Uint8Array): Promise<number>;
};

const START_TIMEOUT = 15_000;
const ACTION_TIMEOUT = 5_000;
// Give ACPX's bounded active-turn and agent retirement time to finish before forcing REPL exit.
const SCRIPTED_STOP_GRACE = 10_000;

function reopenLocation(raw: string): string | null {
  // A terminal wraps at display time. If a host inserts line breaks in the
  // printed command, the closing quote still delimits the complete location.
  const quoted = [...raw.matchAll(/xmd repl '(xmd:\/\/repl\/[^']+)'/g)].at(-1)?.[1];
  if (quoted === undefined) {
    return null;
  }
  const location = quoted.replace(/\r?\n[ \t]*/g, "");
  return decodeLocation(location).ok ? location : null;
}

export function useDriver(options: Launch) {
  return resource(function* (
    provide: (value: { execute(command: Command): Operation<unknown> }) => Operation<void>,
  ) {
    const { directory, cwd, home } = options;
    let size = { columns: options.columns, rows: options.rows };
    let child: PtyChild | undefined;
    let screen = "";
    let exited = false;
    let ptyEnded = false;
    let step = "launch REPL";
    const chunks: Uint8Array[] = [];
    const eof = withResolvers<void>();
    const lastFrame = () => viewport(backend, size);
    let changed = withResolvers<void>();
    function update(): void {
      const previous = changed;
      changed = withResolvers<void>();
      previous.resolve();
    }
    const backend = createXtermBackend({ cols: size.columns, rows: size.rows });
    let stopped = false;

    function* save(): Operation<string> {
      const text = screen || lastFrame().text;
      yield* writeTextFile(join(directory, "screen.txt"), `${text}\n`);
      const raw = Buffer.concat(chunks);
      yield* until(Bun.write(join(directory, "terminal.ansi"), raw));
      return raw.toString("utf8");
    }

    function* stop(): Operation<void> {
      if (stopped) {
        return;
      }
      const owned = child;
      yield* scoped(function* () {
        yield* ensure(function* () {
          try {
            yield* save();
          } finally {
            owned?.terminal.close();
            stopped = true;
          }
          yield* writeTextFile(
            join(directory, "closed.json"),
            JSON.stringify({ pid: owned?.pid, step }),
          );
        });
        if (owned === undefined) {
          return;
        }
        if (!exited) {
          owned.kill(15);
        }
        const closed = all([until(owned.exited), eof.operation]);
        const timely = yield* race([
          closed,
          (function* () {
            yield* sleep(options.scenario === undefined ? 2_000 : SCRIPTED_STOP_GRACE);
            return null;
          })(),
        ]);
        if (timely === null) {
          owned.kill(9);
          yield* closed;
        }
      });
    }

    yield* ensure(function* () {
      try {
        yield* stop();
      } finally {
        backend.destroy();
      }
    });
    try {
      yield* ensureDir(home);
      child = Bun.spawn(denoCommand(["repl", ...options.args]), {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XMD_SIDEKICK_SCENARIO: options.scenario,
          DENO_DIR: options.denoDir,
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_STATE_HOME: join(home, ".local", "state"),
          XDG_CACHE_HOME: join(home, ".cache"),
          TERM: "xterm-256color",
        },
        terminal: {
          cols: size.columns,
          rows: size.rows,
          data(_terminal, bytes) {
            chunks.push(Uint8Array.from(bytes));
            backend.feed(bytes);
            if (backend.getMode("altScreen")) {
              // Keep the last application screen when the child restores the normal buffer.
              screen = backend.getText();
            }
            update();
          },
          exit() {
            ptyEnded = true;
            eof.resolve();
            update();
          },
        },
      });
      yield* writeTextFile(join(directory, "pid"), `${child.pid}\n`);
    } catch (error) {
      throw new Error(`${step} failed. Evidence in ${directory}`, { cause: error });
    }
    const owned = child;
    yield* spawn(function* () {
      yield* until(owned.exited);
      exited = true;
      update();
    });

    function send(input: string | Uint8Array): void {
      owned.terminal.write(input);
    }
    function click({ row, column }: Point): void {
      send(`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    }
    function* wait<T>(
      label: string,
      read: (frame: ReturnType<typeof viewport>) => T | undefined,
      ms: number,
    ): Operation<T> {
      return yield* race([
        (function* (): Operation<T> {
          while (true) {
            const next = changed;
            if (exited || ptyEnded) {
              throw new Error(`REPL exited while waiting for ${label}`);
            }
            const found = read(lastFrame());
            if (found !== undefined) {
              return found;
            }
            yield* next.operation;
          }
        })(),
        (function* (): Operation<never> {
          yield* sleep(ms);
          throw new Error(`Timed out waiting for ${label}`);
        })(),
      ]);
    }
    function waitFor(query: WaitOptions) {
      const { text, region, at, present = true, unique = false, timeout = ACTION_TIMEOUT } = query;
      const label =
        `${present ? "" : "absence of "}${JSON.stringify(text)} in ${region ?? "viewport"}` +
        (at === undefined ? "" : ` at row ${at.row}, column ${at.column}`);
      return wait(
        label,
        (frame) => {
          const box = frame.box(region);
          if (box === undefined) {
            return undefined;
          }
          const hits = [...frame.matches(text, box)].filter(
            (hit) => at === undefined || (at.row === hit.row && at.column === hit.column),
          );
          return present
            ? unique && hits.length !== 1
              ? undefined
              : hits[0]
            : hits.length === 0
              ? null
              : undefined;
        },
        timeout,
      );
    }

    function* exit() {
      const [code] = yield* all([until(owned.exited), eof.operation]);
      return { exitCode: code, location: reopenLocation(yield* save()) };
    }

    yield* provide({
      *execute(command) {
        if (command.action !== "stop") {
          step = command.action;
        }
        try {
          switch (command.action) {
            case "ready":
              return yield* wait(
                "the REPL screen",
                (frame) =>
                  frame.matches("XMD REPL").next().value && frame.matches("[exit]").next().value,
                START_TIMEOUT,
              );
            case "attachment-ready": {
              return yield* race([
                (function* () {
                  while (!(yield* exists(command.path))) {
                    yield* sleep(25);
                  }
                  return null;
                })(),
                (function* () {
                  const code = yield* until(owned.exited);
                  yield* eof.operation;
                  throw new Error(
                    `REPL exited (${code}) before publishing its Sidekick attachment`,
                  );
                })(),
                (function* () {
                  yield* sleep(START_TIMEOUT);
                  throw new Error("Timed out waiting for the Sidekick attachment");
                })(),
              ]);
            }
            case "focus": {
              const current = lastFrame();
              if (current.composerFocused) {
                return null;
              }
              if (current.sidekickControl() !== undefined) {
                click(
                  yield* wait(
                    "the Sidekick control",
                    (frame) => frame.sidekickControl(),
                    ACTION_TIMEOUT,
                  ),
                );
              } else if (current.composerLabel !== undefined) {
                click(current.composerLabel);
              }
              return yield* wait(
                "keyboard focus in the Sidekick composer",
                (frame) => (frame.composerFocused ? true : undefined),
                ACTION_TIMEOUT,
              );
            }
            case "type":
              if (command.text.includes("\x1b[201~")) {
                throw new Error("Text contains the terminal’s paste delimiter");
              }
              send(`\x1b[200~${command.text}\x1b[201~`);
              return null;
            case "key": {
              const key = parseKey(command.key);
              const encoded = backend.encodeKey(key);
              const input = encoded.length > 0 ? encoded : keyToAnsi(key);
              if (input.length === 0) {
                throw new Error(`Unknown key ${command.key}`);
              }
              send(input);
              return null;
            }
            case "click":
              if (command.at.row >= size.rows || command.at.column >= size.columns) {
                throw new Error("Click cell is outside the viewport");
              }
              click(command.at);
              return null;
            case "scroll": {
              if (command.delta === 0) {
                return null;
              }
              const box =
                command.region === undefined ? undefined : lastFrame().box(command.region);
              if (
                (command.region !== undefined && box === undefined) ||
                (command.at === undefined && box === undefined) ||
                command.region === "sidekick-composer"
              ) {
                throw new Error(`No visible scroll target in ${command.region ?? "viewport"}`);
              }
              const target = box ?? { left: 0, right: size.columns, top: 0, bottom: size.rows };
              const at = command.at ?? { row: target.top + 1, column: target.left + 1 };
              if (
                at.row < target.top ||
                at.row >= target.bottom ||
                at.column < target.left ||
                at.column >= target.right
              ) {
                throw new Error(`Wheel cell is outside ${command.region ?? "the viewport"}`);
              }
              const button = command.delta < 0 ? 64 : 65;
              send(
                `\x1b[<${button};${at.column + 1};${at.row + 1}M`.repeat(Math.abs(command.delta)),
              );
              return null;
            }
            case "wait":
              return yield* waitFor(command);
            case "resize":
              size = { columns: command.columns, rows: command.rows };
              backend.resize(size.columns, size.rows);
              owned.terminal.resize(size.columns, size.rows);
              return null;
            case "look":
              yield* save();
              return screen || lastFrame().text;
            case "exit":
              return yield* exit();
            case "stop":
              yield* stop();
              return null;
          }
        } catch (error) {
          throw new Error(
            `${step} failed: ${error instanceof Error ? error.message : String(error)}\nEvidence: ${directory}\n${screen || lastFrame().text}`,
          );
        }
      },
    });
  });
}
