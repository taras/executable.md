import { FetchApi } from "@effectionx/fetch";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { Stdio } from "@effectionx/process";
import { collect, execute, fileSource, useNormalizedOutput } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { cliRuntime } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { call, scoped, stream, until, type Operation, type Yielded } from "effection";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { z } from "zod";
import { useCompositionComponents } from "../../../packages/git/src/composition/installation.ts";
import { gitHubSource } from "../../../packages/git/src/deno/composition/github.ts";
import { useRunComposition } from "../../../packages/git/src/deno/run-composition/provider.ts";
import { remoteBranch, useBareRemote } from "../../../packages/git/tests/support/git-remotes.ts";
import {
  creations,
  fakeGitHubAccess,
  gitHubStore,
} from "../../../packages/git/tests/support/github.ts";
import {
  countingOrdinaryHost,
  raised,
  rewritingHost,
  useManagedRoot,
  useNamedOriginCheckout,
} from "../../../packages/git/tests/support/run-composition.ts";
import { sha256 } from "../lib/publication-receipt.ts";
import {
  compareTypingRuns,
  EDITS,
  VIEWPORT,
  WARMUP,
  WORKLOADS,
} from "../lib/typing-latency-report.ts";

const document = fileURLToPath(new URL("../publish-evidence.md", import.meta.url));
const components = fileURLToPath(new URL("../components", import.meta.url));
const repository = "octo/project";
const base = "a".repeat(40);
const head = "b".repeat(40);
const imageNames = ["repl-ui-checkpoint-before.png", "repl-ui-checkpoint-after.png"];
const images = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
].map((image) => Uint8Array.from(atob(image), (character) => character.charCodeAt(0)));
const urls = images.map(
  (_, index) =>
    `https://github.com/user-attachments/assets/${index + 1}0000000-0000-0000-0000-000000000000`,
);
const oversizedProse = "x".repeat(65_500);
const beforeProse = "# Prepared change\r\n\r\n  Leading text  \n\n";
const afterProse = "\r\n\r\n  More prose\n\n\n";

function typingRun(revision: string, offset: number) {
  return {
    revision,
    stdout: WORKLOADS.map(
      (workload) =>
        `XMD_TYPING_SAMPLE ${JSON.stringify({
          revision,
          runtime: { deno: "2.9.7", v8: "14", typescript: "5" },
          host: { os: "darwin", arch: "arm64" },
          viewport: VIEWPORT,
          workload,
          warmup: WARMUP,
          samples: Array.from({ length: EDITS }, (_, index) => ({
            edit: index + 1,
            milliseconds: index + offset,
            writes: 1,
          })),
        })}`,
    ).join("\n"),
  };
}

function timingReport(baseSha: string, headSha: string) {
  return compareTypingRuns(typingRun(baseSha, 2), typingRun(headSha, 1));
}

function* useFixture(baseSha = base, headSha = head) {
  const directory = yield* useTempDirectory("xmd-repl-publication-test-");
  const pins = {
    repository,
    baseBranch: "main",
    headBranch: "feature",
    base: baseSha,
    head: headSha,
  };
  const checkpoint = {
    id: "checkpoint",
    fixture: "synthetic | composer",
    viewport: { columns: 72, rows: 20 },
    action: "Jump to <Transcript>",
  };
  const receipt = {
    version: 1,
    ...pins,
    acceptance: [
      {
        name: "journey",
        kind: "acceptance",
        status: "passed",
        revision: headSha,
        source: "acceptance.txt",
      },
      { name: "tests", kind: "test", status: "passed", revision: headSha, source: "tests.txt" },
    ],
    checkpoints: [checkpoint],
    captures: ["before", "after"].map((role, index) => ({
      ...checkpoint,
      checkpoint: checkpoint.id,
      role,
      revision: index === 0 ? baseSha : headSha,
      synthetic: true,
      approved: true,
      path: `operator-capture-${index}.png`,
      sha256: sha256(images[index]),
    })),
    timingReport: "typing.json",
    target: { kind: "numbered", number: 7 },
    previewBody: "preview.md",
  };
  const paths = receipt.captures.map(({ path }) => join(directory, path));
  for (const [index, path] of paths.entries()) {
    yield* until(writeFile(path, images[index]));
  }
  const timing = timingReport(baseSha, headSha);
  yield* writeTextFile(join(directory, "typing.json"), JSON.stringify(timing));
  yield* writeTextFile(join(directory, "preview.md"), "");
  const path = join(directory, "receipt.json");
  yield* writeTextFile(path, JSON.stringify(receipt));
  return { directory, path, paths, receipt, timing, pins };
}

