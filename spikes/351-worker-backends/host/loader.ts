// A Deno port of Cloudflare's WorkspaceRuntimeLoader.
//
// Upstream's contract (packages/computer/src/runtime/types.ts:70) is
// `load({ mainModule, modules, ... }) => { getEntrypoint() }`, where `modules`
// is an in-memory specifier→source map. Cloudflare implements it with the
// Workers Dynamic Worker Loader; this port implements it with a Deno Worker.
//
// Two mechanics carry the port:
//
//   1. The module graph is supplied as blob: URLs, with each module's import
//      specifiers rewritten to the absolute blob: URL of the module they name.
//      A relative specifier does not resolve from a blob: base — Deno reports
//      "invalid URL: relative URL with a cannot-be-a-base base" — so the
//      loader resolves the graph itself, in topological order, before minting
//      each blob. Nothing is materialized to disk.
//
//   2. The filesystem capability crosses as an async postMessage RPC. The DOFS
//      handle is a node:sqlite DatabaseSync that cannot be structured-cloned,
//      so the host keeps it and services calls; this mirrors upstream, where
//      the same capability crosses as a Workers RPC stub.
//
// Isolation is the Deno Worker's `permissions: "none"`, which governs Deno ops
// but NOT the module loader: under `deno run` a locked worker can still import
// jsr:/npm: specifiers. A compiled artifact's frozen module graph closes that
// (see evidence/EVIDENCE.md). Ship compiled; never present `deno run` as a
// sandbox.

export type ModuleSource = string | { js?: string };

export interface LoaderCode {
  mainModule: string;
  modules: Record<string, ModuleSource>;
}

