/**
 * Default-on secret detection for programmatic execution (#199).
 *
 * Two independent properties are under test, and they are defended by
 * different mechanisms:
 *
 * 1. **The journal gate.** `execute()` selects the guarded stream before
 *    `durableRun` starts, so the first root import is already covered. The gate
 *    is a closure over the execution's private scanner and reads no context
 *    afterwards — which is why nothing a document does to any context can
 *    reach it.
 * 2. **The contextual surface.** `secretPolicy()` hands back a detached
 *    description and `scanSecrets()` resolves the execution's policy when it is
 *    interpreted. No scanner, scanner-bound closure, or fingerprint key ever
 *    leaves the execution, and an unauthentic policy fails closed rather than
 *    reporting "disabled".
 *
 * Every credential here is synthetic and assembled at run time, so no
 * usable-looking literal enters the repository and normal scanning does not
 * detect the fixtures themselves. No test reads an environment variable, Git
 * credential, or user configuration.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, createContext, Err, Ok, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "../src/types.ts";
import { forEach } from "@effectionx/stream-helpers";
import {
  createDurableOperation,
  durableRun,
  establishJournalProvenance,
  InMemoryStream,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import type {
  DurableEvent,
  DurableStream,
  JournalProvenance,
  LiveDurableOperationCoordinator,
  Result as DurableResult,
  Workflow,
} from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { Stdio } from "@effectionx/process";
import { execute, Execution } from "../src/execute.ts";
import { inlineSource } from "../src/root-source.ts";
import { registerComponents } from "../src/components/registration.ts";
import { createScannerWith, createSecretScanner } from "../src/secrets/scanner.ts";
import type { SecretScanner } from "../src/secrets/scanner.ts";
import type { SecretFinding } from "../src/secrets/findings.ts";
import {
  scanSecrets,
  secretPolicy,
  useSecretDetection,
  useSecretScannerFactory,
} from "../src/secrets/policy.ts";
import { secretLintProfiler } from "@secretlint/profiler";
import type { SecretPolicy } from "../src/secrets/policy.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A synthetic GitHub token, format-realistic and assembled here. */
const CANARY = ["ghp", "_", ALPHABET.slice(0, 36)].join("");

/**
 * The name the private policy context is bound under.
 *
 * Written out rather than imported: Effection resolves contexts by name, so an
 * attacker constructs the name from the source. Hard-coding it is what makes
 * the counterfeit tests an actual attack instead of a demonstration.
 */
const POLICY_CONTEXT = "executablemd.secrets.policy";

const Counterfeit = createContext<unknown>(POLICY_CONTEXT);

/** A root whose own source carries the canary, so the import event does. */
const TAINTED = `# Tainted

The token is ${CANARY} and must never reach a backend.
`;

/** A clean root whose command output carries the canary — a later event. */
const LEAKING = `# Leaking

\`\`\`bash exec
print-token
\`\`\`
`;

/** A clean root that journals several events. */
const CLEAN = `# Clean

\`\`\`bash exec
echo first
\`\`\`

\`\`\`bash exec
echo second
\`\`\`
`;

/** A root that declares the request field as one of its own props. */
const DECLARING = `---
props:
  secretDetection:
    type: boolean
---

# Declaring

\`\`\`bash exec
print-token
\`\`\`
`;

/** A root that writes the request field into its frontmatter metadata. */
const FRONTMATTER = `---
meta:
  secretDetection: false
---

# Frontmatter

\`\`\`bash exec
print-token
\`\`\`
`;

/** A root that runs a component which counterfeits the policy context first. */
const SPOOFING = `# Spoofing

<Spoof />

\`\`\`bash exec
print-token
\`\`\`
`;

function label(event: DurableEvent): string {
  if (event.type === "yield") {
    return `yield(${event.description.type})`;
  }
  return `close(${event.coroutineId})`;
}

/** Every command answers with `output`, so no real shell runs. */
/**
 * A stand-in child, which displays what it claims to have written.
 *
 * Retention reads the same chain a reader does (#441), so a stub that returned
 * text without writing it would leave nothing for the journal to hold — and
 * nothing for the secret gate to inspect.
 */
