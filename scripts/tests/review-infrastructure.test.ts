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

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DocumentRunOptions {
  componentDirs?: string[];
  env?: Record<string, string>;
  glob?: Array<{ path: string; isFile: boolean; isDirectory: boolean }>;
  stat?: (path: string) => { exists: boolean; isFile: boolean; isDirectory: boolean } | undefined;
  process?: ProcessResult | ((command: readonly string[]) => ProcessResult);
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
      "const value = yield* fetch(props.url, { method: 'POST', headers: { 'X-Caller': 'kept', 'Content-Type': 'application/custom' }, body: 'request-body' }).expect().json();",
      "```",
      "",
      "{props.label}={value.message}",
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

function* runDocumentResult(
  document: string,
  components: Record<string, string>,
  options: DocumentRunOptions = {},
): Operation<{ ok: boolean; journal: string }> {
  return yield* scoped(function* () {
    const environment = options.env;
    if (environment) {
      yield* API.Env.around({
        *env([name], next) {
          return name in environment ? environment[name] : yield* next(name);
        },
      });
    }
    const stat = options.stat;
    const entries = options.glob;
    if (stat || entries) {
      yield* API.Fs.around({
        *stat([path], next) {
          const value = stat?.(path);
          return value ?? (yield* next(path));
        },
        *glob([parameters], next) {
          return entries ?? (yield* next(parameters));
        },
      });
    }
    yield* useStubFs({ "doc.md": document, ...components });
    const process = options.process;
    if (process) {
      yield* API.Process.around({
        *exec([parameters]) {
          return typeof process === "function" ? process(parameters.command) : process;
        },
      });
    }
    const stream = new InMemoryStream();
    const execution = yield* execute({
      path: "doc.md",
      stream,
      componentDirs: options.componentDirs ?? ["components"],
    });
    yield* forEach(function* () {}, execution.output);
    const result = yield* execution;
    return { ok: result.ok, journal: JSON.stringify(stream.snapshot()) };
  });
}

function* runDocument(
  document: string,
  components: Record<string, string>,
  options: DocumentRunOptions = {},
): Operation<boolean> {
  const result = yield* runDocumentResult(document, components, options);
  return result.ok;
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

    const valid = yield* runDocumentResult(
      '<Output><OxlintDiagnostics files={["a.ts"]} as="diagnostics" />\n```ts eval\nconst summary = `${diagnostics.length}:${diagnostics[0].ruleId}`;\n```\n{summary}</Output>',
      { ".reviews/components/OxlintDiagnostics.ts": "" },
      {
        componentDirs: [".reviews/components"],
        process: {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              message: "unused",
              code: "eslint(no-unused-vars)",
              severity: "warning",
              filename: "a.ts",
              labels: [{ span: { line: 2, column: 3 } }],
              source: "raw source must not cross the boundary",
              cause: { secret: "unbounded payload" },
            },
          ]),
          stderr: "",
        },
      },
    );
    expect(valid.ok).toBe(true);
    expect(valid.journal).toContain("1:no-unused-vars");
    expect(valid.journal).not.toContain("raw source must not cross the boundary");
    expect(valid.journal).not.toContain("unbounded payload");

    expect(
      yield* runDocument(
        '<Output><OxlintDiagnostics files={["a.ts"]} as="diagnostics" /></Output>',
        { ".reviews/components/OxlintDiagnostics.ts": "" },
        {
          componentDirs: [".reviews/components"],
          process: { exitCode: 0, stdout: "not json", stderr: "" },
        },
      ),
    ).toBe(false);
    expect(
      yield* runDocument(
        '<Output><OxlintDiagnostics files={["a.ts"]} as="diagnostics" /></Output>',
        { ".reviews/components/OxlintDiagnostics.ts": "" },
        {
          componentDirs: [".reviews/components"],
          process: { exitCode: 2, stdout: "[]", stderr: "invocation failed" },
        },
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
        { componentDirs: [".reviews/components"] },
      ),
    ).toBe(true);
    expect(calls).toBe(0);
  });

  it("extracts human comment replies and rejects malformed GitHub comments", function* () {
    yield* useTempFileCompiler();
    const comments = [
      {
        id: 100,
        user: { login: "github-actions[bot]", type: "Bot" },
        body: "Redundant comment: this repeats the code",
        path: "src/example.ts",
        original_line: 4,
        diff_hunk: "@@\n+const value = 1;",
      },
      {
        id: 200,
        in_reply_to_id: 100,
        user: { login: "human", type: "User" },
        body: "Please keep this comment",
      },
      {
        id: 201,
        in_reply_to_id: 100,
        user: { login: "acknowledged", type: "User" },
        body: "Remove it",
      },
      {
        id: 202,
        in_reply_to_id: 100,
        user: { login: "automation", type: "Bot" },
        body: "Bot reply must not be classified",
      },
    ];
    let malformed = false;
    yield* FetchApi.around({
      *fetch([input]) {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        if (url.includes("/pulls/1/comments?")) {
          return response(malformed ? JSON.stringify({ comments }) : JSON.stringify(comments));
        }
        if (url.includes("/comments/201/reactions")) {
          return response(
            JSON.stringify([
              { user: { login: "github-actions[bot]", type: "Bot" }, content: "+1" },
            ]),
          );
        }
        return response("[]");
      },
    });

    const document = [
      "<Output>",
      "```ts eval",
      "const pr = { added: [{ content: '// note', file: 'src/example.ts', lineNumber: 4, isTest: false }] };",
      "```",
      '<CommentReviewData pr={pr} as="data" />',
      "```ts eval",
      "const summary = `${data.previousFindings.length}:${data.repliesForClassification.length}:${data.dismissedReplies.length}`;",
      "```",
      "{summary}",
      "{data.repliesText}",
      "</Output>",
    ].join("\n");
    const options = {
      componentDirs: [".reviews/components"],
      env: {
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "taras/executable.md",
        PR_NUMBER: "1",
      },
    };
    const result = yield* runDocumentResult(
      document,
      { ".reviews/components/CommentReviewData.ts": "" },
      options,
    );
    expect(result.ok).toBe(true);
    expect(result.journal).toContain("1:1:1");
    expect(result.journal).toContain("Please keep this comment");
    expect(result.journal).not.toContain("Bot reply must not be classified");

    malformed = true;
    const malformedResult = yield* runDocumentResult(
      document,
      { ".reviews/components/CommentReviewData.ts": "" },
      options,
    );
    expect(malformedResult.ok).toBe(false);
  });

  it("parses CommentReviewState classifications and durable checklist state", function* () {
    yield* useTempFileCompiler();
    const document = [
      "<Output>",
      "```ts eval",
      "const pr = { added: [{ file: 'new.ts', lineNumber: 3 }] };",
      "const data = {",
      "  pairs: [{ comment: 'redundant', code: 'const value = 1', file: 'new.ts', lineNumber: 3 }],",
      "  previousFindings: [{ file: 'old.ts', lineNumber: 1 }],",
      "  dismissedReplies: [],",
      "  repliesForClassification: [{ file: 'new.ts', lineNumber: 2, replyText: 'keep it', replyId: 7 }],",
      "};",
      "```",
      '<CommentReviewState pr={pr} data={data} classificationResult="[0] DISMISS" sampleResult="REDUNDANT[0]" as="state" />',
      "```ts eval",
      "const summary = `${state.hasChecklist}:${state.hasFindings}:${state.newDismissReplies.length}`;",
      "```",
      "{summary}",
      "{state.checklistMd}",
      "</Output>",
    ].join("\n");
    const result = yield* runDocumentResult(
      document,
      { ".reviews/components/CommentReviewState.ts": "" },
      { componentDirs: [".reviews/components"] },
    );
    expect(result.ok).toBe(true);
    expect(result.journal).toContain("true:true:1");
    expect(result.journal).toContain("old.ts:1");
    expect(result.journal).toContain("keep it");
  });

  it("covers Doctor availability, probes, crashes, and failures", function* () {
    yield* useTempFileCompiler();
    const document = [
      "<Output>",
      "```ts eval",
      "const pr = {};",
      "```",
      '<Doctor pr={pr} as="doctor" />',
      "```ts eval",
      "const summary = `${doctor.typeAwareAvailable}:${doctor.recommendation}`;",
      "```",
      "{summary}",
      "</Output>",
    ].join("\n");
    const component = { ".reviews/components/Doctor.ts": "" };
    const stats = (available: boolean) => (path: string) => {
      if (path === ".reviews/.oxlint/oxlint" || path === ".reviews/.oxlint/tsgolint") {
        return { exists: available, isFile: available, isDirectory: false };
      }
      if (path === ".reviews/tsconfig.oxlint.json") {
        return { exists: available, isFile: available, isDirectory: false };
      }
      if (path === "node_modules") {
        return { exists: available, isFile: false, isDirectory: available };
      }
      return undefined;
    };
    const baseOptions = { componentDirs: [".reviews/components"], glob: [] };

    const unavailable = yield* runDocumentResult(document, component, {
      ...baseOptions,
      stat: stats(false),
    });
    expect(unavailable.ok).toBe(true);
    expect(unavailable.journal).toContain("false:syntax-only");

    const successful = yield* runDocumentResult(document, component, {
      ...baseOptions,
      stat: stats(true),
      process: (command) => {
        if (command.at(-1) === "--version") {
          return { exitCode: 0, stdout: `${command[0]} 1.0\n`, stderr: "" };
        }
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              message: "unused",
              code: "no-unused-vars",
              severity: "warning",
              filename: "a.ts",
              labels: [{ span: { line: 1, column: 1 } }],
            },
          ]),
          stderr: "",
        };
      },
    });
    expect(successful.ok).toBe(true);
    expect(successful.journal).toContain("true:type-aware");

    const crash = yield* runDocumentResult(document, component, {
      ...baseOptions,
      stat: stats(true),
      process: (command) =>
        command.at(-1) === "--version"
          ? { exitCode: 0, stdout: "tool 1.0\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "tsgolint panic: OOM" },
    });
    expect(crash.ok).toBe(true);
    expect(crash.journal).toContain("false:syntax-only");

    const malformed = yield* runDocumentResult(document, component, {
      ...baseOptions,
      stat: stats(true),
      process: (command) =>
        command.at(-1) === "--version"
          ? { exitCode: 0, stdout: "tool 1.0\n", stderr: "" }
          : { exitCode: 0, stdout: "not json", stderr: "" },
    });
    expect(malformed.ok).toBe(false);

    const failed = yield* runDocumentResult(document, component, {
      ...baseOptions,
      stat: stats(true),
      process: { exitCode: 2, stdout: "[]", stderr: "invocation failed" },
    });
    expect(failed.ok).toBe(false);
  });

  it("constructs ReviewContext from git and fails on git errors", function* () {
    yield* useTempFileCompiler();
    const document = [
      "<Output>",
      '<ReviewContext as="context" />',
      "```ts eval",
      "const summary = `${context.changedFilePaths.length}:${context.pr.files[0].path}`;",
      "```",
      "{summary}",
      "</Output>",
    ].join("\n");
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/example.ts",
      "@@ -0,0 +1,1 @@",
      "+const value = 1;",
    ].join("\n");
    const result = yield* runDocumentResult(
      document,
      { ".reviews/components/ReviewContext.ts": "" },
      {
        componentDirs: [".reviews/components"],
        env: { BASE_SHA: "base", HEAD_SHA: "head", PR_BODY: "local body" },
        process: (command) =>
          command.includes("--name-status")
            ? { exitCode: 0, stdout: "A\tsrc/example.ts\n", stderr: "" }
            : { exitCode: 0, stdout: diff, stderr: "" },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.journal).toContain("1:src/example.ts");

    const failed = yield* runDocumentResult(
      document,
      { ".reviews/components/ReviewContext.ts": "" },
      {
        componentDirs: [".reviews/components"],
        process: { exitCode: 1, stdout: "", stderr: "git diff failed" },
      },
    );
    expect(failed.ok).toBe(false);
  });

  it("fails when a provider returns 2xx without model content", function* () {
    yield* useTempFileCompiler();
    const deepInfra = yield* readTextFile(".reviews/components/DeepInfraProvider.md");
    const ollama = yield* readTextFile(".reviews/components/OllamaProvider.md");
    const sample = yield* readTextFile("packages/core/components/Sample.md");
    const requests: string[] = [];
    yield* FetchApi.around({
      *fetch([input]) {
        requests.push(
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        );
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
        { env: { DEEPINFRA_TOKEN: "test-token" } },
      ),
    ).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(
      yield* runDocument(
        '<Output><OllamaProvider model="test"><Sample prompt="hello" /></OllamaProvider></Output>',
        {
          "components/OllamaProvider.md": ollama,
          "components/Sample.md": sample,
        },
      ),
    ).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe("http://localhost:11434/v1/chat/completions");
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
    const inventoryResult = yield* runDocumentResult(
      '<RepositoryInventory as="inventory" />\n{inventory.fileCount}:{inventory.lineCount}',
      {
        ".reviews/components/RepositoryInventory.ts": "",
        "packages/example.ts": "first\nsecond\n",
      },
      {
        componentDirs: [".reviews/components"],
        glob: [{ path: "packages/example.ts", isFile: true, isDirectory: false }],
      },
    );
    expect(inventoryResult.ok).toBe(true);
  });
});
