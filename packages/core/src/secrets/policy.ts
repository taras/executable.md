/**
 * The execution's secret-detection policy.
 *
 * Detection is on unless the trusted host asks for it to be off. The policy is
 * created inside the execution that owns it, before any document work can run,
 * and is reclaimed with that execution.
 *
 * ## Why there are two mechanisms
 *
 * The rule is that executable document code cannot disable, mutate, counterfeit,
 * retain, or substitute an execution's secret detection. That rule has two
 * independent parts, and each needs its own defence.
 *
 * **The journal.** `execute()` selects the stream `durableRun` will hold before
 * the first event exists. The gate is a closure over the private scanner and
 * reads no context afterwards, so nothing a document does to any context can
 * change what the journal is held to.
 *
 * **The contextual surface.** A trusted runtime package reads the policy while
 * a document is running, and Effection resolves contexts by *name*: any code can
 * construct a context with the same name and bind something else for its own
 * descendants. Keeping the descriptor module-private therefore proves nothing.
 * What is authenticated is the value — a private class field no other module can
 * produce — so a counterfeit binding fails the read instead of downgrading it. A
 * name collision can deny detection information; it can never weaken detection.
 *
 * The private policy never leaves this module: a brand proves module origin, not
 * execution ownership, so an authentic value that escaped could be replayed into
 * a later execution. `secretPolicy()` answers with a detached description, and
 * `scanSecrets()` resolves the current execution's scanner each time it is
 * interpreted.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import {
  guardDurableStream,
  preserveJournalProvenance,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import type { DurableStream } from "@executablemd/durable-streams";
import { SecretDetectedError } from "./findings.ts";
import type { SecretFinding } from "./findings.ts";
import { createSecretScanner } from "./scanner.ts";
import type { SecretScanner } from "./scanner.ts";

/**
 * What secret detection an execution is running under.
 *
 * A detached description of the normalized request: it carries `enabled` and
 * nothing else — no scanner, no scan function, no fingerprint key, no identity
 * belonging to the execution. Holding one after the run has ended is harmless,
 * and it is worth nothing to whoever holds it. Scanning goes through
 * {@link scanSecrets}, which resolves the live policy when it runs.
 */
export type SecretPolicy = { readonly enabled: true } | { readonly enabled: false };

const ENABLED: SecretPolicy = Object.freeze({ enabled: true });
const DISABLED: SecretPolicy = Object.freeze({ enabled: false });

/**
 * The private policy, branded so no other module can produce one.
 *
 * `#brand` is a private class field: it is not a symbol, not enumerable, and not
 * reachable through `Reflect.ownKeys` or `Object.getOwnPropertySymbols`. Holding
 * an instance does not let anyone build another, and a `Proxy` around one fails
 * the check too, because private slots are not proxied.
 */
abstract class ExecutionDetection {
  #brand = true;

  abstract readonly enabled: boolean;

  static authentic(value: unknown): value is ExecutionDetection {
    // `#brand in value` throws on a primitive rather than answering false.
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return false;
    }
    return #brand in value;
  }
}

class EnabledDetection extends ExecutionDetection {
  readonly enabled = true;
  readonly scanner: SecretScanner;

  constructor(scanner: SecretScanner) {
    super();
    this.scanner = scanner;
    Object.freeze(this);
  }
}

class DisabledDetection extends ExecutionDetection {
  readonly enabled = false;

  constructor() {
    super();
    Object.freeze(this);
  }
}

/**
 * The execution's policy binding.
 *
 * No default: outside an execution there is no policy to report, and answering
 * "disabled" would invent one. The descriptor is module-private, which stops
 * this package from handing out a setter — it does not make the *name*
 * unreachable. See the module docs for what actually authenticates a value.
 */
const CurrentDetection: Context<unknown> = createContext<unknown>("executablemd.secrets.policy");

/** Builds the scanner an execution owns. Substituted only by tests. */
export type SecretScannerFactory = () => SecretScanner;

const CurrentScannerFactory: Context<SecretScannerFactory> = createContext<SecretScannerFactory>(
  "executablemd.secrets.scannerFactory",
);

/**
 * The scanner factory, as a seam.
 *
 * Deliberately not re-exported from the package: proving that one execution
 * creates exactly one scanner, or that a detector failure fails closed, needs a
 * scanner the caller supplies, and there is no way to make the real one throw on
 * demand. Read once, before document execution begins, so a document that binds
 * the same name later changes nothing — the scanner already exists.
 */
export function* useSecretScannerFactory(factory: SecretScannerFactory): Operation<void> {
  yield* CurrentScannerFactory.set(factory);
}

