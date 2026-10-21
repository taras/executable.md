import { OWNER_DIRECTORY, OWNER_ENTRY } from "./fixtures/repl/source-ownership.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  cliRuntime,
  cliShellCommand,
  runShell,
  shellQuote,
} from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { readdir, symlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { platformDataRoot } from "../src/repl-assembly.ts";
import { projectRepl } from "../src/repl/model.ts";
import { allocate, showing, showingAcross } from "./support/pty.ts";
import type { Pty } from "./support/pty.ts";

const ACT_MS = 30_000;
const REACH_MS = 180_000;

function greeting(which: "First" | "Second"): string {
  return `---\ndescription: ${which} greeting contract.\nprops:\n  type: object\n  properties:\n    from${which}: { type: string }\n  required: [from${which}]\n  additionalProperties: false\n---\n\n${which} greeting rendered.\n`;
}

function* click(pty: Pty, label: string): Operation<void> {
  const screen = yield* pty.shows();
  const row = screen.findIndex((line) => line.includes(label));
  if (row === -1) {
    throw new Error(`no ${label} control. screen=${JSON.stringify(screen)}`);
  }
  const column = screen[row].indexOf(label) + 1;
  yield* pty.type(`\x1b[<0;${column};${row + 1}M`);
  yield* pty.type(`\x1b[<0;${column};${row + 1}m`);
  yield* sleep(150);
}

function* submit(pty: Pty, source: string): Operation<void> {
  yield* click(pty, "Draft: ");
  yield* pty.type(source);
  yield* showing(pty, source.split("\n").at(-1) ?? source, ACT_MS);
  yield* pty.type("\r");
}

function* historyPath(home: string): Operation<string> {
  const directory = join(
    platformDataRoot(platform(), home, { XDG_DATA_HOME: join(home, "share") }, sep),
    "xmd",
    "repl",
  );
  const held = yield* until(readdir(directory));
  const single = held.find((name) => name.endsWith(".jsonl"));
  if (single !== undefined) {
    return join(directory, single);
  }
  const pairs = join(directory, "v1");
  const executions = yield* until(readdir(pairs));
  expect(executions).toHaveLength(1);
  return join(pairs, executions[0], "entries.jsonl");
}

function modelOf(bytes: string) {
  const events = bytes
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = parseDurableEvent(line);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    });
  const projected = projectRepl(events);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

function* completed(pty: Pty, history: string, count: number): Operation<string> {
  // Ready requires the journal close and the entry's joined teardown.
  yield* showing(pty, `Ready for Entry ${count + 1}`, ACT_MS);
  const bytes = yield* readTextFile(history);
  const model = modelOf(bytes);
  if (
    model.entries.length !== count ||
    model.entries.some((entry) => entry.terminal?.status !== "ok")
  ) {
    throw new Error(
      `entries never closed. history=${bytes} screen=${JSON.stringify(yield* pty.shows())}`,
    );
  }
  return bytes;
}

function* leave(pty: Pty): Operation<string> {
  yield* click(pty, "[exit]");
  const deadline = Date.now() + ACT_MS;
  while ((yield* pty.status()) === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`command never ended. screen=${JSON.stringify(yield* pty.shows())}`);
    }
    yield* sleep(150);
  }
  expect(yield* pty.status()).toBe(0);
  const screen = (yield* pty.shows()).join("\n");
  const found = screen.match(/xmd repl '(xmd:\/\/repl\/[^']+)'/);
  if (found?.[1] === undefined) {
    throw new Error(`no printed location. screen=${screen}`);
  }
  return found[1];
}

function* refused(pty: Pty, history: string, name: string): Operation<void> {
  const before = yield* readTextFile(history);
  yield* submit(pty, `<${name} />`);
  yield* showing(pty, "this entry cannot run here", ACT_MS);
  expect(yield* readTextFile(history)).toBe(before);
  yield* click(pty, "Draft: ");
  for (let at = 0; at < `<${name} />`.length; at += 1) {
    yield* pty.type("\x7f");
  }
}