function* useExecOutput(output: string): Operation<void> {
  yield* API.Process.around({
    *exec([options]) {
      yield* Stdio.operations.stdout(new TextEncoder().encode(output));
      return options.retain === false
        ? { exitCode: 0, stdout: undefined, stderr: undefined }
        : { exitCode: 0, stdout: output, stderr: "" };
    },
  });
}

/** What the execution asked its factory for, and what it scanned. */
interface ScannerProbe {
  created: SecretScanner[];
  scanned: string[];
}

function probe(): ScannerProbe {
  return { created: [], scanned: [] };
}

/**
 * Install a factory that records what an execution creates and scans.
 *
 * The seam is operation-scoped and absent from the package API: proving that
 * one execution creates exactly one scanner, or that a detector failure fails
 * closed, needs a scanner the test supplies, and there is no way to make the
 * real one throw on demand.
 */
function useProbedScanner(
  recorder: ScannerProbe,
  make: () => SecretScanner = createSecretScanner,
): Operation<void> {
  return useSecretScannerFactory(() => {
    const inner = make();
    const scanner: SecretScanner = {
      scan(content: string) {
        recorder.scanned.push(content);
        return inner.scan(content);
      },
    };
    recorder.created.push(scanner);
    return scanner;
  });
}

/** A stream that records the order the backend was actually asked to persist. */
function recording(backend: DurableStream, appends: string[]): DurableStream {
  return {
    readAll: () => backend.readAll(),
    *append(event: DurableEvent): Operation<void> {
      appends.push(label(event));
      yield* backend.append(event);
    },
  };
}

/** The error an operation fails with. Failing to fail is itself a failure. */
function* rejection(operation: Operation<unknown>): Operation<Error> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the operation to fail, and it completed");
}

/** Everything a run left behind, as one string, for a canary sweep. */
function persistedText(backend: InMemoryStream): string {
  return backend.snapshot().map(serializeDurableEvent).join("");
}

/**
 * Whether a run reports a rejected append it survived.
 *
 * Rejecting one event of a run that continues is not a failed run: the effect
 * that produced the event fails, and the document prints that failure where the
 * effect stood. Asserting the printed rejection — rather than only that the
 * canary is missing — is what distinguishes "the gate refused it" from "the
 * block never ran".
 */
function rejectedInPlace(result: Result<Json>): boolean {
  return (
    result.ok &&
    typeof result.value === "string" &&
    result.value.includes("secret detection rejected content before it was persisted")
  );
}

/** A scanner that clears everything, for tests about wrapping rather than detection. */
function useCheapScanner(): Operation<void> {
  return useSecretScannerFactory(() => ({
    // deno-lint-ignore require-yield
    *scan(): Operation<SecretFinding[]> {
      return [];
    },
  }));
}

/**
 * The journal provenance a live coordinator receives for `stream`.
 *
 * Provenance is readable only inside the canonical durable-streams module, so
 * this asks the seam the Workspace provider actually reads: the witness handed
 * to the coordinator of a live durable operation on that stream.
 */
function* observedProvenance(stream: DurableStream): Operation<JournalProvenance | undefined> {
  let observed: JournalProvenance | undefined;
  let coordinated = 0;
  const coordinator: LiveDurableOperationCoordinator = {
    *run(execute, publish, _activateFailure, journalProvenance) {
      coordinated += 1;
      observed = journalProvenance;
      const result: DurableResult = { status: "ok", value: yield* execute() };
      yield* publish(result);
      return result;
    },
  };

  yield* durableRun(
    function* (): Workflow<void> {
      yield createDurableOperation(
        { type: "call", name: "provenance" },
        // deno-lint-ignore require-yield
        function* (): Operation<string> {
          return "coordinated";
        },
        { coordinator },
      );
    },
    { stream },
  );

  if (coordinated !== 1) {
    throw new Error("the durable run did not coordinate exactly one live operation");
  }
  return observed;
}

