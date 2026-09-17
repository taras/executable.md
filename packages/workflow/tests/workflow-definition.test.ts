/**
 * Tier WD — workflow definition descriptors and stored record shapes.
 *
 * These are the provider-neutral parsers. Nothing here opens a database: the
 * question is only whether a value describes what storage was asked to keep,
 * which is the same question whichever host answers it.
 *
 * Two properties are checked throughout. A shape is closed, so a member nobody
 * declared is a parse failure rather than a field silently dropped. And a
 * failure never quotes the value it refused, because these values are retained
 * history and an error travels to logs and terminals.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Result } from "effection";
import { isCanonicalDocumentTarget } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import {
  canonicalJson,
  conflictingFields,
  decodeSourceText,
  definitionComponents,
  definitionToJson,
  type GitWorkflowDefinitionV1,
  type GitWorkflowRunRecordV1,
  isGitWorkflowDefinition,
  parseSourceBundleDefinition,
  parseStopReasonInput,
  parseWorkflowDefinition,
  sourceBundleComponents,
  sourceBundleDefinitionToJson,
  sourceBundleHash,
  type SourceBundleWorkflowDefinitionV2,
  sourceContentHash,
  verifySourceBundleDefinition,
  verifySourceBundleSnapshot,
  WORKFLOW_RUN_STATUSES,
  WorkflowDefinitionError,
  WorkflowRequestError,
  type WorkflowDefinition,
  WorkflowRunStorage,
  WorkflowStorageProviderError,
} from "../mod.ts";

const SHA1 = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A descriptor, loosely typed: half of these tests build ones that are wrong. */
function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "git",
    objectFormat: "sha1",
    objectId: SHA1,
    rootDocumentPath: "workflows/release.md",
    ...overrides,
  };
}

/** The descriptor, parsed, for tests that need one they already trust. */
function parsed(overrides: Partial<GitWorkflowDefinitionV1> = {}): GitWorkflowDefinitionV1 {
  return git(parseWorkflowDefinition(definition(overrides)));
}

/**
 * The Git descriptor a result holds, narrowed rather than asserted.
 *
 * `parseWorkflowDefinition` now answers with either version, and these cases
 * are about the Git one: a fixture that parsed as a source bundle would be a
 * fixture this suite is not describing.
 */
function git(result: Result<WorkflowDefinition>): GitWorkflowDefinitionV1 {
  if (!result.ok) {
    throw result.error;
  }
  if (!isGitWorkflowDefinition(result.value)) {
    throw new Error("expected a Git workflow definition");
  }
  return result.value;
}

/** The five names the representative authored workflow declares, in one bundle. */
const BUNDLE = [
  { name: "Discovery", path: "workflows/Discovery.md", sourceHash: blob(1) },
  { name: "Implementation", path: "workflows/Implementation.md", sourceHash: blob(2) },
  { name: "InstructionFiles", path: "workflows/InstructionFiles.md", sourceHash: blob(3) },
  { name: "Planning", path: "workflows/Planning.md", sourceHash: blob(4) },
  { name: "UserCheckpoint", path: "workflows/UserCheckpoint.md", sourceHash: blob(5) },
];

/** A distinct SHA-1 blob id per component, so a swap is visible. */
function blob(nth: number): string {
  return `${nth}`.repeat(2).padEnd(40, "0");
}

function bundled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...definition(), components: BUNDLE, ...overrides };
}

function parsedBundle(overrides: Record<string, unknown> = {}): GitWorkflowDefinitionV1 {
  return git(parseWorkflowDefinition(bundled(overrides)));
}

function refusal(value: unknown): WorkflowDefinitionError {
  const result = parseWorkflowDefinition(value);
  if (result.ok) {
    throw new Error("expected the descriptor to be refused");
  }
  if (!(result.error instanceof WorkflowDefinitionError)) {
    throw result.error;
  }
  return result.error;
}