describe("REPL includes through the production source terminal", () => {
  it("A3–A7: selected directories replace defaults, keep order and reopen retained work", function* () {
    const root = yield* useTempDirectory("xmd-i-");
    const workspace = join(root, "workspace");
    const first = join(root, "first");
    const second = join(root, "second");
    for (const directory of [join(workspace, "components"), join(first, "File"), second]) {
      yield* ensureDir(directory);
    }
    const external = '<File path="witness.txt">first-write</File>\n\nExternal-only rendered.\n';
    yield* writeTextFile(join(first, "Greeting.md"), greeting("First"));
    yield* writeTextFile(join(second, "Greeting.md"), greeting("Second"));
    yield* writeTextFile(join(first, "ExternalOnly.md"), external);
    yield* writeTextFile(join(workspace, "components", "Local.md"), "Local default rendered.\n");
    yield* writeTextFile(join(workspace, "RootLocal.md"), "Root default rendered.\n");
    for (const name of ["Syntax", "Evaluate", "File", "File/Delete", "Dir"]) {
      yield* writeTextFile(join(first, `${name}.md`), "POISON protected candidate\n");
    }
    let cache = "";
    if (cliRuntime() === "deno") {
      const info: unknown = JSON.parse((yield* runShell("deno info --json").expect()).stdout);
      if (
        typeof info !== "object" ||
        info === null ||
        !("denoDir" in info) ||
        typeof info.denoDir !== "string"
      ) {
        throw new Error("deno info supplied no prepared cache path");
      }
      cache = `DENO_DIR=${shellQuote(info.denoDir)} `;
    }
    const line = (args: string[]): string =>
      `cd ${shellQuote(workspace)} && ${cache}${cliShellCommand(["repl", ...args, "--deny-all"])}`;
    const includes = ["--include", "../first", `--include=${second}`];
    const home = join(root, "h1");
    yield* ensureDir(home);
    let location = "";
    let retained = "";
    let history = "";
    yield* scoped(function* () {
      const pty = yield* allocate(line(includes), home);
      yield* showing(pty, "Ready for Entry 1", REACH_MS);
      history = yield* historyPath(home);
      yield* submit(pty, '<Greeting fromFirst="ok" />\n<ExternalOnly />');
      retained = yield* completed(pty, history, 1);
      yield* showing(pty, "First greeting rendered.", ACT_MS);
      yield* showing(pty, "External-only rendered.", ACT_MS);
      expect(yield* readTextFile(join(workspace, "witness.txt"))).toBe("first-write");
      expect(modelOf(retained).terminal?.output).toContain("First greeting rendered.");
      yield* submit(
        pty,
        '<Syntax />\n<Syntax names={["Greeting", "Syntax", "Evaluate", "File", "File.Delete", "Dir"]} />',
      );
      retained = yield* completed(pty, history, 2);
      const syntax = modelOf(retained).terminal?.output ?? "";
      expect(syntax).toContain("../first/Greeting.md");
      expect(syntax).toContain("First greeting contract.");
      expect(syntax).not.toContain("Second greeting contract.");
      expect(syntax).not.toContain("<Local>");
      expect(syntax).not.toContain("<RootLocal>");
      expect(syntax).not.toContain("POISON");
      expect(syntax.match(/\(protected component\)/g)).toHaveLength(10);
      yield* refused(pty, history, "Local");
      yield* refused(pty, history, "RootLocal");
      location = yield* leave(pty);
      expect(yield* readTextFile(history)).toBe(retained);
    });

    yield* rm(first, { recursive: true });
    yield* rm(second, { recursive: true });
    yield* writeTextFile(join(workspace, "witness.txt"), "external edit survives");
    yield* scoped(function* () {
      const pty = yield* allocate(line([location, ...includes]), home);
      yield* showing(pty, "Ready for Entry 3", REACH_MS);
      yield* click(pty, "1. [ok]");
      yield* showing(pty, "First greeting rendered.", ACT_MS);
      yield* showing(pty, "External-only rendered.", ACT_MS);
      yield* showing(pty, "Source", ACT_MS);
      yield* showingAcross(pty, '<Greeting fromFirst="ok" />', ACT_MS);
      yield* showingAcross(pty, "<ExternalOnly />", ACT_MS);
      yield* leave(pty);
      expect(yield* readTextFile(join(workspace, "witness.txt"))).toBe("external edit survives");
      expect(yield* readTextFile(history)).toBe(retained);
    });

    yield* ensureDir(first);
    yield* ensureDir(second);
    yield* writeTextFile(join(first, "Greeting.md"), greeting("First"));
    yield* writeTextFile(join(second, "Greeting.md"), greeting("Second"));
    yield* writeTextFile(join(first, "ExternalOnly.md"), external);
    for (const reversed of [true, false]) {
      yield* scoped(function* () {
        const privateHome = join(root, reversed ? "h2" : "h3");
        yield* ensureDir(privateHome);
        const pty = yield* allocate(
          line(reversed ? [`--include=${second}`, "--include", "../first"] : []),
          privateHome,
        );
        yield* showing(pty, "Ready for Entry 1", REACH_MS);
        const history = yield* historyPath(privateHome);
        yield* submit(pty, reversed ? '<Greeting fromSecond="ok" />' : "<Local />\n<RootLocal />");
        const bytes = yield* completed(pty, history, 1);
        const output = modelOf(bytes).terminal?.output ?? "";
        if (reversed) {
          expect(output).toContain("Second greeting rendered.");
          expect(output).not.toContain("First greeting rendered.");
          yield* submit(pty, '<Syntax names={["Greeting"]} />');
          const syntax = modelOf(yield* completed(pty, history, 2)).terminal?.output ?? "";
          expect(syntax).toContain(join(second, "Greeting.md"));
          expect(syntax).toContain("Second greeting contract.");
          expect(syntax).not.toContain("First greeting contract.");
        } else {
          expect(output).toContain("Local default rendered.");
          expect(output).toContain("Root default rendered.");
          yield* submit(pty, '<Syntax names={["Local", "RootLocal"]} />');
          const syntax = modelOf(yield* completed(pty, history, 2)).terminal?.output ?? "";
          expect(syntax).toContain("**Origin:** `components/Local.md`");
          expect(syntax).toContain("**Origin:** `RootLocal.md`");
          expect(syntax).not.toContain("ExternalOnly");
          yield* refused(pty, history, "ExternalOnly");
          expect(yield* exists(join(workspace, "witness.txt"))).toBe(true);
          expect(yield* readTextFile(join(workspace, "witness.txt"))).toBe(
            "external edit survives",
          );
        }
        yield* leave(pty);
      });
    }
  });
});