type Fixture = Yielded<ReturnType<typeof useFixture>>;

function snapshot(fixture: Fixture, body = "", number = 7) {
  const { pins } = fixture;
  return {
    number,
    html_url: `https://github.com/${repository}/pull/${number}`,
    state: "open",
    draft: true,
    body,
    base: { ref: pins.baseBranch, sha: pins.base, repo: { full_name: repository } },
    head: { ref: pins.headBranch, sha: pins.head, repo: { full_name: repository } },
  };
}

function unavailable(): never {
  throw new Error("Only streamed attachment reads are expected");
}

function modeledHost(initial: () => ReturnType<typeof snapshot>) {
  let existing: ReturnType<typeof snapshot> | undefined;
  const events: string[] = [];
  const calls: string[][] = [];
  const edits: { argv: string[]; text: string; images: { path: string; sha256: string }[] }[] = [];
  const bytes = new Map<string, Uint8Array>();
  const redirects = new Map<string, string>();
  const host = {
    events,
    calls,
    edits,
    bytes,
    redirects,
    help: true,
    stopAfter: Infinity,
    staleAfterEdit: false,
    get draft() {
      existing ??= initial();
      return existing;
    },
    *install(beforeEdit?: () => Operation<void>) {
      const encode = new TextEncoder();
      yield* API.Process.around({
        *exec([options], next) {
          const cmd = options.command;
          if (cmd[0] !== "gh") {
            return yield* next(options);
          }
          calls.push(cmd);
          let code = 0;
          if (cmd[3] === "--help") {
            events.push("help");
            expect(cmd).toEqual(["gh", "pr", "edit", "--help"]);
            expect(options.env?.GH_PROMPT_DISABLED).toBe("1");
            yield* Stdio.operations.stdout(
              encode.encode(host.help ? "      --attach file\n" : "usage\n"),
            );
          } else if (cmd[1] === "api") {
            events.push("read");
            expect(cmd).toEqual([
              "gh",
              "api",
              "--hostname",
              "github.com",
              `repos/${repository}/pulls/${cmd[4].split("/").at(-1)}`,
            ]);
            yield* Stdio.operations.stdout(encode.encode(JSON.stringify(host.draft)));
          } else {
            events.push("edit");
            expect(cmd.slice(0, 8)).toEqual([
              "gh",
              "pr",
              "edit",
              String(host.draft.number),
              "--repo",
              `github.com/${repository}`,
              "--body-file",
              cmd[7],
            ]);
            if (beforeEdit !== undefined) {
              yield* beforeEdit();
            }
            const text = yield* readTextFile(cmd[7]);
            const staged = [];
            let modified = text;
            for (let at = 8; at < cmd.length; at += 2) {
              expect(cmd[at]).toBe("--attach");
              const path = cmd[at + 1];
              const file = basename(path);
              const index = imageNames.indexOf(file);
              expect(index).toBeGreaterThanOrEqual(0);
              const uploaded = yield* until(readFile(path));
              staged.push({ path, sha256: sha256(uploaded) });
              if (staged.length <= host.stopAfter) {
                bytes.set(urls[index], uploaded);
                modified = modified.replace(`](./${file})`, `](${urls[index]})`);
              } else {
                code = 1;
              }
            }
            edits.push({ argv: cmd, text, images: staged });
            host.draft.body = modified;
            if (host.staleAfterEdit) {
              host.draft.head.sha = "f".repeat(40);
            }
            yield* Stdio.operations.stderr(encode.encode("untrusted diagnostic /private/path"));
          }
          return { exitCode: code, stdout: undefined, stderr: undefined };
        },
      });
      yield* FetchApi.around({
        fetch: ([input, init]) =>
          call(() => {
            expect(init?.redirect).toBe("manual");
            const url = String(input);
            events.push(`image:${url}`);
            const image = bytes.get(url) ?? new Uint8Array();
            const destination = redirects.get(url);
            const response =
              destination === undefined
                ? new Response(new Uint8Array(image), { status: bytes.has(url) ? 200 : 404 })
                : new Response(null, { status: 302, headers: { location: destination } });
            return {
              raw: response,
              status: response.status,
              ok: response.ok,
              headers: response.headers,
              statusText: "",
              redirected: false,
              type: response.type,
              url,
              bodyUsed: false,
              body: () => stream(response.body ?? new ReadableStream<Uint8Array>()),
              json: unavailable,
              text: unavailable,
              blob: unavailable,
              formData: unavailable,
              arrayBuffer: unavailable,
              expect: unavailable,
            };
          }),
      });
    },
  };
  return host;
}