function record(overrides: Partial<GitWorkflowRunRecordV1> = {}): GitWorkflowRunRecordV1 {
  return {
    runId: "release-1.4",
    definition: parsed(),
    base: "main",
    props: { channel: "stable", tags: ["a", "b"] },
    status: "running",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("Tier WD — workflow definition descriptors", () => {
  it("WD1: reads a complete descriptor and round-trips it through JSON", function* () {
    const first = parsed();

    expect(first).toEqual({
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: SHA1,
      rootDocumentPath: "workflows/release.md",
    });

    const again = parseWorkflowDefinition(definitionToJson(first));
    expect(again.ok).toBe(true);
    expect(again.ok && again.value).toEqual(first);
  });

  it("WD2: refuses a member nobody declared", function* () {
    const error = refusal({ ...definition(), repository: "https://example.invalid/a.git" });

    expect(error.path).toBe("$");
    expect(error.message).toContain("expected only the members");
  });

  it("WD3: refuses anything that is not an object", function* () {
    expect(refusal(null).message).toContain("found null");
    expect(refusal([]).message).toContain("found an array");
    expect(refusal("git").message).toContain("found string");
  });

  it("WD4: admits only version 1 and only the git kind", function* () {
    expect(refusal(definition({ version: 2 })).path).toBe("$.version");
    expect(refusal(definition({ kind: "svn" })).path).toBe("$.kind");
  });

  it("WD5: holds an object id to the length its format requires", function* () {
    expect(parsed({ objectFormat: "sha256", objectId: SHA256 }).objectId).toBe(SHA256);

    expect(refusal(definition({ objectFormat: "sha256" })).path).toBe("$.objectId");
    expect(refusal(definition({ objectId: SHA1.slice(1) })).path).toBe("$.objectId");
    expect(refusal(definition({ objectFormat: "sha512" })).path).toBe("$.objectFormat");
  });

  it("WD6: admits lowercase hexadecimal only, so one commit has one spelling", function* () {
    const error = refusal(definition({ objectId: SHA1.toUpperCase() }));

    expect(error.path).toBe("$.objectId");
    expect(error.message).toContain("lowercase");
  });

  it("WD7: refuses a root path that is not repository-relative POSIX", function* () {
    const refused = [
      "",
      "/etc/passwd",
      "workflows\\release.md",
      "./release.md",
      "../release.md",
      "workflows/../release.md",
      "workflows//release.md",
      "workflows/release.md/",
      "workflows/rele\u0000ase.md",
    ];

    for (const rootDocumentPath of refused) {
      expect(refusal(definition({ rootDocumentPath })).path).toBe("$.rootDocumentPath");
    }
  });

  it("WD8: admits an ordinary nested path", function* () {
    expect(parsed({ rootDocumentPath: "a/b/c.md" }).rootDocumentPath).toBe("a/b/c.md");
    expect(parsed({ rootDocumentPath: "release.md" }).rootDocumentPath).toBe("release.md");
    expect(parsed({ rootDocumentPath: ".github/release.md" }).rootDocumentPath).toBe(
      ".github/release.md",
    );
  });

  it("WD9: never repeats what it refused, as a value or as a name", function* () {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

    for (const error of [
      refusal(definition({ objectId: secret })),
      refusal(definition({ rootDocumentPath: `/${secret}` })),
      // A member name is content too: a value carrying a credential as a key
      // is no safer to print than one carrying it as a value.
      refusal({ ...definition(), [secret]: "anything" }),
      refusal({ ...definition(), [`${secret}-nested`]: { deeper: 1 } }),
    ]) {
      expect(error.message).not.toContain(secret);
      expect(error.path).not.toContain(secret);
    }
  });
});

describe("Tier WD — stored record shapes", () => {
  it("WD10: retains exactly the six statuses", function* () {
    expect(WORKFLOW_RUN_STATUSES).toEqual([
      "running",
      "suspended",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("WD11: reads both stop reason variants and refuses a mixture", function* () {
    const host = parseStopReasonInput({ kind: "host", code: "interrupted" });
    expect(host.ok && host.value).toEqual({ kind: "host", code: "interrupted" });

    const journal = parseStopReasonInput({ kind: "journal", eventId: "e17" });
    expect(journal.ok && journal.value).toEqual({ kind: "journal", eventId: "e17" });

    for (const refused of [
      { kind: "host", eventId: "e17" },
      { kind: "journal", code: "interrupted" },
      { kind: "host", code: "interrupted", eventId: "e17" },
      { kind: "other", code: "interrupted" },
      { kind: "host", code: "" },
    ]) {
      const result = parseStopReasonInput(refused);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
    }
  });

  it("WD12: a stop reason carries a code, never a message", function* () {
    const message = "connect ECONNREFUSED 10.0.0.1:5432 while reading /etc/shadow";
    const result = parseStopReasonInput({ kind: "host", code: "interrupted", message });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).not.toContain(message);
  });

  it("WD13: names one value however its keys were ordered", function* () {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("Tier WD — the storage Api without a provider", () => {
  it("WD17: refuses rather than retaining nothing quietly", function* () {
    for (const attempt of [
      function* () {
        yield* WorkflowRunStorage.operations.create({
          runId: "release-1.4",
          definition: parsed(),
          base: "main",
          props: {},
        });
      },
      function* () {
        yield* WorkflowRunStorage.operations.lookup("release-1.4");
      },
    ]) {
      let raised: unknown;
      try {
        yield* attempt();
      } catch (error) {
        raised = error;
      }

      // A run that appears to start and retains nothing has not started, so
      // the default handler says so rather than answering with an empty store.
      expect(raised).toBeInstanceOf(WorkflowStorageProviderError);
    }
  });
});

describe("Tier WD — compatible reuse", () => {
  it("WD14: a request describing the stored run conflicts in nothing", function* () {
    const stored = record();

    expect(
      conflictingFields(stored, {
        runId: stored.runId,
        definition: stored.definition,
        base: stored.base,
        props: { tags: ["a", "b"], channel: "stable" },
      }),
    ).toEqual([]);
  });

  it("WD15: every immutable field is compared, and named when it differs", function* () {
    const stored = record();
    const request = {
      runId: stored.runId,
      definition: stored.definition,
      base: stored.base,
      props: stored.props,
    };

    expect(conflictingFields(stored, { ...request, runId: "other" })).toEqual(["run id"]);
    expect(conflictingFields(stored, { ...request, base: "develop" })).toEqual(["base"]);
    expect(conflictingFields(stored, { ...request, props: { channel: "beta" } })).toEqual([
      "props",
    ]);

    for (const changed of [
      parsed({ objectId: SHA1.replace("9", "a") }),
      parsed({ rootDocumentPath: "workflows/other.md" }),
      parsed({ objectFormat: "sha256", objectId: SHA256 }),
    ]) {
      expect(conflictingFields(stored, { ...request, definition: changed })).toEqual([
        "definition",
      ]);
    }
  });

  it("WD16: what a run accumulates takes no part in the comparison", function* () {
    const request = {
      runId: "release-1.4",
      definition: parsed(),
      base: "main",
      props: { channel: "stable", tags: ["a", "b"] },
    };

    for (const status of WORKFLOW_RUN_STATUSES) {
      expect(conflictingFields(record({ status }), request)).toEqual([]);
    }

    expect(
      conflictingFields(
        record({
          status: "failed",
          stopReason: { kind: "journal", eventId: "e17" },
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        }),
        request,
      ),
    ).toEqual([]);
  });
});

/**
 * Every target form this suite exercises, and whether a descriptor may carry it.
 *
 * Canonical encoding escapes everything outside RFC 3986's unreserved set, so
 * a heading holding `/`, `*`, `#`, `%`, or a space is retained as an escape and
 * cannot be read back as hierarchy or operator syntax.
 */
const CANONICAL_TARGETS = [
  "Release",
  "Release/Publish",
  "Release/Publish/Notes",
  "Release%2FNotes",
  "star%2A",
  "hash%23tag",
  "pct%25value",
  "two%20words",
  "%C3%9Cn%C3%AFc%C3%B8d%C3%A9",
];

const REFUSED_TARGETS = [
  "",
  "#Release",
  "Release/*",
  "**",
  "Rel*ease",
  "Release/**/Notes",
  "%zz",
  "%2f",
  "Release/",
  "/Release",
  "Release//Notes",
  "Release ",
  " Release",
  "Two  words",
  "éclair",
];

describe("Tier WD — a definition's exact document target", () => {
  it("WD18: an untargeted descriptor writes no target member at all", function* () {
    const untargeted = parsed();

    expect("targetPath" in untargeted).toBe(false);
    expect(Object.keys(definitionToJson(untargeted) as Record<string, unknown>)).toEqual([
      "version",
      "kind",
      "objectFormat",
      "objectId",
      "rootDocumentPath",
    ]);
  });

  it("WD19: a targeted descriptor round-trips its exact target unchanged", function* () {
    const targeted = parsed({ targetPath: "Release/Publish" });

    expect(targeted.targetPath).toBe("Release/Publish");

    const json = definitionToJson(targeted) as Record<string, unknown>;
    expect(json["targetPath"]).toBe("Release/Publish");

    const again = parseWorkflowDefinition(json);
    expect(again.ok && again.value).toEqual(targeted);
  });

  it("WD20: every canonical target survives byte for byte", function* () {
    for (const targetPath of CANONICAL_TARGETS) {
      const stored = parsed({ targetPath });
      expect({ targetPath, stored: stored.targetPath }).toEqual({ targetPath, stored: targetPath });

      const again = parseWorkflowDefinition(definitionToJson(stored));
      expect({ targetPath, ok: again.ok }).toEqual({ targetPath, ok: true });
      expect(again.ok && again.value.targetPath).toBe(targetPath);
    }
  });

  it("WD21: a target that is not exactly canonical is refused at its own path", function* () {
    for (const targetPath of REFUSED_TARGETS) {
      const error = refusal(definition({ targetPath }));
      expect({ targetPath, path: error.path }).toEqual({ targetPath, path: "$.targetPath" });
      expect(error.message).toContain("expected one exact canonical document target");
      // A canonical target encodes heading text, so the diagnostic says nothing
      // about the one it read. The empty target is skipped because every string
      // contains it.
      if (targetPath !== "") {
        expect(error.message).not.toContain(targetPath);
      }
    }
  });

  it("WD22: a present target that is not a string is refused, absence excepted", function* () {
    for (const value of [undefined, null, 1, true, ["Release"], { path: "Release" }]) {
      const error = refusal(definition({ targetPath: value }));
      expect({ value, path: error.path }).toEqual({ value, path: "$.targetPath" });
      expect(error.message).toContain("expected a string");
    }
  });

  it("WD23: the public core predicate answers exactly as definition parsing does", function* () {
    for (const targetPath of CANONICAL_TARGETS) {
      expect({ targetPath, canonical: isCanonicalDocumentTarget(targetPath) }).toEqual({
        targetPath,
        canonical: true,
      });
    }
    for (const targetPath of REFUSED_TARGETS) {
      expect({ targetPath, canonical: isCanonicalDocumentTarget(targetPath) }).toEqual({
        targetPath,
        canonical: false,
      });
    }
  });

  it("WD24: a run of one section is not a run of the whole document", function* () {
    const whole = record();
    const section = record({ definition: parsed({ targetPath: "Release/Publish" }) });
    const other = record({ definition: parsed({ targetPath: "Release/Announce" }) });

    const asking = (stored: GitWorkflowRunRecordV1, definition: GitWorkflowDefinitionV1) =>
      conflictingFields(stored, {
        runId: stored.runId,
        definition,
        base: stored.base,
        props: stored.props,
      });

    // The same exact target is the same run.
    expect(asking(section, section.definition)).toEqual([]);
    expect(asking(whole, whole.definition)).toEqual([]);

    // Whole-document and targeted are different runs, in both directions.
    expect(asking(whole, section.definition)).toEqual(["definition"]);
    expect(asking(section, whole.definition)).toEqual(["definition"]);

    // So are two different sections of one document.
    expect(asking(section, other.definition)).toEqual(["definition"]);
  });
});

/**
 * Tier WD — the component bundle a definition is closed over.
 *
 * The bundle is a member of the one descriptor rather than a version past it.
 * Absent, it identifies a run closed over no components — which is what every
 * definition retained before bundles existed is. Present, it is the exact set
 * the root may resolve, and it is identity: canonical, one entry per name,
 * sorted by name, each holding the blob's own object id under the descriptor's
 * own format.
 */
describe("Tier WD — the component bundle a definition is closed over", () => {
  it("WD25: a descriptor closed over no bundle writes no bundle member", function* () {
    const first = parsed();

    expect("components" in first).toBe(false);
    expect(Object.keys(definitionToJson(first) as Record<string, unknown>)).toEqual([
      "version",
      "kind",
      "objectFormat",
      "objectId",
      "rootDocumentPath",
    ]);
    expect(definitionComponents(first)).toEqual([]);
  });

  it("WD26: a bundled descriptor round-trips its whole bundle unchanged", function* () {
    const bundle = parsedBundle();

    expect(bundle.version).toBe(1);
    expect(bundle.components).toEqual(BUNDLE);
    expect(definitionComponents(bundle)).toEqual(BUNDLE);

    const json = definitionToJson(bundle) as Record<string, unknown>;
    expect(json["components"]).toEqual(BUNDLE);

    const again = parseWorkflowDefinition(json);
    expect(again.ok).toBe(true);
    expect(again.ok && again.value).toEqual(bundle);
  });

  it("WD27: a bundle's hashes are held to the format the descriptor names", function* () {
    const sha256 = parsedBundle({
      objectFormat: "sha256",
      objectId: SHA256,
      components: [{ name: "Discovery", path: "workflows/Discovery.md", sourceHash: SHA256 }],
    });
    expect(definitionComponents(sha256)).toEqual([
      { name: "Discovery", path: "workflows/Discovery.md", sourceHash: SHA256 },
    ]);

    // The same entry under sha1 is the wrong length, and the sha1 bundle is the
    // wrong length under sha256: neither is a hash this descriptor could hold.
    expect(refusal(bundled({ components: definitionComponents(sha256) })).path).toBe(
      "$.components[0].sourceHash",
    );
    expect(refusal(bundled({ objectFormat: "sha256", objectId: SHA256 })).path).toBe(
      "$.components[0].sourceHash",
    );
    expect(
      refusal(bundled({ components: [{ ...BUNDLE[0], sourceHash: SHA1.toUpperCase() }] })).message,
    ).toContain("lowercase");
  });

  it("WD28: the bundle is canonical — one entry per name, sorted by name", function* () {
    const reversed = [...BUNDLE].reverse();
    expect(refusal(bundled({ components: reversed })).message).toContain("sorted by name");

    const duplicated = [BUNDLE[0], BUNDLE[0]];
    expect(refusal(bundled({ components: duplicated })).message).toContain("once");

    expect(refusal(bundled({ components: [] })).message).toContain("at least one component");
    expect(refusal(bundled({ components: {} })).path).toBe("$.components");
  });

  it("WD29: each entry is closed, and names a Markdown path inside the tree", function* () {
    expect(refusal(bundled({ components: [{ ...BUNDLE[0], origin: "elsewhere" }] })).path).toBe(
      "$.components[0]",
    );
    expect(refusal(bundled({ components: [{ name: "Discovery", path: "a.md" }] })).path).toBe(
      "$.components[0].sourceHash",
    );
    expect(refusal(bundled({ components: [{ ...BUNDLE[0], name: "discovery" }] })).path).toBe(
      "$.components[0].name",
    );

    for (const path of [
      "",
      "/etc/passwd",
      "workflows\\Discovery.md",
      "./Discovery.md",
      "../Discovery.md",
      "workflows/../Discovery.md",
      "workflows//Discovery.md",
      "workflows/Discovery.md/",
      "workflows/Discovery.ts",
      "workflows/Discovery",
    ]) {
      expect({
        path,
        at: refusal(bundled({ components: [{ ...BUNDLE[0], path }] })).path,
      }).toEqual({ path, at: "$.components[0].path" });
    }
  });

  it("WD30: a descriptor retained before bundles existed still reads", function* () {
    // The exact JSON a run stored before the member existed. It parses, it
    // means "closed over no components", and it serializes back byte for byte
    // — which is what keeps the bundle a member rather than a second version.
    const retained = {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: SHA1,
      rootDocumentPath: "workflows/release.md",
    };
    const again = parseWorkflowDefinition(retained);

    expect(again.ok).toBe(true);
    expect(definitionComponents(git(again))).toEqual([]);
    expect(definitionToJson(git(again))).toEqual(retained);

    // Presence is the member being written at all: a descriptor that wrote it
    // and named no bundle asked for one and failed to say which.
    expect(refusal({ ...retained, components: undefined }).path).toBe("$.components");
    expect(refusal({ ...retained, components: null }).path).toBe("$.components");
  });

  it("WD31: a refusal never repeats the bundle it refused", function* () {
    // A distinctive string rather than a credential-shaped one: what is proved
    // is that no part of a refused entry is echoed, and a value that is not a
    // token proves it just as well. WD9 keeps the token-shaped canary for the
    // descriptor's own members, where nothing this suite adds changes it.
    const canary = "never-printed-canary-b7a1e9";

    for (const error of [
      refusal(bundled({ components: [{ ...BUNDLE[0], path: `/${canary}.md` }] })),
      refusal(bundled({ components: [{ ...BUNDLE[0], sourceHash: canary }] })),
      refusal(bundled({ components: [{ ...BUNDLE[0], name: canary }] })),
      refusal(bundled({ components: [{ ...BUNDLE[0], [canary]: 1 }] })),
    ]) {
      expect(error.message).not.toContain(canary);
      expect(error.path).not.toContain(canary);
    }
  });
});

describe("Tier WD — a bundle decides compatible reuse", () => {
  const stored = record({ definition: parsedBundle() });
  const asking = (definition: GitWorkflowDefinitionV1) =>
    conflictingFields(stored, {
      runId: stored.runId,
      definition,
      base: stored.base,
      props: stored.props,
    });

  it("WD32: the same bundle is the same run", function* () {
    expect(asking(parsedBundle())).toEqual([]);
  });

  it("WD33: a changed name, path, hash, or set is a different definition", function* () {
    const renamed = [...BUNDLE.slice(1), { ...BUNDLE[0], name: "Zeroth" }].sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    const moved = [{ ...BUNDLE[0], path: "workflows/other/Discovery.md" }, ...BUNDLE.slice(1)];
    const rehashed = [{ ...BUNDLE[0], sourceHash: blob(9) }, ...BUNDLE.slice(1)];
    const fewer = BUNDLE.slice(1);

    for (const components of [renamed, moved, rehashed, fewer]) {
      expect(asking(parsedBundle({ components }))).toEqual(["definition"]);
    }
  });

  it("WD34: a run closed over a bundle is not a run closed over none", function* () {
    expect(asking(parsed())).toEqual(["definition"]);

    const unbundled = record();
    expect(
      conflictingFields(unbundled, {
        runId: unbundled.runId,
        definition: parsedBundle(),
        base: unbundled.base,
        props: unbundled.props,
      }),
    ).toEqual(["definition"]);
  });

  it("WD35: what a run accumulates still takes no part in the comparison", function* () {
    for (const status of WORKFLOW_RUN_STATUSES) {
      expect(
        conflictingFields(record({ definition: parsedBundle(), status }), {
          runId: stored.runId,
          definition: parsedBundle(),
          base: stored.base,
          props: stored.props,
        }),
      ).toEqual([]);
    }
  });
});

/**
 * Tier WD — the source bundle a definition retains.
 *
 * Version 2 is not a looser version 1. Its identity is the bytes themselves,
 * addressed by logical paths that are portable names inside the bundle rather
 * than anything a filesystem hands out — so the questions here are what a path
 * may be, what order a manifest may arrive in, and what exactly the two
 * domain-separated hashes are computed over.
 *
 * The hash vectors below were produced by a separate implementation of the
 * specified framing rather than by the code under test. A vector derived from
 * the implementation would agree with whatever framing it happened to have.
 */

const encoder = new TextEncoder();

/** Three logical paths, in the canonical UTF-8 byte order of the manifest. */
const ROOT_PATH = "release.md";
/** U+FB01, whose UTF-8 sorts before the emoji and whose UTF-16 sorts after it. */
const LIGATURE_PATH = "\uFB01.md";
const EMOJI_PATH = "\u{1F600}.md";

const ROOT_TEXT = "# Release\n";
const EMOJI_TEXT = "# \u00DCn\u00EFc\u00F8d\u00E9\n";

const ROOT_BYTES = encoder.encode(ROOT_TEXT);
const LIGATURE_BYTES = new Uint8Array(0);
const EMOJI_BYTES = encoder.encode(EMOJI_TEXT);

const ROOT_HASH = "b78cd463c5885c1b595de07f665ce82b61df6636eb8c5f00cf11985cbfeb986d";
const LIGATURE_HASH = "32b9c0cb4d326ff21913998350eccb9cd8c437576eafcbe0bc79833e90a7cd3c";
const EMOJI_HASH = "3c81db896c70d1bdd74b0318f509d475248ae03b111e7f7c0b96fc10b26b6fbf";

/** The whole three-source bundle, with its component mapping. */
const BUNDLE_HASH = "078f7cf1b61cad754ad9d03333df0027a477d5a2cee967903c54b147c29c37e3";
/** The same three sources, declaring no components. */
const UNMAPPED_HASH = "4ac6d339215f887347b0226f388b86e010e8d60e41c4eac7eed5b61f791f5e29";
/** The entrypoint alone, which is what a root declaring no components retains. */
const SOLO_HASH = "adc2c8e139c6956377090d3f2b26471f461164020c0e28812cda91dcdbceb419";

const SOURCES = [
  { path: ROOT_PATH, sourceHash: ROOT_HASH, byteLength: 10 },
  { path: LIGATURE_PATH, sourceHash: LIGATURE_HASH, byteLength: 0 },
  { path: EMOJI_PATH, sourceHash: EMOJI_HASH, byteLength: 14 },
];

const COMPONENTS = [
  { name: "Discovery", path: LIGATURE_PATH },
  { name: "Planning", path: EMOJI_PATH },
];

const SNAPSHOT = [
  { path: ROOT_PATH, bytes: ROOT_BYTES },
  { path: LIGATURE_PATH, bytes: LIGATURE_BYTES },
  { path: EMOJI_PATH, bytes: EMOJI_BYTES },
];

/** A v2 descriptor, loosely typed: half of these tests build ones that are wrong. */
function bundleV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    kind: "source-bundle",
    hashAlgorithm: "sha256",
    bundleHash: BUNDLE_HASH,
    entrypoint: ROOT_PATH,
    sources: SOURCES,
    components: COMPONENTS,
    ...overrides,
  };
}

/** The same three sources with no `components` member written at all. */
function unmappedV2(): Record<string, unknown> {
  return {
    version: 2,
    kind: "source-bundle",
    hashAlgorithm: "sha256",
    bundleHash: UNMAPPED_HASH,
    entrypoint: ROOT_PATH,
    sources: SOURCES,
  };
}

/** The one-source descriptor a root declaring no components produces. */
function soloV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    kind: "source-bundle",
    hashAlgorithm: "sha256",
    bundleHash: SOLO_HASH,
    entrypoint: ROOT_PATH,
    sources: [SOURCES[0]],
    ...overrides,
  };
}

function parsedV2(value: Record<string, unknown>): SourceBundleWorkflowDefinitionV2 {
  const result = parseSourceBundleDefinition(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function v2Refusal(value: unknown): WorkflowDefinitionError {
  const result = parseSourceBundleDefinition(value);
  if (result.ok) {
    throw new Error("expected the descriptor to be refused");
  }
  if (!(result.error instanceof WorkflowDefinitionError)) {
    throw result.error;
  }
  return result.error;
}

/** A one-entry manifest carrying one deliberately wrong path. */
function sourceAt(path: unknown): Record<string, unknown>[] {
  return [{ path, sourceHash: ROOT_HASH, byteLength: 10 }];
}

/**
 * The members one serialized descriptor wrote, in the order it wrote them.
 *
 * Narrowed rather than asserted: presentation order is what these cases are
 * about, and a cast would make the claim hold for a serializer that answered
 * with an array or a scalar.
 */
function jsonMembers(value: Json): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected the serialized descriptor to be a JSON object");
  }
  return Object.keys(value);
}

/** Every logical path this grammar refuses, whichever member carries it. */
const REFUSED_PATHS = [
  "",
  "/release.md",
  "release.md/",
  "workflows//release.md",
  "./release.md",
  "../release.md",
  "workflows/../release.md",
  "workflows\\release.md",
  "rele#ase.md",
  "rele\u0000ase.md",
  "rele\u0001ase.md",
  "rele\u001Fase.md",
  "rele\u007Fase.md",
  // Decomposed: `e` followed by a combining acute is a second spelling of a
  // path that already has one, and two spellings would be two identities.
  "cafe\u0301.md",
  // Not a Unicode scalar value: encoding it would substitute U+FFFD and hash
  // bytes nobody supplied.
  "\uD800.md",
];

describe("Tier WD — a source-bundle descriptor", () => {
  it("WD36: reads a complete descriptor and round-trips it in presentation order", function* () {
    const first = parsedV2(bundleV2({ targetPath: "Release/Publish" }));

    expect(first).toEqual({
      version: 2,
      kind: "source-bundle",
      hashAlgorithm: "sha256",
      bundleHash: BUNDLE_HASH,
      entrypoint: ROOT_PATH,
      sources: SOURCES,
      targetPath: "Release/Publish",
      components: COMPONENTS,
    });

    const json = sourceBundleDefinitionToJson(first);
    expect(jsonMembers(json)).toEqual([
      "version",
      "kind",
      "hashAlgorithm",
      "bundleHash",
      "entrypoint",
      "sources",
      "targetPath",
      "components",
    ]);

    const again = parseSourceBundleDefinition(json);
    expect(again.ok).toBe(true);
    expect(again.ok && again.value).toEqual(first);
  });

  it("WD37: admits exactly its own members, and only version 2 source bundles", function* () {
    // Neither the host path the bytes were read from nor the props a run was
    // started with is a member of this shape, so neither reaches the identity.
    expect(v2Refusal({ ...bundleV2(), sourcePath: "/home/ada/release.md" }).path).toBe("$");
    expect(v2Refusal({ ...bundleV2(), props: { channel: "stable" } }).path).toBe("$");
    expect(v2Refusal({ ...bundleV2(), base: "main" }).path).toBe("$");

    expect(v2Refusal(null).message).toContain("found null");
    expect(v2Refusal([]).message).toContain("found an array");
    expect(v2Refusal(bundleV2({ version: 1 })).path).toBe("$.version");
    expect(v2Refusal(bundleV2({ kind: "git" })).path).toBe("$.kind");
    expect(v2Refusal(bundleV2({ hashAlgorithm: "sha1" })).path).toBe("$.hashAlgorithm");
  });

  it("WD38: a logical path is a portable name, not something a host handed out", function* () {
    for (const path of REFUSED_PATHS) {
      expect({ path, at: v2Refusal(soloV2({ sources: sourceAt(path) })).path }).toEqual({
        path,
        at: "$.sources[0].path",
      });
    }

    expect(v2Refusal(soloV2({ sources: sourceAt(42) })).message).toContain("expected a string");
    // The two non-ASCII paths are ordinary logical paths and survive exactly.
    expect(parsedV2(bundleV2()).sources.map((source) => source.path)).toEqual([
      ROOT_PATH,
      LIGATURE_PATH,
      EMOJI_PATH,
    ]);
  });

  it("WD39: the entrypoint is Markdown the bundle actually retains", function* () {
    expect(v2Refusal(soloV2({ entrypoint: "release.txt" })).message).toContain('expected a ".md"');
    expect(v2Refusal(soloV2({ entrypoint: "other.md" })).message).toContain(
      "expected a path this definition retains as a source",
    );
    expect(v2Refusal(soloV2({ entrypoint: "/release.md" })).path).toBe("$.entrypoint");
    expect(v2Refusal(soloV2({ entrypoint: 7 })).path).toBe("$.entrypoint");
  });

  it("WD40: the manifest is ordered by UTF-8 bytes, which is not string order", function* () {
    // The discriminating pair. `<` on strings compares UTF-16 code units, so it
    // sorts the supplementary character before the ligature while UTF-8 sorts
    // the ligature first: a parser that used `<` would admit the wrong array.
    const byCodeUnit = [...SOURCES].sort((left, right) => (left.path < right.path ? -1 : 1));
    expect(byCodeUnit.map((source) => source.path)).toEqual([ROOT_PATH, EMOJI_PATH, LIGATURE_PATH]);
    expect(v2Refusal(bundleV2({ sources: byCodeUnit })).message).toContain("UTF-8 bytes");

    expect(v2Refusal(bundleV2({ sources: [...SOURCES].reverse() })).message).toContain(
      "UTF-8 bytes",
    );
    expect(v2Refusal(bundleV2({ sources: [SOURCES[0], SOURCES[0]] })).message).toContain(
      "each source path once",
    );
    expect(v2Refusal(bundleV2({ sources: [] })).message).toContain("at least one source");
    expect(v2Refusal(bundleV2({ sources: {} })).path).toBe("$.sources");
  });

  it("WD41: a component mapping is closed over the sources declared beside it", function* () {
    const solo = parsedV2(soloV2());
    expect("components" in solo).toBe(false);
    expect(sourceBundleComponents(solo)).toEqual([]);
    expect(jsonMembers(sourceBundleDefinitionToJson(solo))).toEqual([
      "version",
      "kind",
      "hashAlgorithm",
      "bundleHash",
      "entrypoint",
      "sources",
    ]);

    // Declaring none and declaring an empty set are not two spellings of one
    // thing: the second asked for a bundle and named nothing.
    expect(v2Refusal(bundleV2({ components: [] })).message).toContain("at least one component");
    expect(v2Refusal(bundleV2({ components: undefined })).path).toBe("$.components");
    expect(v2Refusal(bundleV2({ components: null })).path).toBe("$.components");

    expect(
      v2Refusal(bundleV2({ components: [{ name: "Discovery", path: "absent.md" }] })).message,
    ).toContain("expected a path this definition retains as a source");
    expect(
      v2Refusal(bundleV2({ components: [{ ...COMPONENTS[0], sourceHash: ROOT_HASH }] })).path,
    ).toBe("$.components[0]");
    expect(
      v2Refusal(bundleV2({ components: [{ ...COMPONENTS[0], name: "discovery" }] })).path,
    ).toBe("$.components[0].name");
    expect(v2Refusal(bundleV2({ components: [...COMPONENTS].reverse() })).message).toContain(
      "UTF-8 bytes",
    );
    expect(v2Refusal(bundleV2({ components: [COMPONENTS[0], COMPONENTS[0]] })).message).toContain(
      "each component name once",
    );
  });

  it("WD42: a hash has one spelling, and a length is a count of bytes", function* () {
    expect(v2Refusal(bundleV2({ bundleHash: BUNDLE_HASH.toUpperCase() })).message).toContain(
      "lowercase",
    );
    expect(v2Refusal(bundleV2({ bundleHash: BUNDLE_HASH.slice(1) })).message).toContain(
      "64 hexadecimal digits",
    );
    expect(v2Refusal(bundleV2({ bundleHash: `${BUNDLE_HASH}0` })).path).toBe("$.bundleHash");
    expect(v2Refusal(bundleV2({ bundleHash: `z${BUNDLE_HASH.slice(1)}` })).path).toBe(
      "$.bundleHash",
    );
    expect(v2Refusal(soloV2({ sources: [{ ...SOURCES[0], sourceHash: "abc" }] })).path).toBe(
      "$.sources[0].sourceHash",
    );

    for (const byteLength of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "10", null]) {
      expect({
        byteLength,
        at: v2Refusal(soloV2({ sources: [{ ...SOURCES[0], byteLength }] })).path,
      }).toEqual({ byteLength, at: "$.sources[0].byteLength" });
    }
    // Zero is a length a source may have: an empty file is exact bytes too.
    expect(parsedV2(bundleV2()).sources[1].byteLength).toBe(0);
  });

  it("WD43: the exact target is present or absent, never synthesized", function* () {
    expect("targetPath" in parsedV2(bundleV2())).toBe(false);
    expect(parsedV2(bundleV2({ targetPath: "Release/Publish" })).targetPath).toBe(
      "Release/Publish",
    );

    for (const targetPath of ["#Release", "Release/*", "Release/", undefined, null, 1]) {
      expect({ targetPath, at: v2Refusal(bundleV2({ targetPath })).path }).toEqual({
        targetPath,
        at: "$.targetPath",
      });
    }
  });

  it("WD44: a refusal never repeats the bundle it refused", function* () {
    const canary = "never-printed-canary-4c1f8a";

    for (const error of [
      v2Refusal(bundleV2({ entrypoint: `/${canary}.md` })),
      v2Refusal(soloV2({ sources: sourceAt(`/${canary}.md`) })),
      v2Refusal(soloV2({ sources: [{ ...SOURCES[0], sourceHash: canary }] })),
      v2Refusal(bundleV2({ components: [{ ...COMPONENTS[0], name: canary }] })),
      v2Refusal({ ...bundleV2(), [canary]: 1 }),
    ]) {
      expect(error.message).not.toContain(canary);
      expect(error.path).not.toContain(canary);
    }
  });
});

describe("Tier WD — what a source bundle hashes", () => {
  it("WD45: a source hash is its domain, its length and its exact bytes", function* () {
    expect(yield* sourceContentHash(ROOT_BYTES)).toBe(ROOT_HASH);
    // Zero-length content still hashes its domain and its declared length, so
    // an empty source is a source rather than an absent one.
    expect(yield* sourceContentHash(LIGATURE_BYTES)).toBe(LIGATURE_HASH);
    // Fourteen bytes behind ten characters: the framing commits to the bytes.
    expect(EMOJI_BYTES.byteLength).toBe(14);
    expect(EMOJI_TEXT.length).toBe(10);
    expect(yield* sourceContentHash(EMOJI_BYTES)).toBe(EMOJI_HASH);

    // One byte more is a different source.
    expect(yield* sourceContentHash(encoder.encode(`${ROOT_TEXT}\n`))).not.toBe(ROOT_HASH);
  });

  it("WD46: a bundle hash is the entrypoint, the manifest and the mapping", function* () {
    expect(yield* sourceBundleHash(parsedV2(bundleV2()))).toBe(BUNDLE_HASH);

    // Dropping the mapping is a different bundle over the same three sources.
    expect(yield* sourceBundleHash(parsedV2(unmappedV2()))).toBe(UNMAPPED_HASH);
    expect(UNMAPPED_HASH).not.toBe(BUNDLE_HASH);

    expect(yield* sourceBundleHash(parsedV2(soloV2()))).toBe(SOLO_HASH);
  });

  it("WD47: the target is outside the bundle hash and inside the descriptor", function* () {
    const whole = parsedV2(bundleV2());
    const section = parsedV2(bundleV2({ targetPath: "Release/Publish" }));
    const other = parsedV2(bundleV2({ targetPath: "Release/Announce" }));

    // Selecting a section does not change the bytes in the bundle, so all three
    // carry the one hash this manifest produces.
    for (const descriptor of [whole, section, other]) {
      expect(yield* sourceBundleHash(descriptor)).toBe(BUNDLE_HASH);
      expect(descriptor.bundleHash).toBe(BUNDLE_HASH);
    }
    // And the three descriptors remain three identities.
    expect(section.targetPath).not.toBe(other.targetPath);
    expect("targetPath" in whole).toBe(false);
  });

  it("WD48: a descriptor whose own manifest disagrees with its hash is refused", function* () {
    const honest = yield* verifySourceBundleDefinition(parsedV2(bundleV2()));
    expect(honest.ok).toBe(true);

    // Another bundle's hash, worn by this one. It parses — the grammar is
    // satisfied — and it does not describe itself.
    const lying = yield* verifySourceBundleDefinition(
      parsedV2(bundleV2({ bundleHash: SOLO_HASH })),
    );
    expect(lying.ok).toBe(false);
    expect(!lying.ok && lying.error).toBeInstanceOf(WorkflowDefinitionError);
    expect(!lying.ok && lying.error.message).toContain("$.bundleHash");
  });
});

describe("Tier WD — the snapshot a source bundle is created from", () => {
  it("WD49: the accepted snapshot is a copy, so a later mutation is inert", function* () {
    const mine = encoder.encode(ROOT_TEXT);
    const offered = [
      { path: ROOT_PATH, bytes: mine },
      { path: LIGATURE_PATH, bytes: LIGATURE_BYTES },
      { path: EMOJI_PATH, bytes: EMOJI_BYTES },
    ];

    const accepted = yield* verifySourceBundleSnapshot(parsedV2(bundleV2()), offered);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      throw accepted.error;
    }

    mine[0] = 0x21;
    expect(Array.from(mine.slice(0, 1))).toEqual([0x21]);
    expect(Array.from(accepted.value[0].bytes)).toEqual(Array.from(ROOT_BYTES));
    expect(yield* sourceContentHash(accepted.value[0].bytes)).toBe(ROOT_HASH);
    expect(accepted.value.map((entry) => entry.path)).toEqual([
      ROOT_PATH,
      LIGATURE_PATH,
      EMOJI_PATH,
    ]);
  });

  it("WD50: a snapshot that is not exactly the manifest retains nothing", function* () {
    const descriptor = parsedV2(bundleV2());

    for (const snapshot of [
      SNAPSHOT.slice(1),
      [...SNAPSHOT, { path: "extra.md", bytes: ROOT_BYTES }],
      [SNAPSHOT[0], SNAPSHOT[2], SNAPSHOT[1]],
      [{ path: LIGATURE_PATH, bytes: ROOT_BYTES }, ...SNAPSHOT.slice(1)],
      [{ path: ROOT_PATH, bytes: encoder.encode("# Release") }, ...SNAPSHOT.slice(1)],
      [{ path: ROOT_PATH, bytes: encoder.encode("# release\n") }, ...SNAPSHOT.slice(1)],
      [],
      {},
    ]) {
      const result = yield* verifySourceBundleSnapshot(descriptor, snapshot);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
      // The bytes a caller offered are the document, so a refusal names the
      // position that disagreed and nothing about what it held.
      expect(!result.ok && result.error.message).not.toContain("# Release");
    }
  });

  it("WD51: a snapshot entry admits exactly a path and its bytes", function* () {
    const descriptor = parsedV2(soloV2());

    for (const snapshot of [
      [{ path: ROOT_PATH, bytes: ROOT_BYTES, origin: "/home/ada/release.md" }],
      [{ path: ROOT_PATH }],
      [{ path: ROOT_PATH, bytes: ROOT_TEXT }],
      [{ path: ROOT_PATH, bytes: Array.from(ROOT_BYTES) }],
      [{ bytes: ROOT_BYTES }],
      [ROOT_PATH],
      [null],
    ]) {
      const result = yield* verifySourceBundleSnapshot(descriptor, snapshot);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(WorkflowRequestError);
    }

    // The one snapshot that does describe this definition is accepted.
    const accepted = yield* verifySourceBundleSnapshot(descriptor, [SNAPSHOT[0]]);
    expect(accepted.ok).toBe(true);
  });

  it("WD52: a retained source reads as UTF-8 strictly, and without normalization", function* () {
    const text = decodeSourceText(EMOJI_BYTES);
    expect(text.ok && text.value).toBe(EMOJI_TEXT);
    expect(decodeSourceText(LIGATURE_BYTES).ok).toBe(true);

    // A byte-order mark is content, not punctuation to be swallowed: the bytes
    // are the identity, and dropping three of them changes what parses.
    const marked = decodeSourceText(encoder.encode(`\uFEFF${ROOT_TEXT}`));
    expect(marked.ok && marked.value).toBe(`\uFEFF${ROOT_TEXT}`);

    // Decomposed content stays decomposed. Normalizing it here would hand the
    // document parser text the bundle hash does not describe.
    const decomposed = decodeSourceText(encoder.encode("cafe\u0301\n"));
    expect(decomposed.ok && decomposed.value).toBe("cafe\u0301\n");
    expect(decomposed.ok && decomposed.value).not.toBe("caf\u00E9\n");

    const invalid = decodeSourceText(new Uint8Array([0x23, 0x20, 0xff, 0xfe]));
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error).toBeInstanceOf(WorkflowRequestError);
  });
});
