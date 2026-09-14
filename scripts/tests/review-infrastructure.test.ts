import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { FetchApi, type FetchResponse } from "@effectionx/fetch";
import { expandGlob, readTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { execute, executeInstalled } from "../../packages/core/src/execute.ts";
import {
  REVIEW_DOCUMENTS,
  REVIEW_REGISTRATIONS,
  reviewComponentDeclarations,
} from "../../packages/code-review-agent/src/review-components.ts";
import type { ReviewDocument } from "../../packages/code-review-agent/src/review-components.ts";
import { createHash } from "node:crypto";
import { Sample } from "../../packages/core/src/sample-api.ts";
import { useTempFileCompiler } from "../../packages/core/src/temp-file-compiler.ts";
import { forEach } from "@effectionx/stream-helpers";
import { each, scoped, until } from "effection";
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
  includes?: string[];
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
  const execution = yield* execute({ path: "doc.md", stream, includes: ["components"] });
  yield* forEach(function* () {}, execution.output);
  const result = yield* execution;
  expect(result.ok).toBe(true);
  return { requests, journal: JSON.stringify(stream.snapshot()) };
}

function* runDocumentResult(
  document: string,
  components: Record<string, string>,
  options: DocumentRunOptions = {},
): Operation<{ ok: boolean; journal: string; text: string }> {
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
      includes: options.includes ?? ["components"],
    });
    yield* forEach(function* () {}, execution.output);
    const result = yield* execution;
    return {
      ok: result.ok,
      journal: JSON.stringify(stream.snapshot()),
      text: result.ok && typeof result.value === "string" ? result.value.trim() : "",
    };
  });
}

/**
 * Where the review components now live, as explicit fixture includes.
 *
 * The package's own directories rather than a checkout path: these are the
 * shipped definitions, and reading them here is what makes the behavioral cases
 * below about the real components rather than about copies of them.
 *
 * This is *not* how a run finds them. Production selection is the host's
 * declaration, asserted in "the trusted review graph" below and end to end in
 * `scripts/tests/plan-component-compiled.test.ts`. These cases supply the files
 * explicitly because their subject is what one component does with its inputs,
 * which needs no profile at all.
 */
const OPERATIONAL_DIRS = [
  "packages/code-review-agent/src/documents/components",
  "packages/code-review-agent/src/documents/policies",
  "packages/code-review-agent/src/components",
];

/**
 * Read operational components from the repository before `useStubFs` replaces
 * the filesystem, so a run expands the shipped review documents rather than a
 * copy. A `.ts` component is imported from its real path, so its stub entry
 * only has to make the path resolve.
 */
function* operationalComponents(paths: string[]): Operation<Record<string, string>> {
  const components: Record<string, string> = {};
  for (const path of paths) {
    components[path] = path.endsWith(".ts") ? "" : yield* readTextFile(path);
  }
  return components;
}