const output = z.object({
  status: z.string().optional(),
  markdown: z.string().optional(),
  images: z.array(z.string()).optional(),
  identity: z.string(),
  exitCode: z.number().nullable().optional(),
  target: z.object({ number: z.number(), url: z.string(), head: z.string() }).optional(),
  slots: z
    .array(z.object({ state: z.string(), sha256: z.string(), url: z.string().optional() }))
    .optional(),
});

function run(
  fixture: Fixture,
  host: ReturnType<typeof modeledHost>,
  mode: "dry-run" | "publish" = "publish",
  setup?: { directory: string; install: () => Operation<void>; beforeEdit: () => Operation<void> },
) {
  return scoped(function* () {
    yield* API.Env.around({
      cwd: () => call(() => setup?.directory ?? fixture.directory),
    });
    yield* useHostFiles();
    yield* useComponentModuleLoader();
    yield* useNormalizedOutput();
    yield* useCompositionComponents();
    if (setup !== undefined) {
      yield* setup.install();
    }
    yield* host.install(setup?.beforeEdit);
    return output.parse(
      yield* collect(
        yield* execute({
          ...fileSource(document),
          includes: [components],
          props: { mode, receipt: fixture.path },
          stream: new InMemoryStream(),
        }),
      ),
    );
  });
}

function* preview(fixture: Fixture) {
  const result = yield* run(
    fixture,
    modeledHost(() => snapshot(fixture)),
    "dry-run",
  );
  return z.string().parse(result.markdown);
}