describe("default-on secret detection", () => {
  describe("the persistence boundary", () => {
    it("rejects a canary in the root import event", function* () {
      const backend = new InMemoryStream();

      const result = yield* yield* execute({ ...inlineSource(TAINTED), stream: backend });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.name).toBe("SecretDetectedError");
    });

    it("keeps the offending import event out of the backend", function* () {
      const backend = new InMemoryStream();

      yield* yield* execute({ ...inlineSource(TAINTED), stream: backend });

      expect(backend.snapshot().some((event) => event.type === "yield")).toBe(false);
      expect(persistedText(backend)).not.toContain(CANARY);
    });

    it("admits the later safe close as an independent append", function* () {
      const backend = new InMemoryStream();

      yield* yield* execute({ ...inlineSource(TAINTED), stream: backend });

      // A rejected append does not imply an empty backend: the failure the
      // rejection caused produces a close that crosses the gate on its own.
      const persisted = backend.snapshot();
      expect(persisted.map(label)).toEqual(["close(root)"]);
      const close = persisted[0]!;
      expect(close.type === "close" && close.result.status).toBe("err");
    });

    it("leaks the canary through no completion, output, or persisted channel", function* () {
      const backend = new InMemoryStream();

      const execution = yield* execute({ ...inlineSource(TAINTED), stream: backend });
      const output = yield* forEach(function* (_chunk: string) {}, execution.output);
      const result = yield* execution;

      expect(result.ok).toBe(false);
      const error = result.ok === false ? result.error : new Error("unreachable");
      expect(error.message).not.toContain(CANARY);
      expect(error.stack ?? "").not.toContain(CANARY);
      expect(output).not.toContain(CANARY);
      expect(persistedText(backend)).not.toContain(CANARY);
      // The rule fired, so the message names what matched — and nothing else.
      expect(error.message).toContain("secretlint-rule");
    });

    it("creates no scanner and installs no guard when the host disables it", function* () {
      const recorder = probe();
      const backend = new InMemoryStream();
      yield* useProbedScanner(recorder);

      const result = yield* yield* execute({
        ...inlineSource(TAINTED),
        stream: backend,
        secretDetection: false,
      });

      expect(result.ok).toBe(true);
      expect(recorder.created).toHaveLength(0);
      expect(recorder.scanned).toHaveLength(0);
      expect(persistedText(backend)).toContain(CANARY);
    });

    it("admits each event of a clean run exactly once, in order", function* () {
      const guarded: string[] = [];
      const guardedBackend = new InMemoryStream();
      const plain: string[] = [];
      const plainBackend = new InMemoryStream();

      yield* useExecOutput("ok\n");

      yield* yield* execute({
        ...inlineSource(CLEAN),
        stream: recording(guardedBackend, guarded),
      });
      yield* yield* execute({
        ...inlineSource(CLEAN),
        stream: recording(plainBackend, plain),
        secretDetection: false,
      });

      expect(guarded).toEqual([
        "yield(import_component)",
        "yield(exec)",
        "yield(exec)",
        "close(root)",
      ]);
      // One append per event, and the same sequence detection-off produces.
      expect(guarded).toEqual(guardedBackend.snapshot().map(label));
      expect(guarded).toEqual(plain);
    });
  });

  describe("journal provenance", () => {
    it("preserves the exact witness of the stream it filters", function* () {
      const backend = new InMemoryStream();
      const provenance = establishJournalProvenance(backend);
      yield* useCheapScanner();

      const guarded = yield* useSecretDetection(undefined, backend);

      expect(guarded).not.toBe(backend);
      expect(yield* observedProvenance(guarded)).toBe(provenance);
    });

    it("keeps the same witness through nested official wrapping", function* () {
      const backend = new InMemoryStream();
      const provenance = establishJournalProvenance(backend);
      yield* useCheapScanner();

      const guarded = yield* useSecretDetection(undefined, backend);
      const nested = yield* useSecretDetection(undefined, guarded);

      expect(nested).not.toBe(guarded);
      expect(yield* observedProvenance(nested)).toBe(provenance);
    });

    it("hands back the original stream when the host disables detection", function* () {
      const backend = new InMemoryStream();
      const provenance = establishJournalProvenance(backend);
      yield* useCheapScanner();

      expect(yield* useSecretDetection(false, backend)).toBe(backend);
      expect(yield* observedProvenance(backend)).toBe(provenance);
    });

    it("proves nothing about a stream the policy did not wrap", function* () {
      const backend = new InMemoryStream();
      establishJournalProvenance(backend);
      yield* useCheapScanner();

      const unrelated: DurableStream = {
        readAll: () => backend.readAll(),
        append: (event) => backend.append(event),
      };

      expect(yield* observedProvenance(unrelated)).toBe(undefined);
    });
  });

  describe("host-only control", () => {
    it("ignores a root prop named secretDetection", function* () {
      const backend = new InMemoryStream();
      yield* useExecOutput(`${CANARY}\n`);

      const result = yield* yield* execute({
        ...inlineSource(DECLARING),
        stream: backend,
        props: { secretDetection: false },
      });

      expect(rejectedInPlace(result)).toBe(true);
      expect(persistedText(backend)).not.toContain(CANARY);
    });

    it("ignores frontmatter named secretDetection", function* () {
      const backend = new InMemoryStream();
      yield* useExecOutput(`${CANARY}\n`);

      const result = yield* yield* execute({ ...inlineSource(FRONTMATTER), stream: backend });

      expect(rejectedInPlace(result)).toBe(true);
      expect(persistedText(backend)).not.toContain(CANARY);
    });

    it("ignores a component that counterfeits the policy context mid-run", function* () {
      const backend = new InMemoryStream();
      yield* useExecOutput(`${CANARY}\n`);
      yield* registerComponents([
        {
          name: "Spoof",
          origin: "test:spoof",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            yield* Counterfeit.set({ enabled: false });
            return "";
          },
        },
      ]);

      const result = yield* yield* execute({ ...inlineSource(SPOOFING), stream: backend });

      // The document ran — the component executed before the exec block — and
      // still could not change which stream durableRun already held.
      expect(rejectedInPlace(result)).toBe(true);
      expect(persistedText(backend)).not.toContain(CANARY);
    });

    it("disables detection only for an explicit host false", function* () {
      const backend = new InMemoryStream();

      for (const requested of [undefined, true]) {
        backend.reset();
        const result = yield* yield* execute({
          ...inlineSource(TAINTED),
          stream: backend,
          secretDetection: requested,
        });
        expect(result.ok).toBe(false);
      }
    });
  });

  describe("the public policy surface", () => {
    it("reports the normalized request during execution", function* () {
      expect(yield* observedPolicy(undefined)).toEqual({ enabled: true });
      expect(yield* observedPolicy(true)).toEqual({ enabled: true });
      expect(yield* observedPolicy(false)).toEqual({ enabled: false });
    });

    it("throws when read outside an execution", function* () {
      const error = yield* rejection(secretPolicy());
      expect(error.message).not.toContain(CANARY);
    });

    it("hands back a frozen description carrying nothing but enabled", function* () {
      const policy = yield* observedPolicy(undefined);

      expect(Object.isFrozen(policy)).toBe(true);
      expect(Reflect.ownKeys(policy)).toEqual(["enabled"]);
      expect(Object.getOwnPropertySymbols(policy)).toHaveLength(0);
      expect(Object.values(policy).some((value) => typeof value === "function")).toBe(false);
    });

    it("rejects a description retained from an earlier execution", function* () {
      const retained = yield* observedPolicy(false);

      // Replaying a genuine public value from a disabled run into a later
      // enabled one is what a brand alone would not stop, which is why the
      // private policy never escapes in the first place.
      const error = yield* rejection(
        runObserving(CLEAN, new InMemoryStream(), undefined, function* () {
          yield* Counterfeit.set(retained);
          return yield* secretPolicy();
        }),
      );

      expect(error.name).toBe("CounterfeitSecretPolicyError");
      expect(error.message).not.toContain("enabled");
    });

    it("fails closed on every counterfeit shape", function* () {
      const counterfeits: unknown[] = [
        { enabled: false },
        new Proxy({ enabled: false }, {}),
        Object.freeze({ enabled: true, scan: () => [] }),
        "disabled",
        undefined,
      ];

      for (const counterfeit of counterfeits) {
        const error = yield* rejection(
          runObserving(CLEAN, new InMemoryStream(), undefined, function* () {
            yield* Counterfeit.set(counterfeit);
            return yield* secretPolicy();
          }),
        );
        // `undefined` erases the binding rather than replacing it, so it reads
        // as an absent policy; neither route reports a weaker one.
        expect(["CounterfeitSecretPolicyError", "SecretPolicyUnavailableError"]).toContain(
          error.name,
        );
      }
    });

    it("does not weaken the journal gate when the context is counterfeited", function* () {
      const backend = new InMemoryStream();
      yield* useExecOutput(`${CANARY}\n`);

      let read = "not attempted";
      yield* Execution.around({
        *document([props], next) {
          yield* Counterfeit.set({ enabled: false });
          read = (yield* rejection(secretPolicy())).name;
          return yield* next(props);
        },
      });

      const result = yield* yield* execute({ ...inlineSource(LEAKING), stream: backend });

      // The counterfeit took effect — the read it governs failed — and the
      // journal was untouched by it, because the gate never asks.
      expect(read).toBe("CounterfeitSecretPolicyError");
      expect(rejectedInPlace(result)).toBe(true);
      expect(persistedText(backend)).not.toContain(CANARY);
    });
  });

  /**
   * The gate scans what a run retained, and a run retains what reached its
   * per-exec boundary — after any middleware enclosing the execution, which is
   * the host's own trusted preprocessing (#441). Both directions follow from
   * that one fact, and both matter: a host may keep a credential out of the
   * record entirely, and a host cannot smuggle one in.
   */
  describe("the boundary the gate scans", () => {
    it("admits a run whose credential was redacted before the boundary", function* () {
      const backend = new InMemoryStream();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let redactions = 0;

      // Enclosing the execution, so this is what the run ever receives.
      yield* Stdio.around({
        *stdout([bytes], next) {
          redactions += 1;
          const text = decoder.decode(bytes, { stream: false });
          return yield* next(encoder.encode(text.replace(CANARY, "redacted-upstream")));
        },
      });
      yield* useExecOutput(`${CANARY}\n`);

      const result = yield* yield* execute({ ...inlineSource(LEAKING), stream: backend });

      expect(redactions).toBeGreaterThan(0);
      // The run completed, the safe text persisted, and the credential is in
      // no part of the record — it never reached the gate to be caught by.
      expect(result.ok).toBe(true);
      expect(persistedText(backend)).toContain("redacted-upstream");
      expect(persistedText(backend)).not.toContain(CANARY);
    });

    it("refuses a run whose safe output was made credential-shaped before the boundary", function* () {
      const backend = new InMemoryStream();
      const encoder = new TextEncoder();
      let injections = 0;

      yield* Stdio.around({
        *stdout([bytes], next) {
          injections += 1;
          void bytes;
          return yield* next(encoder.encode(`${CANARY}\n`));
        },
      });
      // What the command itself produced is harmless.
      yield* useExecOutput("nothing-secret\n");

      const result = yield* yield* execute({ ...inlineSource(LEAKING), stream: backend });

      expect(injections).toBeGreaterThan(0);
      // The gate reads the retained text, not the command's, so it catches it.
      expect(rejectedInPlace(result)).toBe(true);
      expect(persistedText(backend)).not.toContain(CANARY);
    });
  });

  describe("execution-bound scanning", () => {
    it("finds in content the gate rejects and nothing in clean content", function* () {
      const backend = new InMemoryStream();

      const findings = yield* runObserving(CLEAN, backend, undefined, function* () {
        return {
          tainted: yield* scanSecrets(CANARY),
          clean: yield* scanSecrets("the build passed"),
        };
      });

      expect(findings.tainted.length).toBeGreaterThan(0);
      expect(findings.clean).toEqual([]);
    });

    it("agrees with the journal gate on the same execution's scanner", function* () {
      const backend = new InMemoryStream();

      let observed: SecretFinding[] = [];
      yield* Execution.around({
        *document([props], next) {
          observed = yield* scanSecrets(CANARY);
          return yield* next(props);
        },
      });

      // The tainted root fails the run outright, so the rejection's own
      // findings are reachable — a rejected later event becomes a printed
      // error instead, and carries nothing back to the caller.
      const result = yield* yield* execute({ ...inlineSource(TAINTED), stream: backend });

      // Fingerprints are HMACs under a key generated per scanner, so equal
      // fingerprints for the same value prove one scanner served both paths.
      const rejected = findingsOf(result.ok === false ? result.error : undefined);
      expect(observed).toHaveLength(1);
      expect(observed.map((finding) => finding.fingerprint)).toEqual(
        rejected.map((finding) => finding.fingerprint),
      );
    });

    it("throws rather than reporting clean content when detection is disabled", function* () {
      const backend = new InMemoryStream();

      const error = yield* rejection(
        runObserving(CLEAN, backend, false, function* () {
          return yield* scanSecrets(CANARY);
        }),
      );

      expect(error.message).not.toContain(CANARY);
    });

    it("resolves its policy when interpreted, not when created", function* () {
      const backend = new InMemoryStream();

      const deferred = yield* runObserving(
        CLEAN,
        backend,
        undefined,
        // deno-lint-ignore require-yield
        function* () {
          return scanSecrets(CANARY);
        },
      );

      // Built inside a live enabled execution; interpreted after it is gone.
      const error = yield* rejection(deferred);
      expect(error.message).not.toContain(CANARY);
    });

    it("leaves no retained value able to scan after the execution ends", function* () {
      const backend = new InMemoryStream();

      const retained = yield* runObserving(CLEAN, backend, undefined, secretPolicy);

      expect(Reflect.ownKeys(retained)).toEqual(["enabled"]);
      const error = yield* rejection(scanSecrets(CANARY));
      expect(error.message).not.toContain(CANARY);
    });
  });

  describe("lifetime, concurrency, replay and failure", () => {
    it("creates one scanner per execution however many events it journals", function* () {
      const recorder = probe();
      yield* useProbedScanner(recorder);
      yield* useExecOutput("ok\n");

      yield* yield* execute({ ...inlineSource(CLEAN), stream: new InMemoryStream() });

      expect(recorder.created).toHaveLength(1);
      expect(recorder.scanned.length).toBeGreaterThan(1);
    });

    it("gives concurrent executions distinct scanners and fingerprint keys", function* () {
      const recorder = probe();
      yield* useProbedScanner(recorder);

      const [first, second] = yield* all([observedFindings(recorder), observedFindings(recorder)]);

      expect(recorder.created).toHaveLength(2);
      expect(recorder.created[0]).not.toBe(recorder.created[1]);
      // Same content, different per-execution HMAC key, different fingerprint.
      expect(first[0]?.fingerprint).not.toBe(second[0]?.fingerprint);
    });

    it("fails closed when the detector itself fails", function* () {
      const recorder = probe();
      const backend = new InMemoryStream();
      yield* useProbedScanner(recorder, () =>
        createScannerWith(() => {
          throw new Error(`detector choked on ${CANARY}`);
        }),
      );

      const result = yield* yield* execute({ ...inlineSource(CLEAN), stream: backend });

      expect(result.ok).toBe(false);
      const error = result.ok === false ? result.error : new Error("unreachable");
      // A detector that cannot clear anything also cannot clear the close the
      // first failure produced, so both failures arrive together.
      const failures = error instanceof AggregateError ? error.errors : [error];
      expect(failures.map((failure) => failure.name)).toEqual([
        "SecretScannerError",
        "SecretScannerError",
      ]);
      for (const failure of failures) {
        expect(Object.hasOwn(failure, "cause")).toBe(false);
        expect(failure.message).not.toContain(CANARY);
      }
      expect(error.message).not.toContain(CANARY);
      expect(backend.snapshot()).toHaveLength(0);
    });

    it("leaves nothing usable behind when an execution is halted", function* () {
      const reached = withResolvers<void>();
      let retained: SecretPolicy | undefined;
      let deferred: Operation<SecretFinding[]> | undefined;

      yield* scoped(function* () {
        yield* Execution.around({
          *document([props], next) {
            retained = yield* secretPolicy();
            deferred = scanSecrets(CANARY);
            reached.resolve();
            return yield* next(props);
          },
        });
        yield* execute({ ...inlineSource(CLEAN), stream: new InMemoryStream() });
        // Leaving here tears the run down where it stands, rather than after
        // it has finished on its own.
        yield* reached.operation;
      });

      expect(retained).toEqual({ enabled: true });
      expect(Reflect.ownKeys(retained ?? {})).toEqual(["enabled"]);
      const error = yield* rejection(deferred ?? scanSecrets(CANARY));
      expect(error.name).toBe("SecretPolicyUnavailableError");
    });

    it("never changes the shared profiler while executions overlap", function* () {
      // The profiler is stubbed once, where this package imports Secretlint, and
      // never touched again. Executing must therefore leave `mark` identical by
      // reference throughout: an execution that switched it per run would
      // differ at one of these readings, and an unrelated Secretlint user in the
      // process would see profiling come and go.
      const before = secretLintProfiler.mark;
      const during: unknown[] = [];
      const first = withResolvers<void>();
      const second = withResolvers<void>();

      yield* scoped(function* () {
        // Lifetimes that cross rather than nest: the second run starts while the
        // first is live, and the first ends first.
        yield* spawn(function* () {
          yield* runObserving(CLEAN, new InMemoryStream(), undefined, function* () {
            during.push(secretLintProfiler.mark);
            first.resolve();
            yield* second.operation;
            during.push(secretLintProfiler.mark);
          });
        });
        yield* first.operation;

        yield* spawn(function* () {
          yield* runObserving(CLEAN, new InMemoryStream(), undefined, function* () {
            during.push(secretLintProfiler.mark);
            second.resolve();
            yield* sleep(50);
            during.push(secretLintProfiler.mark);
          });
        });
        yield* sleep(120);
      });

      expect(during).toHaveLength(4);
      for (const mark of during) {
        expect(mark).toBe(before);
      }
      expect(secretLintProfiler.mark).toBe(before);
    });

    it("scans without emitting profiler marks", function* () {
      const marksBefore = performance.getEntriesByType("mark").length;

      yield* yield* execute({ ...inlineSource(CLEAN), stream: new InMemoryStream() });

      // The stub is what keeps the profiler's unbounded entry array — and the
      // linear scan it runs per mark — out of every append.
      expect(performance.getEntriesByType("mark").length).toBe(marksBefore);
    });

    it("does not rescan a journal it replays", function* () {
      const recorded = new InMemoryStream();
      yield* useExecOutput("ok\n");
      yield* yield* execute({ ...inlineSource(CLEAN), stream: recorded });

      const recorder = probe();
      yield* useProbedScanner(recorder);
      const replay = new InMemoryStream(recorded.snapshot());

      const result = yield* yield* execute({ ...inlineSource(CLEAN), stream: replay });

      expect(result.ok).toBe(true);
      expect(recorder.scanned).toHaveLength(0);
      expect(replay.appendCount).toBe(0);
    });
  });
});