/** No execution is running, or its policy binding was removed. */
class SecretPolicyUnavailableError extends Error {
  constructor() {
    super(
      "secret detection policy is unavailable: this operation is not running inside a " +
        "document execution, or the execution's policy is no longer bound.",
    );
    this.name = "SecretPolicyUnavailableError";
  }
}

/**
 * Something other than this execution's policy is bound under the policy name.
 *
 * The supplied value is not inspected, described, or serialized: it came from
 * whoever is being refused, and reporting it would publish whatever they put
 * there.
 */
class CounterfeitSecretPolicyError extends Error {
  constructor() {
    super(
      "secret detection policy failed authentication: the value bound for this scope was " +
        "not created by this execution. The supplied value is withheld.",
    );
    this.name = "CounterfeitSecretPolicyError";
  }
}

/** Scanning was asked for on an execution the host ran with detection off. */
class SecretDetectionDisabledError extends Error {
  constructor() {
    super(
      "secret detection is disabled for this execution, so there is nothing to scan with. " +
        "Branch on `secretPolicy()` before scanning.",
    );
    this.name = "SecretDetectionDisabledError";
  }
}

/** The current execution's own policy, or a failure. Never a weaker answer. */
function* currentDetection(): Operation<ExecutionDetection> {
  const bound = yield* CurrentDetection.get();
  if (bound === undefined) {
    throw new SecretPolicyUnavailableError();
  }
  if (!ExecutionDetection.authentic(bound)) {
    throw new CounterfeitSecretPolicyError();
  }
  return bound;
}

/**
 * What secret detection the running execution is under.
 *
 * Answers from the execution that is running now, each time it is interpreted.
 * Outside an execution, or where the binding is absent or unauthentic, it fails
 * rather than reporting `enabled: false` — an invented "off" is exactly the
 * answer an attacker wants.
 */
export function* secretPolicy(): Operation<SecretPolicy> {
  return (yield* currentDetection()).enabled ? ENABLED : DISABLED;
}

/**
 * Scan `content` with the running execution's scanner.
 *
 * The policy is resolved when this operation is interpreted, never when it is
 * created, so an operation built during a run and interpreted after teardown
 * finds no policy and fails. The scanner and its per-execution fingerprint key
 * stay inside the execution; only findings come back.
 *
 * Fails when detection is disabled rather than reporting no findings: a caller
 * that has not checked {@link secretPolicy} would otherwise read "nothing found"
 * as "nothing there".
 */
export function* scanSecrets(content: string): Operation<SecretFinding[]> {
  const detection = yield* currentDetection();
  if (!(detection instanceof EnabledDetection)) {
    throw new SecretDetectionDisabledError();
  }
  return yield* detection.scanner.scan(content);
}

/**
 * Apply the normalized policy to `stream`, and install it for this execution.
 *
 * `undefined` normalizes to enabled; only an explicit `false` from the trusted
 * host turns detection off. Returns the stream the durable run is to use: the
 * guarded one when detection is on, and the original — untouched, with no
 * scanner built and no gate installed — when it is off.
 *
 * Call inside the execution's own task, before `durableRun` and before any
 * document, frontmatter, prop, component, or eval code can run. That ordering is
 * what puts the root import behind the gate.
 */
export function* useSecretDetection(
  requested: boolean | undefined,
  stream: DurableStream,
): Operation<DurableStream> {
  if (requested === false) {
    yield* CurrentDetection.set(new DisabledDetection());
    return stream;
  }

  const create = (yield* CurrentScannerFactory.get()) ?? createSecretScanner;
  const scanner = create();
  yield* CurrentDetection.set(new EnabledDetection(scanner));
  return guardWithSecretDetection(stream, scanner);
}

/**
 * XMD's secret policy over the generic pre-persistence guard.
 *
 * The guard stays policy-neutral — it knows only that a gate runs before an
 * append — and this supplies the policy. The gate closes over the scanner
 * directly rather than reading it back from context, which is what makes the
 * journal independent of anything a document does to contextual state.
 *
 * This is the one trusted composition that preserves journal provenance, so a
 * filtered run still publishes into the journal its provider selected. An
 * ordinary guard elsewhere produces an unproven wrapper.
 */
function guardWithSecretDetection(stream: DurableStream, scanner: SecretScanner): DurableStream {
  const guarded = guardDurableStream(stream, function* (event) {
    const serialized = serializeDurableEvent(event);
    const findings = yield* scanner.scan(serialized);

    if (findings.length > 0) {
      throw new SecretDetectedError(findings);
    }
  });
  return preserveJournalProvenance(stream, guarded);
}
