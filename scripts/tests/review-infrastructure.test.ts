import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { FetchApi, type FetchResponse } from "@effectionx/fetch";
import { readTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { execute } from "../../packages/core/src/execute.ts";
import { useTempFileCompiler } from "../../packages/core/src/temp-file-compiler.ts";
import { forEach } from "@effectionx/stream-helpers";
import { scoped, until } from "effection";
import type { Operation } from "effection";

interface RequestRecord {
  input: string;
  init?: RequestInit;
  shouldExpect: boolean;
}

function response(body: string): FetchResponse {
  const raw = new Response(body, { status: 200 });
  return {
    raw,
    get bodyUsed() {
      return raw.bodyUsed;
    },
    get ok() {
      return raw.ok;
    },
    get status() {
      return raw.status;
    },
    get statusText() {
      return raw.statusText;
    },
    get headers() {
      return raw.headers;
    },
    get url() {
      return raw.url;
    },
    get redirected() {
      return raw.redirected;
    },
    get type() {
      return raw.type;
    },
    *json<T = unknown>(parse?: (value: unknown) => T): Operation<T> {
      const value: unknown = JSON.parse(body);
      return parse ? parse(value) : (value as T);
    },
    *text(): Operation<string> {
      return body;
    },
    *arrayBuffer(): Operation<ArrayBuffer> {
      return yield* until(raw.arrayBuffer());
    },
    *blob(): Operation<Blob> {
      return yield* until(raw.blob());
    },
    *formData(): Operation<FormData> {
      return yield* until(raw.formData());
    },
    body() {
      throw new Error("body streaming is not used by this test");
    },
    *expect(): Operation<FetchResponse> {
      return this;
    },
  };
}

function* run(
  provider: string,
  token?: string,
): Operation<{ requests: RequestRecord[]; journal: string }> {
  const requests: RequestRecord[] = [];
  const files: Record<string, string> = {
    "doc.md": [
      "<GitHubAuth>",
      "<Wrapper />",
      '<Probe label="lookalike" url="https://api.github.com.example.com/repos/a" />',
      '<Probe label="plain" url="https://example.com/request" />',
      '<Probe label="http" url="http://api.github.com/repos/http" />',
      "<NoExpect />",
      "</GitHubAuth>",
      '<Probe label="outside" url="https://api.github.com/repos/outside" />',
    ].join("\n"),
    "components/GitHubAuth.md": provider,
    "components/Probe.md": [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    label: { type: string }",
      "    url: { type: string }",
      "  required: [label, url]",
      "  additionalProperties: false",
      "---",
      "",
      "```ts eval",
      "const value = yield* fetch(url, { method: 'POST', headers: { 'X-Caller': 'kept', 'Content-Type': 'application/custom' }, body: 'request-body' }).expect().json();",
      "```",
      "",
      "{label}={value.message}",
    ].join("\n"),
    "components/Wrapper.md": '<Probe label="nested" url="https://api.github.com/repos/nested" />',
    "components/NoExpect.md": [
      "```ts eval",
      'yield* fetch("https://api.github.com/repos/no-expect");',
      "```",
    ].join("\n"),
  };

  yield* useStubFs(files);
  yield* API.Env.around({
    *env([name], next) {
      if (name === "GITHUB_TOKEN") {
        return token;
      }
      return yield* next(name);
    },
  });
  yield* FetchApi.around(
    {
      *fetch([input, init, shouldExpect]) {
        const request =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        requests.push({ input: request, init, shouldExpect });
        return response(JSON.stringify({ message: "ok" }));
      },
    },
    { at: "min" },
  );

  const stream = new InMemoryStream();
  const execution = yield* execute({ path: "doc.md", stream, componentDirs: ["components"] });
  yield* forEach(function* () {}, execution.output);
  const result = yield* execution;
  expect(result.ok).toBe(true);
  return { requests, journal: JSON.stringify(stream.snapshot()) };
}

function* runDocument(
  document: string,
  components: Record<string, string>,
  processResult?: { exitCode: number; stdout: string; stderr: string },
  componentDirs: string[] = ["components"],
): Operation<boolean> {
  return yield* scoped(function* () {
    yield* useStubFs({ "doc.md": document, ...components });
    if (processResult) {
      yield* API.Process.around({
        *exec() {
          return processResult;
        },
      });
    }
    const stream = new InMemoryStream();
    const execution = yield* execute({ path: "doc.md", stream, componentDirs });
    yield* forEach(function* () {}, execution.output);
    const result = yield* execution;
    return result.ok;
  });
}

describe("review infrastructure", () => {
  it("uses the real GitHubAuth component for exact-host scoped middleware", function* () {
    yield* useTempFileCompiler();
    const provider = yield* readTextFile(".reviews/components/GitHubAuth.md");
    const result = yield* run(provider, "secret-token");

    expect(result.requests).toHaveLength(6);
    expect(result.requests[0].input).toBe("https://api.github.com/repos/nested");
    expect(result.requests[0].init?.headers).toBeInstanceOf(Headers);
    const nestedHeaders = new Headers(result.requests[0].init?.headers);
    expect(nestedHeaders.get("Authorization")).toBe("Bearer secret-token");
    expect(nestedHeaders.get("Accept")).toBe("application/vnd.github+json");
    expect(nestedHeaders.get("X-Caller")).toBe("kept");
    expect(result.requests[0].init?.body).toBe("request-body");
    expect(result.requests[0].shouldExpect).toBe(true);
    expect(new Headers(result.requests[1].init?.headers).get("Authorization")).toBe(null);
    expect(new Headers(result.requests[2].init?.headers).get("Authorization")).toBe(null);
    expect(new Headers(result.requests[3].init?.headers).get("Authorization")).toBe(null);
    expect(new Headers(result.requests[4].init?.headers).get("Authorization")).toBe(
      "Bearer secret-token",
    );
    expect(result.requests[4].shouldExpect).toBe(false);
    expect(new Headers(result.requests[5].init?.headers).get("Authorization")).toBe(null);
    expect(result.journal).not.toContain("secret-token");
  });

  it("delegates unchanged when the token is unavailable and restores scope", function* () {
    yield* useTempFileCompiler();
    const provider = yield* readTextFile(".reviews/components/GitHubAuth.md");
    const result = yield* run(provider);

    for (const request of result.requests) {
      expect(new Headers(request.init?.headers).get("Authorization")).toBe(null);
      if (request.init?.body !== undefined) {
        expect(request.init.body).toBe("request-body");
      }
    }
    expect(result.journal).not.toContain("secret-token");
  });

  it("fails on malformed and unexpected Oxlint results, but skips empty input", function* () {
    yield* useTempFileCompiler();

    expect(
      yield* runDocument(
        '<Output><OxlintDiagnostics files={["a.ts"]} as="diagnostics" /></Output>',
        { ".reviews/components/OxlintDiagnostics.ts": "" },
        { exitCode: 0, stdout: "not json", stderr: "" },
        [".reviews/components"],
      ),
    ).toBe(false);
    expect(
      yield* runDocument(
        '<Output><OxlintDiagnostics files={["a.ts"]} as="diagnostics" /></Output>',
        { ".reviews/components/OxlintDiagnostics.ts": "" },
        { exitCode: 2, stdout: "[]", stderr: "invocation failed" },
        [".reviews/components"],
      ),
    ).toBe(false);

    let calls = 0;
    yield* API.Process.around({
      *exec() {
        calls++;
        return { exitCode: 2, stdout: "", stderr: "must not run" };
      },
    });
    expect(
      yield* runDocument(
        '<Output><OxlintDiagnostics files={[]} as="diagnostics" /></Output>',
        {
          ".reviews/components/OxlintDiagnostics.ts": "",
        },
        undefined,
        [".reviews/components"],
      ),
    ).toBe(true);
    expect(calls).toBe(0);
  });

  it("fails when a provider returns 2xx without model content", function* () {
    yield* useTempFileCompiler();
    const deepInfra = yield* readTextFile(".reviews/components/DeepInfraProvider.md");
    const ollama = yield* readTextFile(".reviews/components/OllamaProvider.md");
    const sample = yield* readTextFile("packages/core/components/Sample.md");
    yield* FetchApi.around({
      *fetch() {
        return response(JSON.stringify({ choices: [] }));
      },
    });

    expect(
      yield* runDocument(
        '<Output><DeepInfraProvider model="test"><Sample prompt="hello" /></DeepInfraProvider></Output>',
        {
          "components/DeepInfraProvider.md": deepInfra,
          "components/Sample.md": sample,
        },
      ),
    ).toBe(false);
    expect(
      yield* runDocument(
        '<Output><OllamaProvider model="test"><Sample prompt="hello" /></OllamaProvider></Output>',
        {
          "components/OllamaProvider.md": ollama,
          "components/Sample.md": sample,
        },
      ),
    ).toBe(false);
  });

  it("requires GitHubComment metadata", function* () {
    yield* useTempFileCompiler();
    const comment = yield* readTextFile(".reviews/components/GitHubComment.md");
    expect(
      yield* runDocument("<Output><GitHubComment>finding</GitHubComment></Output>", {
        "components/GitHubComment.md": comment,
      }),
    ).toBe(false);
  });

  it("executes the real RepositoryInventory function component", function* () {
    yield* useTempFileCompiler();
    yield* API.Fs.around({
      *glob() {
        return [{ path: "packages/example.ts", isFile: true, isDirectory: false }];
      },
    });
    expect(
      yield* runDocument(
        '<RepositoryInventory as="inventory" />\n{inventory.fileCount}:{inventory.lineCount}',
        {
          ".reviews/components/RepositoryInventory.ts": "",
          "packages/example.ts": "first\nsecond\n",
        },
        undefined,
        [".reviews/components"],
      ),
    ).toBe(true);
  });
});