/**
 * Run a document and return what `observe` saw from inside the execution.
 *
 * The observation runs as an `Execution` layer, which places it inside the
 * durable run and inside the execution's scope — where a trusted runtime
 * package reads the policy — rather than in the test's own scope.
 */
function* runObserving<T>(
  source: string,
  stream: DurableStream,
  secretDetection: boolean | undefined,
  observe: () => Operation<T>,
): Operation<T> {
  // The observation's outcome is carried out rather than thrown through the
  // run: a failing observation is what several of these tests are about, and
  // letting it abort the execution would report the run's failure instead of
  // the one the observation actually raised.
  let seen: Result<T> | undefined;
  return yield* scoped(function* () {
    yield* Execution.around({
      *document([props], next) {
        try {
          seen = Ok(yield* observe());
        } catch (error) {
          seen = Err(error instanceof Error ? error : new Error(String(error)));
        }
        return yield* next(props);
      },
    });
    yield* yield* execute({ ...inlineSource(source), stream, secretDetection });
    if (!seen) {
      throw new Error("the execution never reached the observation layer");
    }
    if (!seen.ok) {
      throw seen.error;
    }
    return seen.value;
  });
}

/** The policy a run of the clean document observes for a given request. */
function observedPolicy(secretDetection: boolean | undefined): Operation<SecretPolicy> {
  return runObserving(CLEAN, new InMemoryStream(), secretDetection, secretPolicy);
}

/** What one concurrent execution scans, so two runs can be compared. */
function observedFindings(recorder: ScannerProbe): Operation<SecretFinding[]> {
  return runObserving(CLEAN, new InMemoryStream(), undefined, function* () {
    expect(recorder.created.length).toBeGreaterThan(0);
    return yield* scanSecrets(CANARY);
  });
}

/** The findings a rejection carried, or none when it carried something else. */
function findingsOf(error: Error | undefined): readonly SecretFinding[] {
  if (error === undefined || !("findings" in error)) {
    return [];
  }
  const findings = error.findings;
  return Array.isArray(findings) ? findings : [];
}