describe("REPL sequential source owners through a real terminal (#976)", () => {
  it("SO3–SO4: inspect both nested calls, then reopen completed work in another process without repeating its provider", function* () {
    const root = yield* useTempDirectory("xmd-o-");
    const workspace = join(root, "workspace");
    const includes = join(root, "components");
    const home = join(root, "home");
    for (const directory of [workspace, includes, home]) {
      yield* ensureDir(directory);
    }
    yield* writeTextFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    yield* until(
      symlink(
        fileURLToPath(new URL("../../../node_modules", import.meta.url)),
        join(root, "node_modules"),
        "dir",
      ),
    );
    for (const file of ["OwnerWrapper.md", "OwnerLeaf.md", "OwnerAnswer.ts"]) {
      yield* writeTextFile(join(includes, file), yield* readTextFile(join(OWNER_DIRECTORY, file)));
    }
    let cache = "";
    if (cliRuntime() === "deno") {
      const info: unknown = JSON.parse((yield* runShell("deno info --json").expect()).stdout);
      if (
        typeof info !== "object" ||
        info === null ||
        !("denoDir" in info) ||
        typeof info.denoDir !== "string"
      ) {
        throw new Error("deno info supplied no prepared cache path");
      }
      cache = `DENO_DIR=${shellQuote(info.denoDir)} `;
    }
    const line = (args: string[]): string =>
      `cd ${shellQuote(workspace)} && ${cache}${cliShellCommand(["repl", ...args, "--include", includes, "--deny-all"])}`;
    const source = `<OwnerAnswer path="provider-calls.txt">\n${OWNER_ENTRY}\n</OwnerAnswer>`;
    let location = "";
    let history = "";
    let retained = "";
    function* activateKey(pty: Pty, label: string, occurrence = 0): Operation<void> {
      for (let step = 0; step < 160; step++) {
        const screen = yield* pty.shows();
        const matching = screen.filter((line) => {
          const at = line.indexOf(label);
          return at >= 0 && (!label.startsWith("component ") || at < 36);
        });
        const row = matching[occurrence];
        const focused = label.startsWith("component ")
          ? row !== undefined && row.slice(0, row.indexOf(label)).includes(">")
          : screen.some((line) => {
              for (let at = line.indexOf(">"); at !== -1; at = line.indexOf(">", at + 1)) {
                if (
                  line
                    .slice(at + 1)
                    .trimStart()
                    .replace(/^\* /, "")
                    .startsWith(label)
                ) {
                  return true;
                }
              }
              return false;
            });
        if (focused) {
          yield* pty.type("\r");
          yield* sleep(150);
          return;
        }
        yield* pty.type("\t");
        yield* sleep(40);
      }
      throw new Error(
        `focus never reached ${label} (${occurrence}): ${JSON.stringify(yield* pty.shows())}`,
      );
    }
    function* inspect(pty: Pty): Operation<void> {
      for (const [index, expected] of ["first", "second"].entries()) {
        yield* activateKey(pty, "component OwnerLeaf", index);
        yield* showingAcross(pty, '<OwnerWrapper input="first"', ACT_MS);
        yield* showingAcross(pty, '<OwnerWrapper input="second"', ACT_MS);
        yield* activateKey(pty, "Bindings");
        yield* activateKey(pty, "answered");
        yield* showing(pty, "[close]", ACT_MS);
        yield* showing(pty, JSON.stringify(expected), ACT_MS);
        yield* pty.type("\x1b");
        yield* sleep(150);
      }
      yield* activateKey(pty, "1. [ok]");
      yield* showing(pty, "first/second", ACT_MS);
      for (const name of ["first", "second"]) {
        yield* activateKey(pty, name);
        yield* showing(pty, "[close]", ACT_MS);
        yield* showing(pty, JSON.stringify(name), ACT_MS);
        yield* pty.type("\x1b");
        yield* sleep(150);
      }
    }
    function* finish(pty: Pty): Operation<string> {
      yield* activateKey(pty, "[exit]");
      const deadline = Date.now() + ACT_MS;
      while ((yield* pty.status()) === undefined) {
        if (Date.now() > deadline) {
          throw new Error("the terminal journey did not exit");
        }
        yield* sleep(150);
      }
      expect(yield* pty.status()).toBe(0);
      const screen = (yield* pty.shows()).join("\n");
      const found = screen.match(/xmd repl '(xmd:\/\/repl\/[^']+)'/);
      if (found?.[1] === undefined) {
        throw new Error(`no printed location: ${screen}`);
      }
      return found[1];
    }
    yield* scoped(function* () {
      const pty = yield* allocate(line([]), home);
      yield* showing(pty, "Ready for Entry 1", REACH_MS);
      history = yield* historyPath(home);
      yield* submit(pty, source);
      retained = yield* completed(pty, history, 1);
      expect(modelOf(retained).terminal?.output?.trim()).toBe("first/second");
      expect(yield* readTextFile(join(workspace, "provider-calls.txt"))).toBe("first\nsecond\n");
      yield* inspect(pty);
      location = yield* finish(pty);
    });
    yield* rm(includes, { recursive: true });
    yield* scoped(function* () {
      const pty = yield* allocate(line([location]), home);
      yield* showing(pty, "Ready for Entry 2", REACH_MS);
      yield* inspect(pty);
      yield* finish(pty);
    });
    expect(yield* readTextFile(history)).toBe(retained);
    expect(yield* readTextFile(join(workspace, "provider-calls.txt"))).toBe("first\nsecond\n");
    expect(modelOf(yield* readTextFile(history))).toEqual(modelOf(retained));
  });
});