function props(values: Record<string, unknown>): string[] {
  return [
    "```js eval",
    ...Object.entries(values).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`),
    "```",
    "",
  ];
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
    const provider = yield* readTextFile(
      "packages/code-review-agent/src/documents/components/GitHubAuth.md",
    );
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
    const provider = yield* readTextFile(
      "packages/code-review-agent/src/documents/components/GitHubAuth.md",
    );
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
      { "packages/code-review-agent/src/components/OxlintDiagnostics.ts": "" },
      {
        includes: [
          "packages/code-review-agent/src/documents/components",
          "packages/code-review-agent/src/components",
        ],
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
        { "packages/code-review-agent/src/components/OxlintDiagnostics.ts": "" },
        {
          includes: [
            "packages/code-review-agent/src/documents/components",
            "packages/code-review-agent/src/components",
          ],
          process: { exitCode: 0, stdout: "not json", stderr: "" },
        },
      ),
    ).toBe(false);
    expect(
      yield* runDocument(
        '<Output><OxlintDiagnostics files={["a.ts"]} as="diagnostics" /></Output>',
        { "packages/code-review-agent/src/components/OxlintDiagnostics.ts": "" },
        {
          includes: [
            "packages/code-review-agent/src/documents/components",
            "packages/code-review-agent/src/components",
          ],
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
          "packages/code-review-agent/src/components/OxlintDiagnostics.ts": "",
        },
        {
          includes: [
            "packages/code-review-agent/src/documents/components",
            "packages/code-review-agent/src/components",
          ],
        },
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
      includes: [
        "packages/code-review-agent/src/documents/components",
        "packages/code-review-agent/src/components",
      ],
      env: {
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "taras/executable.md",
        PR_NUMBER: "1",
      },
    };
    const result = yield* runDocumentResult(
      document,
      { "packages/code-review-agent/src/components/CommentReviewData.ts": "" },
      options,
    );
    expect(result.ok).toBe(true);
    expect(result.journal).toContain("1:1:1");
    expect(result.journal).toContain("Please keep this comment");
    expect(result.journal).not.toContain("Bot reply must not be classified");

    malformed = true;
    const malformedResult = yield* runDocumentResult(
      document,
      { "packages/code-review-agent/src/components/CommentReviewData.ts": "" },
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
      { "packages/code-review-agent/src/components/CommentReviewState.ts": "" },
      {
        includes: [
          "packages/code-review-agent/src/documents/components",
          "packages/code-review-agent/src/components",
        ],
      },
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
    const component = { "packages/code-review-agent/src/components/Doctor.ts": "" };
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
    const baseOptions = {
      includes: [
        "packages/code-review-agent/src/documents/components",
        "packages/code-review-agent/src/components",
      ],
      glob: [],
    };

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
      { "packages/code-review-agent/src/components/ReviewContext.ts": "" },
      {
        includes: [
          "packages/code-review-agent/src/documents/components",
          "packages/code-review-agent/src/components",
        ],
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
      { "packages/code-review-agent/src/components/ReviewContext.ts": "" },
      {
        includes: [
          "packages/code-review-agent/src/documents/components",
          "packages/code-review-agent/src/components",
        ],
        process: { exitCode: 1, stdout: "", stderr: "git diff failed" },
      },
    );
    expect(failed.ok).toBe(false);
  });

  it("fails when a provider returns 2xx without model content", function* () {
    yield* useTempFileCompiler();
    const deepInfra = yield* readTextFile(
      "packages/code-review-agent/src/documents/components/DeepInfraProvider.md",
    );
    const ollama = yield* readTextFile(
      "packages/code-review-agent/src/documents/components/OllamaProvider.md",
    );
    const sample = yield* readTextFile(
      "packages/code-review-agent/src/documents/components/Sample.md",
    );
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
    const comment = yield* readTextFile(
      "packages/code-review-agent/src/documents/components/GitHubComment.md",
    );
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
        "packages/code-review-agent/src/components/RepositoryInventory.ts": "",
        "packages/example.ts": "first\nsecond\n",
      },
      {
        includes: [
          "packages/code-review-agent/src/documents/components",
          "packages/code-review-agent/src/components",
        ],
        glob: [{ path: "packages/example.ts", isFile: true, isDirectory: false }],
      },
    );
    expect(inventoryResult.ok).toBe(true);
  });

  it("retires the Show component from the review library", function* () {
    const tag = /<\/?Show[\s/>]/;
    const documents: string[] = [];
    for (const entry of yield* each(
      expandGlob("packages/code-review-agent/src/documents/**/*.md"),
    )) {
      documents.push(entry.path);
      const source = yield* readTextFile(entry.path);
      expect([entry.path, tag.test(source)]).toEqual([entry.path, false]);
      yield* each.next();
    }
    // The walk found the review library, so the scan above is not vacuous.
    expect(
      documents.some((path) =>
        path.endsWith("packages/code-review-agent/src/documents/components/Finding.md"),
      ),
    ).toBe(true);
    expect(documents.some((path) => path.endsWith("Show.md"))).toBe(false);

    const focused = yield* readTextFile("packages/core/tests/unused-in-diff.test.ts");
    expect(focused).toContain("components/UnusedInDiff.md");
    expect(focused).not.toContain("Show.md");

    const spec = yield* readTextFile("specs/code-review-agent-spec.md");
    expect(spec).toContain("### 5.10 `CommentReview.md`");
    expect(tag.test(spec)).toBe(false);
    expect(spec).not.toContain("Show.md");
    expect(spec).not.toContain("`Show`");
  });

  it("renders Finding's selected icon and message and suppresses its false case", function* () {
    yield* useTempFileCompiler();
    const components = yield* operationalComponents([
      "packages/code-review-agent/src/documents/components/Finding.md",
    ]);

    const selected = yield* runDocumentResult(
      '<Finding when={true} severity="error" message="Broken contract." />',
      components,
      { includes: OPERATIONAL_DIRS },
    );
    expect(selected.ok).toBe(true);
    expect(selected.text).toBe("🔴 Broken contract.");

    const suppressed = yield* runDocumentResult(
      '<Finding when={false} severity="error" message="Broken contract." />',
      components,
      { includes: OPERATIONAL_DIRS },
    );
    expect(suppressed.ok).toBe(true);
    expect(suppressed.text).toBe("");
  });

  it("renders OxlintSummary's clean section and its unavailable warning", function* () {
    yield* useTempFileCompiler();
    const components = yield* operationalComponents([
      "packages/code-review-agent/src/documents/components/OxlintSummary.md",
      "packages/code-review-agent/src/documents/components/ReviewSection.md",
    ]);
    const summary = (oxlintInstalled: boolean) =>
      [
        ...props({
          diagnostics: { total: 0, summary: "1 warning" },
          doctor: { oxlintInstalled, bloatRulesMissing: [] },
        }),
        "<OxlintSummary diagnostics={diagnostics} doctor={doctor} />",
      ].join("\n");

    const clean = yield* runDocumentResult(summary(true), components, {
      includes: OPERATIONAL_DIRS,
    });
    expect(clean.ok).toBe(true);
    expect(clean.text).toBe("### Static Analysis\n\n✅ Oxlint found no issues.");

    const unavailable = yield* runDocumentResult(summary(false), components, {
      includes: OPERATIONAL_DIRS,
    });
    expect(unavailable.ok).toBe(true);
    // The selected branch keeps the blank lines the two suppressed blocks left
    // behind, so this is exact rather than a containment check.
    expect(unavailable.text).toBe(
      [
        "### Static Analysis",
        "",
        "",
        "",
        "",
        "",
        "🟡 Oxlint not installed. Static analysis skipped.",
      ].join("\n"),
    );
  });

  it("suppresses ReleaseSpecWarning for ordinary files and warns on release changes", function* () {
    yield* useTempFileCompiler();
    const components = yield* operationalComponents([
      "packages/code-review-agent/src/documents/components/ReleaseSpecWarning.md",
    ]);
    const warning = (files: string[]) =>
      [...props({ files }), "<ReleaseSpecWarning files={files} />"].join("\n");

    const ordinary = yield* runDocumentResult(
      warning(["packages/core/src/expand.ts"]),
      components,
      {
        includes: OPERATIONAL_DIRS,
      },
    );
    expect(ordinary.ok).toBe(true);
    expect(ordinary.text).toBe("");

    const changed = yield* runDocumentResult(
      warning([".github/workflows/release.yml"]),
      components,
      { includes: OPERATIONAL_DIRS },
    );
    expect(changed.ok).toBe(true);
    expect(changed.text).toContain("> [!WARNING]");
    expect(changed.text).toContain(
      "> This PR changes release configuration (.github/workflows/release.yml) without touching",
    );
    expect(changed.text).not.toContain("ERROR");
  });

  it("expands UnusedInDiff and CommentReview to nothing without an If component", function* () {
    yield* useTempFileCompiler();
    const unusedComponents = yield* operationalComponents([
      "packages/code-review-agent/src/documents/components/UnusedInDiff.md",
    ]);
    const unused = yield* runDocumentResult(
      [
        ...props({ pr: { added: [{ file: "a.ts", lineNumber: 1, content: "const plain = 1;" }] } }),
        '<UnusedInDiff pr={pr} construct="type" message="{count}: {names}." />',
      ].join("\n"),
      unusedComponents,
      { includes: OPERATIONAL_DIRS },
    );
    expect(unused.ok).toBe(true);
    expect(unused.text).toBe("");

    const reviewComponents = yield* operationalComponents([
      "packages/code-review-agent/src/documents/components/CommentReview.md",
      "packages/code-review-agent/src/components/CommentReviewData.ts",
      "packages/code-review-agent/src/components/CommentReviewState.ts",
      "packages/code-review-agent/src/documents/components/SuggestRemoval.md",
      "packages/code-review-agent/src/documents/components/Sample.md",
    ]);
    const requests: string[] = [];
    yield* FetchApi.around({
      *fetch([input]) {
        requests.push(
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        );
        return response("[]");
      },
    });
    const sampled: string[] = [];
    yield* Sample.around({
      // deno-lint-ignore require-yield
      *sample([context]) {
        sampled.push(context.content);
        return "[sampled]";
      },
    });

    const review = yield* runDocumentResult(
      [...props({ pr: { added: [] } }), "<CommentReview pr={pr} />"].join("\n"),
      reviewComponents,
      {
        includes: OPERATIONAL_DIRS,
        env: {
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "taras/executable.md",
          PR_NUMBER: "1",
        },
      },
    );
    expect(review.ok).toBe(true);
    // The typed data component ran — it fetched the pull request's comments —
    // while both captures and both trailing branches stayed empty.
    expect(requests.some((url) => url.includes("/pulls/1/comments"))).toBe(true);
    expect(review.text).toBe("");
    expect(sampled).toEqual([]);
  });

  it("skips the ExtraneousCodePolicy sample below the review threshold", function* () {
    yield* useTempFileCompiler();
    const components = yield* operationalComponents([
      "packages/code-review-agent/src/documents/policies/ExtraneousCodePolicy.md",
      "packages/code-review-agent/src/documents/components/ReviewSection.md",
      "packages/code-review-agent/src/documents/components/Sample.md",
    ]);
    function runPolicy(totalChanges: number): Operation<{ calls: string[]; text: string }> {
      return scoped(function* () {
        const calls: string[] = [];
        yield* Sample.around({
          // deno-lint-ignore require-yield
          *sample([context]) {
            calls.push(context.content);
            return "[sampled]";
          },
        });
        const result = yield* runDocumentResult(
          [
            ...props({
              pr: {
                stats: { totalChanges },
                meta: { title: "Title", body: "Body" },
                diffPreview: "+const value = 1;",
              },
              diagnostics: { summary: "no diagnostics", density: 0 },
              doctor: { oxlintInstalled: true },
            }),
            "<ExtraneousCodePolicy pr={pr} diagnostics={diagnostics} doctor={doctor} />",
          ].join("\n"),
          components,
          { includes: OPERATIONAL_DIRS },
        );
        expect(result.ok).toBe(true);
        return { calls, text: result.text };
      });
    }

    const small = yield* runPolicy(20);
    expect(small.calls).toEqual([]);
    expect(small.text).toBe("### Correctness\n\n✅ Small PR — correctness review skipped.");

    // The same probe records a call when the branch is selected, so the empty
    // result above is non-execution rather than a probe that never wired up.
    const large = yield* runPolicy(21);
    expect(large.calls).toHaveLength(1);
    expect(large.calls[0]).toContain("You are reviewing a TypeScript PR for EXTRANEOUS code only.");
    expect(large.text).toContain("[sampled]");
    expect(large.text).not.toContain("ERROR");
  });

  it("renders RepoCleanupPolicy's clean section without running either branch", function* () {
    yield* useTempFileCompiler();
    const components = yield* operationalComponents([
      "packages/code-review-agent/src/documents/policies/RepoCleanupPolicy.md",
      "packages/code-review-agent/src/documents/components/ReviewSection.md",
      "packages/code-review-agent/src/documents/components/Sample.md",
    ]);
    const calls: string[] = [];
    yield* Sample.around({
      // deno-lint-ignore require-yield
      *sample([context]) {
        calls.push(context.content);
        return "[sampled]";
      },
    });

    const clean = yield* runDocumentResult(
      [
        ...props({
          diagnostics: { total: 0, summary: "MUST NOT RENDER" },
          doctor: { oxlintInstalled: true },
          fileList: "packages/core/src/expand.ts",
        }),
        "<RepoCleanupPolicy diagnostics={diagnostics} doctor={doctor} fileList={fileList} />",
      ].join("\n"),
      components,
      { includes: OPERATIONAL_DIRS },
    );
    expect(clean.ok).toBe(true);
    expect(clean.text).toBe("### Cleanup Policy\n\n✅ No code health issues detected.");
    expect(calls).toEqual([]);
  });
});

