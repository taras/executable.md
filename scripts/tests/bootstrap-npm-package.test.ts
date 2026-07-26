import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";

function* bootstrapSource(): Operation<string> {
  const document = yield* readTextFile(path.join(ROOT, "scripts/bootstrap-npm-package.md"));
  const start = document.indexOf("```bash exec\n");
  const end = document.indexOf("\n```", start);
  return document.slice(start + "```bash exec\n".length, end);
}

function* fakeNpm(state: "missing" | "bootstrap" | "unexpected"): Operation<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-npm-package-"));
  yield* ensure(() => rm(dir, { recursive: true, force: true }));

  const source = [
    "npm() {",
    '  printf "%s\\n" "$*" >> "$NPM_LOG"',
    '  case "$1" in',
    '    --version) echo "11.18.0" ;;',
    "    view)",
    '      case "$3" in',
    "        version)",
    '          case "$NPM_STATE" in',
    `            missing) echo "npm error E404" >&2; return 1 ;;`,
    `            bootstrap) echo "\\\"${BOOTSTRAP_VERSION}\\\"" ;;`,
    '            unexpected) echo "\\\"1.0.0\\\"" ;;',
    "          esac",
    "          ;;",
    `        dist-tags) echo '{"bootstrap":"${BOOTSTRAP_VERSION}"}' ;;`,
    "      esac",
    "      ;;",
    '    pack) echo "[]" ;;',
    "    publish) ;;",
    "    trust) ;;",
    "  esac",
    "}",
  ].join("\n");
  const file = path.join(dir, "npm.sh");
  yield* writeTextFile(file, source);
  return file;
}

function* runBootstrap(state: "missing" | "bootstrap" | "unexpected") {
  const envFile = yield* fakeNpm(state);
  const log = path.join(path.dirname(envFile), "npm.log");
  const result = yield* exec("bash", {
    arguments: ["-c", yield* bootstrapSource()],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      BASH_ENV: envFile,
      NPM_LOG: log,
      NPM_STATE: state,
      PACKAGE_DIR: "packages/acp",
      PUBLISH: "1",
    },
  }).join();
  return { result, log };
}

describe("bootstrap npm package", () => {
  it("publishes an absent bootstrap package before configuring trust", function* () {
    const { result, log } = yield* runBootstrap("missing");

    expect(result.code).toBe(0);
    const calls = yield* readTextFile(log);
    expect(calls).toContain("publish --access public --tag bootstrap");
    expect(calls).toContain("trust github @executablemd/acp");
  });

  it("resumes an existing bootstrap package by configuring trust", function* () {
    const { result, log } = yield* runBootstrap("bootstrap");

    expect(result.code).toBe(0);
    const calls = yield* readTextFile(log);
    expect(calls).not.toContain("publish --access public --tag bootstrap");
    expect(calls).toContain("trust github @executablemd/acp");
  });

  it("rejects a package that is not in the bootstrap state", function* () {
    const { result, log } = yield* runBootstrap("unexpected");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("version other than 0.0.0-bootstrap.0");
    const calls = yield* readTextFile(log);
    expect(calls).not.toContain("publish --access public --tag bootstrap");
    expect(calls).not.toContain("trust github @executablemd/acp");
  });
});
