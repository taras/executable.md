import { main, until } from "effection";
import { openWorkspace } from "./workspace.ts";
import { execShell } from "./shell.ts";
import { createLoader, type ModuleSource } from "./loader.ts";

function usage(): never {
  console.error(
    [
      "usage: proof <db-path> <command> [args...]",
      "",
      "workspace ops (host capability, the declarative core's substrate):",
      "  fs-write <path> <body> | fs-read <path> | fs-mkdir <path> | fs-ls <path>",
      "",
      "imperative backends:",
      "  shell <command> [--cwd <dir>] [--env K=V] [--timeout <ms>]",
      "  js <entry-source> [--dep <name>=<source>] [--timeout <ms>]",
    ].join("\n"),
  );
  Deno.exit(2);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

main(function* () {
  const started = performance.now();
  const [dbPath, command, ...rest] = Deno.args;
  if (dbPath === undefined || command === undefined) {
    usage();
  }

  const workspace = openWorkspace(dbPath);
  let payload: Record<string, unknown>;

  switch (command) {
    case "fs-write":
      yield* until(workspace.fs.writeFile(rest[0], rest[1]));
      payload = { ok: true };
      break;
    case "fs-read":
      payload = { body: yield* until(workspace.fs.readFile(rest[0], "utf8")) };
      break;
    case "fs-mkdir":
      yield* until(workspace.fs.mkdir(rest[0], { recursive: true }));
      payload = { ok: true };
      break;
    case "fs-ls": {
      const entries = yield* until(workspace.fs.readdir(rest[0]));
      payload = { entries: entries.map((entry) => entry.name).sort() };
      break;
    }
    case "shell": {
      const script = rest[0];
      if (script === undefined) {
        usage();
      }
      const envPairs = rest
        .filter((_, index) => rest[index - 1] === "--env")
        .map((pair) => pair.split("="));
      const timeout = parseFlag(rest, "--timeout");
      const result = yield* execShell(workspace.fs, script, {
        cwd: parseFlag(rest, "--cwd"),
        env: Object.fromEntries(envPairs),
        timeoutMs: timeout === undefined ? undefined : Number(timeout),
      });
      payload = { ...result };
      break;
    }
    case "js": {
      const source = rest[0];
      if (source === undefined) {
        usage();
      }
      const modules: Record<string, ModuleSource> = { "entry.js": source };
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] !== "--dep") {
          continue;
        }
        const spec = rest[index + 1] ?? "";
        const separator = spec.indexOf("=");
        modules[spec.slice(0, separator)] = spec.slice(separator + 1);
      }
      const timeout = parseFlag(rest, "--timeout");
      const loader = createLoader({
        fsHandlers: {
          readFile: (path: string, encoding: "utf8") =>
            workspace.fs.readFile(path, encoding),
          writeFile: (path: string, body: string) =>
            workspace.fs.writeFile(path, body),
          mkdir: (path: string, options: { recursive?: boolean }) =>
            workspace.fs.mkdir(path, options),
          readdir: async (path: string) =>
            (await workspace.fs.readdir(path)).map((entry) => entry.name),
          stat: (path: string) => workspace.fs.stat(path),
          rm: (path: string, options: { recursive?: boolean }) =>
            workspace.fs.rm(path, options),
        },
      });
      const run = loader.load({ mainModule: "entry.js", modules })
        .getEntrypoint();
      payload = {
        ...(yield* until(
          run.run({ timeoutMs: timeout === undefined ? 5000 : Number(timeout) }),
        )),
      };
      break;
    }
    default:
      usage();
  }

  workspace.storage.close();
  const ms = Math.round((performance.now() - started) * 100) / 100;
  console.log(JSON.stringify({ command, ...payload, ms }));
});