export interface RunOptions {
  input?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RunOutcome = "exit" | "timeout" | "cancelled" | "worker-error";

export interface RunResult {
  outcome: RunOutcome;
  stdout: string;
  stderr: string;
  result: unknown;
  exitCode: number | undefined;
}

// Handlers receive the argument list the worker sent; each host installs the
// operations it is willing to expose, which is the capability surface.
export type FsHandlers = Record<
  string,
  // deno-lint-ignore no-explicit-any
  (...args: any[]) => Promise<unknown> | unknown
>;

export interface Loader {
  load(code: LoaderCode): {
    getEntrypoint(): { run(options?: RunOptions): Promise<RunResult> };
  };
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createLoader(options: { fsHandlers: FsHandlers }): Loader {
  return {
    load(code: LoaderCode) {
      return {
        getEntrypoint() {
          return {
            run(runOptions: RunOptions = {}) {
              return runOnce(code, runOptions, options.fsHandlers);
            },
          };
        },
      };
    },
  };
}

function sourceOf(module: ModuleSource): string {
  return typeof module === "string" ? module : module.js ?? "";
}

function resolveSpecifier(
  specifier: string,
  modules: Record<string, ModuleSource>,
): string | undefined {
  const candidates = [
    specifier,
    specifier.replace(/^\.\//, ""),
    `${specifier}.js`,
    `${specifier.replace(/^\.\//, "")}.js`,
  ];
  return candidates.find((candidate) => candidate in modules);
}

const SPECIFIER_PATTERN = /(?:from|import\s*\(?)\s*["']([^"']+)["']/g;
const REWRITE_PATTERN = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

function topologicalOrder(
  modules: Record<string, ModuleSource>,
  entry: string,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (name: string) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    for (const match of sourceOf(modules[name]).matchAll(SPECIFIER_PATTERN)) {
      const target = resolveSpecifier(match[1], modules);
      if (target !== undefined && target !== name) {
        visit(target);
      }
    }
    order.push(name);
  };
  visit(entry);
  return order;
}

function buildGraph(
  modules: Record<string, ModuleSource>,
  mainModule: string,
): { entryUrl: string; urls: string[] } {
  const urls = new Map<string, string>();
  const created: string[] = [];
  for (const name of topologicalOrder(modules, mainModule)) {
    const rewritten = sourceOf(modules[name]).replace(
      REWRITE_PATTERN,
      (whole, lead: string, quote: string, specifier: string) => {
        const target = resolveSpecifier(specifier, modules);
        if (target === undefined) {
          return whole;
        }
        return `${lead}${quote}${urls.get(target)}${quote}`;
      },
    );
    const url = URL.createObjectURL(
      new Blob([rewritten], { type: "application/javascript" }),
    );
    urls.set(name, url);
    created.push(url);
  }
  const entryUrl = urls.get(mainModule);
  if (entryUrl === undefined) {
    throw new Error(`main module ${mainModule} is not in the module map`);
  }
  return { entryUrl, urls: created };
}

// The runner mirrors upstream's runtimeWorkerModule(): it installs the
// capability bridge and a process/console shim, imports the user entry, calls
// its default export, and frames stdout/stderr/result/exit.
function runnerSource(entryUrl: string, input: unknown): string {
  return `
import * as user from ${JSON.stringify(entryUrl)};

let seq = 0;
const pending = new Map();
self.addEventListener("message", (event) => {
  const message = event.data;
  if (message && message.kind === "fs-reply") {
    const slot = pending.get(message.id);
    if (slot === undefined) return;
    pending.delete(message.id);
    if (message.error) slot.reject(new Error(message.error));
    else slot.resolve(message.value);
  }
});
function call(op, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    self.postMessage({ kind: "fs-call", id, op, args });
  });
}
globalThis.workspace = {
  readFile: (path, encoding) => call("readFile", [path, encoding ?? "utf8"]),
  writeFile: (path, body) => call("writeFile", [path, body]),
  mkdir: (path, options) => call("mkdir", [path, options ?? { recursive: true }]),
  readdir: (path) => call("readdir", [path]),
  stat: (path) => call("stat", [path]),
  rm: (path, options) => call("rm", [path, options ?? {}]),
  symlink: (target, path) => call("symlink", [target, path]),
};

function frame(name, text) {
  self.postMessage({ kind: "frame", name, text: String(text) });
}
const format = (args) =>
  args
    .map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ") + "\\n";
console.log = console.info = (...args) => frame("stdout", format(args));
console.warn = console.error = (...args) => frame("stderr", format(args));
globalThis.process = {
  env: {},
  argv: ["workspace", "entry"],
  cwd: () => "/workspace",
  stdout: { write: (chunk) => frame("stdout", chunk) },
  stderr: { write: (chunk) => frame("stderr", chunk) },
};

const input = ${JSON.stringify(input ?? null)};
try {
  const value = typeof user.default === "function"
    ? await user.default(input)
    : user.default ?? null;
  self.postMessage({ kind: "frame", name: "result", value: value ?? null });
  self.postMessage({ kind: "frame", name: "exit", code: 0 });
} catch (error) {
  frame("stderr", String(error && error.stack ? error.stack : error) + "\\n");
  self.postMessage({ kind: "frame", name: "exit", code: 1 });
}
`;
}

function runOnce(
  code: LoaderCode,
  options: RunOptions,
  fsHandlers: FsHandlers,
): Promise<RunResult> {
  const graph = buildGraph(code.modules, code.mainModule);
  const runnerUrl = URL.createObjectURL(
    new Blob([runnerSource(graph.entryUrl, options.input)], {
      type: "application/javascript",
    }),
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  let result: unknown;
  let exitCode: number | undefined;

  const worker = new Worker(runnerUrl, {
    type: "module",
    deno: { permissions: "none" },
  });

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (outcome: RunOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // terminate() reclaims the worker unless user code is spinning on the
      // CPU, which Deno cannot preempt — see EVIDENCE.md gap 1.
      worker.terminate();
      for (const url of [...graph.urls, runnerUrl]) {
        URL.revokeObjectURL(url);
      }
      resolve({
        outcome,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        result,
        exitCode,
      });
    };

    const timer = setTimeout(
      () => finish("timeout"),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    options.signal?.addEventListener("abort", () => finish("cancelled"));

    worker.onmessage = async (event: MessageEvent) => {
      const message = event.data;
      if (message.kind === "frame") {
        if (message.name === "stdout") {
          stdout.push(message.text);
        } else if (message.name === "stderr") {
          stderr.push(message.text);
        } else if (message.name === "result") {
          result = message.value;
        } else if (message.name === "exit") {
          exitCode = message.code;
          finish("exit");
        }
        return;
      }
      if (message.kind === "fs-call") {
        const handler = fsHandlers[message.op];
        try {
          if (handler === undefined) {
            throw new Error(`unsupported filesystem op: ${message.op}`);
          }
          const value = await handler(...message.args);
          worker.postMessage({ kind: "fs-reply", id: message.id, value });
        } catch (error) {
          worker.postMessage({
            kind: "fs-reply",
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      stderr.push(`${event.message}\n`);
      exitCode = 1;
      finish("worker-error");
    };
  });
}