describe("REPL UI evidence publication", () => {
  it("reproduces the local preview with the actual entry and only preflights the CLI", function* () {
    const input = yield* useFixture();
    const host = modeledHost(() => snapshot(input));
    yield* writeTextFile(join(input.directory, "preview.md"), afterProse);
    const one = yield* run(input, host, "dry-run");
    const two = yield* run(input, host, "dry-run");
    expect(two).toEqual(one);
    expect(one.markdown?.endsWith(afterProse)).toBe(true);
    expect(one.markdown).toContain("| Checkpoint | Fixture | Viewport | Action | Before | After |");
    expect(one.markdown).toContain("synthetic &#124; composer");
    expect(one.markdown).toContain("| small | 30 |");
    expect(one.markdown).not.toContain(input.directory);
    expect(one.images).toEqual(input.paths);
    expect(host.events).toEqual(["help", "help"]);
  });

  it("rejects a generated description over the body limit in preview and numbered publish", function* () {
    const input = yield* useFixture();
    const host = modeledHost(() => snapshot(input, oversizedProse));
    yield* writeTextFile(join(input.directory, "preview.md"), oversizedProse);
    const diagnostic = "The proposed draft description exceeds the GitHub body limit.";
    expect(String(yield* raised(run(input, host, "dry-run")))).toContain(diagnostic);
    expect(host.events).toEqual(["help"]);
    host.events.length = 0;
    expect(String(yield* raised(run(input, host)))).toContain(diagnostic);
    expect(host.events).toEqual(["help", "read"]);
  });

  it("publishes a PNG with final IDAT padding without changing its approved bytes", function* () {
    const input = yield* useFixture();
    const padded = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAEElEQVR4nGP4z8AAAAMBAQAAAAAAOUhUywAAAABJRU5ErkJggg==",
      ),
      (character) => character.charCodeAt(0),
    );
    const digest = sha256(padded);
    yield* until(writeFile(input.paths[0], padded));
    yield* writeTextFile(
      input.path,
      JSON.stringify({
        ...input.receipt,
        captures: [{ ...input.receipt.captures[0], sha256: digest }, input.receipt.captures[1]],
      }),
    );
    const host = modeledHost(() => snapshot(input));
    const result = yield* run(input, host);
    expect(result.status).toBe("complete");
    expect(host.edits[0].images[0].sha256).toBe(digest);
    expect(host.bytes.get(urls[0])).toEqual(padded);
  });

  it("requires a well-formed palette for indexed PNG evidence", function* () {
    const input = yield* useFixture();
    const host = modeledHost(() => snapshot(input));
    const rejected = [
      // missing
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
      // duplicate
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEX/AAAZ4gk3AAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
      // late
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAANQTFRF/wAAGeIJNwAAAABJRU5ErkJggg==",
      // empty
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAAFBMVEVLqIlVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
      // partial entry
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAABFBMVEUAAAAAtKOuegAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=",
      // too many entries for the bit depth
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAACVBMVEUAAAAAAAAAAACDY+nAAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
    ];
    const control =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
    for (const encoded of [...rejected, control]) {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const digest = sha256(bytes);
      yield* until(writeFile(input.paths[0], bytes));
      yield* writeTextFile(
        input.path,
        JSON.stringify({
          ...input.receipt,
          captures: [{ ...input.receipt.captures[0], sha256: digest }, input.receipt.captures[1]],
        }),
      );
      if (encoded !== control) {
        expect(String(yield* raised(run(input, host, "dry-run")))).toContain(
          "Screenshot checkpoint-before must be a PNG matching its approved SHA-256.",
        );
        expect(host.calls).toEqual([]);
      } else {
        expect((yield* run(input, host)).status).toBe("complete");
        expect(host.edits[0].images[0].sha256).toBe(digest);
        expect(host.bytes.get(urls[0])).toEqual(bytes);
      }
    }
  });

  it("publishes only staged images and preserves bytes on both sides of the evidence", function* () {
    const input = yield* useFixture();
    const section = yield* preview(input);
    const host = modeledHost(() => snapshot(input, beforeProse + section + afterProse));
    const result = yield* run(input, host);
    expect(result.status).toBe("complete");
    expect(result.target).toEqual({
      number: 7,
      url: "https://github.com/octo/project/pull/7",
      head,
    });
    expect(host.events).toEqual([
      "help",
      "read",
      "edit",
      "read",
      ...urls.map((url) => `image:${url}`),
    ]);
    expect(host.edits[0].text).toBe(beforeProse + section + afterProse);
    expect(host.edits[0].images.map((image) => image.sha256)).toEqual(images.map(sha256));
    expect(host.edits[0].images.map(({ path }) => basename(path))).toEqual(imageNames);
    expect(host.edits[0].images.map(({ path }) => path)).not.toEqual(input.paths);
    expect(host.draft.body).toBe(
      beforeProse +
        section.replace(`./${imageNames[0]}`, urls[0]).replace(`./${imageNames[1]}`, urls[1]) +
        afterProse,
    );
  });

  it("rejects mismatched targets before editing and detects a stale head after the edit", function* () {
    const input = yield* useFixture();
    const mismatches = [
      { ...snapshot(input), html_url: "https://github.com/octo/project/pull/8" },
      { ...snapshot(input), number: 8 },
      { ...snapshot(input), draft: false },
      { ...snapshot(input), state: "closed" },
      { ...snapshot(input), head: { ...snapshot(input).head, ref: "different" } },
      { ...snapshot(input), head: { ...snapshot(input).head, sha: base } },
      { ...snapshot(input), base: { ...snapshot(input).base, sha: head } },
      { ...snapshot(input), base: { ...snapshot(input).base, ref: "different" } },
      {
        ...snapshot(input),
        head: { ...snapshot(input).head, repo: { full_name: "someone/fork" } },
      },
      {
        ...snapshot(input),
        base: { ...snapshot(input).base, repo: { full_name: "someone/fork" } },
      },
    ];
    for (const wrong of mismatches) {
      const host = modeledHost(() => wrong);
      const result = yield* run(input, host);
      expect(result.status).toBe("unverifiable");
      expect(host.events).toEqual(["help", "read"]);
      expect(host.calls[1][4]).toBe("repos/octo/project/pulls/7");
    }
    const stale = modeledHost(() => snapshot(input));
    stale.staleAfterEdit = true;
    expect((yield* run(input, stale)).status).toBe("unverifiable");
    expect(stale.events).toEqual(["help", "read", "edit", "read"]);
  });

  it("refuses invalid local evidence before calling the process boundary", function* () {
    const input = yield* useFixture();
    const host = modeledHost(() => snapshot(input));
    const original = input.receipt;
    const badCaptures = [
      original.captures.slice(1),
      [{ ...original.captures[0], synthetic: false }, original.captures[1]],
      [{ ...original.captures[0], approved: false }, original.captures[1]],
      [{ ...original.captures[0], sha256: "0".repeat(64) }, original.captures[1]],
      [{ ...original.captures[0], action: "different" }, original.captures[1]],
      [{ ...original.captures[0], fixture: "different" }, original.captures[1]],
      [{ ...original.captures[0], revision: head }, original.captures[1]],
      [{ ...original.captures[0], viewport: { columns: 160, rows: 36 } }, original.captures[1]],
    ];
    for (const captures of badCaptures) {
      yield* writeTextFile(input.path, JSON.stringify({ ...original, captures }));
      yield* raised(run(input, host));
    }
    for (const invalid of [{ revision: base }, { status: "failed" }]) {
      const acceptance = [{ ...original.acceptance[0], ...invalid }, original.acceptance[1]];
      yield* writeTextFile(input.path, JSON.stringify({ ...original, acceptance }));
      yield* raised(run(input, host));
    }
    yield* writeTextFile(input.path, JSON.stringify(original));
    for (const invalid of [
      { medianMs: 0 },
      { revision: base },
      { viewport: { columns: 72, rows: 20 } },
      { runtime: { deno: "another", v8: "14", typescript: "5" } },
      { host: { os: "linux", arch: "x86" } },
      { workload: { name: "small", rounds: 52, linesPerRound: 32 } },
      { count: 40 },
    ]) {
      const broken = structuredClone(input.timing);
      Object.assign(broken.workloads[0].candidate, invalid);
      yield* writeTextFile(join(input.directory, "typing.json"), JSON.stringify(broken));
      yield* raised(run(input, host));
    }
    yield* writeTextFile(join(input.directory, "typing.json"), JSON.stringify(input.timing));
    const brokenImage = new TextEncoder().encode("not a PNG");
    yield* until(writeFile(input.paths[0], brokenImage));
    yield* writeTextFile(
      input.path,
      JSON.stringify({
        ...original,
        captures: [{ ...original.captures[0], sha256: sha256(brokenImage) }, original.captures[1]],
      }),
    );
    yield* raised(run(input, host));
    const corruptImage = images[0].slice();
    const chunk = new DataView(corruptImage.buffer);
    const idat = 33;
    expect(chunk.getUint32(idat + 4)).toBe(0x49444154);
    const checksum = idat + 8 + chunk.getUint32(idat);
    corruptImage.fill(0, idat + 8, checksum);
    chunk.setUint32(checksum, crc32(corruptImage.subarray(idat + 4, checksum)));
    yield* until(writeFile(input.paths[0], corruptImage));
    yield* writeTextFile(
      input.path,
      JSON.stringify({
        ...original,
        captures: [{ ...original.captures[0], sha256: sha256(corruptImage) }, original.captures[1]],
      }),
    );
    yield* raised(run(input, host, "dry-run"));
    expect(host.calls).toEqual([]);
    yield* until(writeFile(input.paths[0], images[0]));
    const link = join(input.directory, "link.png");
    yield* until(symlink(input.paths[1], link));
    yield* writeTextFile(
      input.path,
      JSON.stringify({
        ...original,
        captures: [original.captures[0], { ...original.captures[1], path: link }],
      }),
    );
    yield* raised(run(input, host));
    expect(host.calls).toEqual([]);
  });

  it("reads a nonzero partial edit, retries the pending image and leaves completion unchanged", function* () {
    const input = yield* useFixture();
    const host = modeledHost(() => snapshot(input, afterProse));
    host.stopAfter = 1;
    const partial = yield* run(input, host);
    expect(host.events).toEqual(["help", "read", "edit", "read", `image:${urls[0]}`]);
    expect(partial.status).toBe("partial");
    expect(partial.exitCode).toBe(1);
    expect(partial.slots).toEqual([
      { state: "verified", url: urls[0], sha256: sha256(images[0]) },
      { state: "pending", sha256: sha256(images[1]) },
    ]);
    expect(host.draft.body).toContain(`./${imageNames[1]}`);
    expect(host.draft.body).not.toContain(input.directory);
    expect(host.draft.body).not.toContain(host.edits[0].images[0].path);
    expect(JSON.stringify(partial)).not.toContain("/private/path");

    const interruptedSnapshot = structuredClone(host.draft);
    const interrupted = modeledHost(() => interruptedSnapshot);
    interrupted.bytes.set(urls[0], images[0]);
    host.stopAfter = Infinity;
    for (const retry of [host, interrupted]) {
      retry.events.length = 0;
      const complete = yield* run(input, retry);
      expect(retry.events).toEqual([
        "help",
        "read",
        `image:${urls[0]}`,
        "edit",
        "read",
        ...urls.map((url) => `image:${url}`),
      ]);
      expect(complete.status).toBe("complete");
      expect(complete.identity).toBe(partial.identity);
      expect(retry.edits.at(-1)?.images.map(({ path }) => basename(path))).toEqual([imageNames[1]]);
      expect(retry.edits.at(-1)?.text).toContain(urls[0]);
      const settledBody = retry.draft.body;
      retry.events.length = 0;
      const unchanged = yield* run(input, retry);
      expect(unchanged.status).toBe("complete");
      expect(unchanged.identity).toBe(complete.identity);
      expect(retry.events).toEqual(["help", "read", ...urls.map((url) => `image:${url}`)]);
      expect(retry.draft.body).toBe(settledBody);
    }
  });

  it("refuses swapped bytes, misplaced images and aliases of staged destinations", function* () {
    const input = yield* useFixture();
    const section = yield* preview(input);
    const swapped = section
      .replace(`./${imageNames[0]}`, urls[1])
      .replace(`./${imageNames[1]}`, urls[0]);
    const host = modeledHost(() => snapshot(input, swapped));
    host.bytes.set(urls[0], images[0]);
    host.bytes.set(urls[1], images[1]);
    expect((yield* run(input, host)).status).toBe("unverifiable");
    expect(host.edits).toEqual([]);
    const verified = section
      .replace(`./${imageNames[0]}`, urls[0])
      .replace(`./${imageNames[1]}`, urls[1]);
    const redirected = modeledHost(() => snapshot(input, verified));
    const serving = "https://github-production-user-asset-6210df.s3.amazonaws.com/signed.png";
    const wrongHost = "https://attachment.example.test/after.png";
    redirected.redirects.set(urls[0], serving);
    redirected.bytes.set(serving, images[0]);
    redirected.redirects.set(urls[1], wrongHost);
    redirected.bytes.set(wrongHost, images[1]);
    expect((yield* run(input, redirected)).slots?.map(({ state }) => state)).toEqual([
      "verified",
      "unverifiable",
    ]);
    expect(redirected.events).toContain(`image:${serving}`);
    expect(redirected.events).not.toContain(`image:${wrongHost}`);
    expect(redirected.edits).toEqual([]);
    const misplaced = modeledHost(() => snapshot(input, swapped.replace("![Before", "![After")));
    expect((yield* run(input, misplaced)).status).toBe("unverifiable");
    expect(misplaced.edits).toEqual([]);
    for (const extra of [
      "![repeat](./repl-ui-checkpoint-before.png)",
      "[ref]: ./repl%2dui-checkpoint-before.png",
      "![repeat](./repl\\-ui-checkpoint-before.png)",
    ]) {
      const alias = modeledHost(() => snapshot(input, section + "\n\n" + extra));
      yield* raised(run(input, alias));
      expect(alias.events).toEqual(["help", "read"]);
    }
  });

  if (cliRuntime() === "deno") {
    it("preflights, pushes and creates with the ordinary provider before reading and editing the numbered draft", function* () {
      const remote = yield* useBareRemote({
        commits: [
          { message: "base", entries: [{ path: "fixture.txt", content: "base\n" }] },
          {
            message: "head",
            branch: "release",
            entries: [{ path: "fixture.txt", content: "head\n" }],
          },
        ],
      });
      const locator = `https://github.com/${repository}`;
      const checkout = yield* useNamedOriginCheckout(remote, locator);
      checkout.run("checkout", "-b", "feature", "origin/release");
      const input = yield* useFixture(
        checkout.run("rev-parse", "main"),
        checkout.run("rev-parse", "HEAD"),
      );
      const body = beforeProse + afterProse;
      yield* writeTextFile(
        input.path,
        JSON.stringify({
          ...input.receipt,
          target: { kind: "create", title: "Prepared title", body, draftRecord: "draft.json" },
        }),
      );
      const root = yield* useManagedRoot();
      const store = gitHubStore({
        owner: "octo",
        repository: "project",
        heads: { main: input.pins.base },
      });
      store.resolveHead = (branch) => remoteBranch(remote, branch);
      const git = countingOrdinaryHost(rewritingHost(locator, remote.locator));
      const host = modeledHost(() => {
        const created = store.pullRequests[0];
        return snapshot(input, created.body ?? "", created.number);
      });
      const setup = {
        directory: checkout.root,
        install: () =>
          useRunComposition({
            root,
            cwd: checkout.root,
            host: git.host,
            gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
          }),
        *beforeEdit() {
          const retained = JSON.parse(yield* readTextFile(join(input.directory, "draft.json")));
          expect(retained.number).toBe(store.pullRequests[0].number);
          expect(retained.head).toBe(input.pins.head);
        },
      };
      host.help = false;
      yield* raised(run(input, host, "publish", setup));
      expect(host.events).toEqual(["help"]);
      expect(git.counters.commands).toEqual([]);
      expect(creations(store)).toBe(0);

      host.events.length = 0;
      host.help = true;
      yield* writeTextFile(
        input.path,
        JSON.stringify({
          ...input.receipt,
          target: {
            kind: "create",
            title: "Prepared title",
            body: oversizedProse,
            draftRecord: "draft.json",
          },
        }),
      );
      expect(String(yield* raised(run(input, host, "publish", setup)))).toContain(
        "The proposed draft description exceeds the GitHub body limit.",
      );
      expect(host.events).toEqual(["help"]);
      expect(git.counters.commands).toEqual([]);
      expect(creations(store)).toBe(0);
      expect(remoteBranch(remote, "feature")).toBeUndefined();

      host.events.length = 0;
      yield* writeTextFile(
        input.path,
        JSON.stringify({
          ...input.receipt,
          target: { kind: "create", title: "Prepared title", body, draftRecord: "draft.json" },
        }),
      );
      const result = yield* run(input, host, "publish", setup);
      expect(creations(store)).toBe(1);
      expect(store.pullRequests[0]).toMatchObject({ title: "Prepared title", body, draft: true });
      expect(git.counters.commands.some((args) => args.includes("push"))).toBe(true);
      expect(remoteBranch(remote, "feature")).toBe(input.pins.head);
      expect(result.status).toBe("complete");
      expect(host.events).toEqual([
        "help",
        "read",
        "edit",
        "read",
        ...urls.map((url) => `image:${url}`),
      ]);

      const mismatched = modeledHost(() => ({
        ...snapshot(input, body, store.pullRequests[0].number),
        draft: false,
      }));
      expect((yield* run(input, mismatched, "publish", setup)).status).toBe("unverifiable");
      expect(mismatched.events).toEqual(["help", "read"]);
      expect(creations(store)).toBe(1);
    });
  }
});