/**
 * The review graph as the installed `run` profile supplies it.
 *
 * The cases above supply the package's component files as explicit fixtures,
 * because what they are measuring is what one component does with its inputs.
 * These ask a different question: not whether a component works, but whether the
 * *host* is the one supplying it — so they pass no include at all and let the
 * declaration answer.
 *
 * A review is the one program that must not be answerable by the thing it is
 * reviewing. While the graph lived in `.reviews/`, a pull request could add its
 * own `Finding.md` and the review would run the branch's copy — so what is
 * asserted here is not that the components work, but that the *host* is the one
 * supplying them and a checkout cannot take a name back.
 */
/** The packaged assets, read the way anything but the package would read them. */
function* packagedSource(document: ReviewDocument): Operation<string> {
  return yield* readTextFile(
    `packages/code-review-agent/src/documents/${document.group}/${document.name}.md`,
  );
}

describe("the trusted review graph", () => {
  it("declares exactly the packaged Markdown, each identified by origin and digest", function* () {
    const declared = yield* reviewComponentDeclarations();

    // The count is stated rather than derived from the manifest the
    // implementation also derives from: a manifest that lost an entry would
    // otherwise agree with itself.
    expect(declared).toHaveLength(35);
    expect(new Set(declared.map((one) => one.name)).size).toBe(35);

    for (const document of REVIEW_DOCUMENTS) {
      const one = declared.find((candidate) => candidate.name === document.name);
      expect(one).toBeDefined();
      const source = yield* packagedSource(document);
      // The bytes are the packaged asset's, and the digest is of those bytes.
      // A declaration stating a digest of something else is refused at
      // admission, so this is the half admission cannot check for itself:
      // whether what was read is what the package ships.
      expect(one?.source).toBe(source);
      expect(one?.digest).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
      // The package and the asset, never a filesystem path — the same component
      // sits at three different absolute paths across a checkout, a
      // `node_modules` tree and a binary, and all three are one component.
      expect(one?.origin).toBe(
        `@executablemd/code-review-agent/${document.group}/${document.name}.md`,
      );
      // Unstated, so both spellings keep working. A declaration that narrowed
      // `forms` would change what the existing review roots may write.
      expect(one?.forms).toBeUndefined();
    }
  });

  it("reserves the six TypeScript components rather than offering them as defaults", function* () {
    expect(REVIEW_REGISTRATIONS.map((one) => one.name)).toEqual([
      "CommentReviewData",
      "CommentReviewState",
      "Doctor",
      "OxlintDiagnostics",
      "RepositoryInventory",
      "ReviewContext",
    ]);
    for (const registration of REVIEW_REGISTRATIONS) {
      // Reserved is the registration tier's way of saying what a declaration
      // says. Ordinary would have moved thirty-five components out of a
      // subject's reach and left shadowable exactly the six that run processes,
      // read credentials and reach the network.
      expect(registration.reserved).toBe(true);
      expect(registration.origin).toBe("@executablemd/code-review-agent");
      expect(registration.props).toBeDefined();
      expect(registration.returns).toBeDefined();
      // Each is documented by this package, which the documentation index
      // checks against this same list.
      expect(typeof registration.description).toBe("string");
    }
  });

  it("claims each name once across both tiers", function* () {
    const declared = (yield* reviewComponentDeclarations()).map((one) => one.name);
    const reserved = REVIEW_REGISTRATIONS.map((one) => one.name);
    const all = [...declared, ...reserved];
    // A declaration colliding with a reserved registration is refused before the
    // root document is imported, so an overlap here is a build that cannot run
    // a review at all rather than a precedence question.
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(41);
  });

  /**
   * Every supported entrypoint takes the graph from the installation.
   *
   * The declaration tier winning is only half the outcome. While a command still
   * passed `--include .reviews/components`, the retired directory was a live
   * dependency of that command: deleting it broke the entrypoint, and restoring
   * a file under it put a checkout-supplied component back in front of a review
   * — which is the thing this issue exists to stop.
   *
   * So this reads the commands themselves rather than trusting that the
   * migration reached all seven. Import-graph selection cannot see a task string
   * or a workflow step, so nothing else in the suite would notice one being put
   * back.
   *
   * Scoped to these seven by name. `ci.yml` passes `--include
   * packages/core/components` for unrelated smoke fixtures and is none of this
   * assertion's business — a sweep over every workflow would fail on it and
   * teach the next person to weaken the check.
   */
  it("runs every supported review entrypoint with no component include", function* () {
    const RETIRED = [".reviews/components", ".reviews/policies", "packages/core/components"];

    const tasks: Record<string, string> = JSON.parse(yield* readTextFile("deno.json")).tasks;
    const ROOTS: Record<string, string> = {
      review: ".reviews/ReviewPR.md",
      "review:local": ".reviews/ReviewPR.local.md",
      analyze: ".reviews/AnalyzeRepo.md",
      "analyze:ci": ".reviews/AnalyzeRepoCI.md",
      "analyze:dispatch": ".reviews/DispatchRepoAnalysis.md",
    };

    for (const [name, root] of Object.entries(ROOTS)) {
      const command = tasks[name];
      // The task still exists and still runs its own root document. A
      // migration that removed an entrypoint would otherwise satisfy every
      // negative assertion below.
      expect(`${name}: ${typeof command}`).toBe(`${name}: string`);
      expect(`${name}: ${command.includes(root)}`).toBe(`${name}: true`);
      // No component search path at all, rather than no retired path: an
      // include pointing somewhere new would be a second way to answer for a
      // review's components.
      expect(`${name}: ${command.includes("--include")}`).toBe(`${name}: false`);
      for (const retired of RETIRED) {
        expect(`${name}: ${retired}: ${command.includes(retired)}`).toBe(
          `${name}: ${retired}: false`,
        );
      }
    }

    const WORKFLOWS: Record<string, string> = {
      ".github/workflows/review.yml": ".reviews/ReviewPR.md",
      ".github/workflows/repo-analysis.yml": ".reviews/AnalyzeRepoCI.md",
    };

    for (const [file, root] of Object.entries(WORKFLOWS)) {
      const source = yield* readTextFile(file);
      expect(`${file}: ${source.includes(`run ${root}`)}`).toBe(`${file}: true`);
      for (const retired of RETIRED) {
        expect(`${file}: ${retired}: ${source.includes(retired)}`).toBe(
          `${file}: ${retired}: false`,
        );
      }
    }
  });

  it("ships review copies of Sample and Instruction byte-identical to core's", function* () {
    // Deliberate duplication: the review graph owns its own copies so that the
    // set a review runs is complete in one package. This asserts the copies have
    // not drifted, which makes a future divergence an explicit decision in this
    // package rather than something that happens to one of them.
    for (const name of ["Sample", "Instruction"]) {
      const review = yield* readTextFile(
        `packages/code-review-agent/src/documents/components/${name}.md`,
      );
      expect(review).toBe(yield* readTextFile(`packages/core/components/${name}.md`));
    }
  });

  it("runs the declared Finding even when the checkout supplies its own", function* () {
    yield* useTempFileCompiler();
    const declarations = yield* reviewComponentDeclarations();
    expect(declarations.some((one) => one.name === "Finding")).toBe(true);

    // A checkout that supplies both a same-named component and an unrelated one.
    // The first must lose; the second must still resolve, because claiming names
    // is not the same as turning discovery off.
    yield* useStubFs({
      "doc.md": '<Finding when={true} severity="error" message="probe" />\n\n<CustomProbe />',
      // Not a broken file: it accepts exactly the props the real one accepts,
      // so a run that selected it would *succeed* and quietly emit this marker
      // instead of the finding. A hostile component that merely failed would
      // let this case pass for the wrong reason.
      "components/Finding.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    when: { type: boolean }",
        "    severity: { type: string }",
        "    message: { type: string }",
        "  required: [when, message]",
        "  additionalProperties: false",
        "---",
        "",
        "HOSTILE-FINDING {props.message}",
      ].join("\n"),
      "components/CustomProbe.md": "custom probe ran",
    });

    const stream = new InMemoryStream();
    const execution = yield* executeInstalled(
      { path: "doc.md", stream, includes: ["components"] },
      [{ declarations }],
    );
    yield* forEach(function* () {}, execution.output);
    const result = yield* execution;

    expect(result.ok).toBe(true);
    const text = result.ok && typeof result.value === "string" ? result.value : "";
    // The hostile marker never reaches the output, and the trusted component's
    // own rendering does.
    expect(text).not.toContain("HOSTILE-FINDING");
    // The declared component's own rendering: its `ts eval` chose the icon from
    // the severity it was given, which a body of plain prose could not produce.
    expect(text).toContain("🔴 probe");
    // Ordinary inclusion still works: a caller's own component, of a name the
    // host does not claim, resolves exactly as it always did.
    expect(text).toContain("custom probe ran");
  });
});
