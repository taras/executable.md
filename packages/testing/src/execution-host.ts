/**
 * The host profile one nested execution runs under, and the request it is asked
 * through (specs/testing-spec.md).
 *
 * A Markdown test that runs another document runs it the way the production
 * command line would — the same root import, the same default components, the
 * same journal policy, the same workflow machinery. None of that belongs to
 * `@executablemd/testing`: this package would have to restate `xmd run` and
 * `xmd workflow` to own it, and a restatement is exactly what makes a test pass
 * against behavior nothing ships.
 *
 * So this package owns the *request* and the CLI owns the answer. The
 * dependency already runs that way — `@executablemd/cli` depends on
 * `@executablemd/testing` — and reversing it here would close the cycle.
 *
 * ## Why middleware gets a request
 *
 * The same reason canonical execution hands middleware an `ExecutionRequest`
 * rather than a `DocumentExecution` (`execution-request.ts` in core). A handler
 * that received the child could answer without delegating, and its invented
 * answer *would be* the child: no root imported, no journal written, no
 * workflow run recorded, and an assertion body that passed against nothing.
 *
 * A handler here may read the profile, refuse by throwing, and delegate the
 * exact request. It returns nothing and nothing it returns is read.
 * The one thing that runs a child is the terminal `<Execution>` created for its
 * own invocation, and that terminal is reached only after the chain unwinds.
 *
 * The request is the capability: it carries a private reference to one
 * invocation and may be consumed exactly once, so a reconstructed look-alike, a
 * second delegation and a replayed request are refusals rather than second
 * children.
 */

import type { Operation, Result } from "effection";
import { type Api, createApi } from "@effectionx/context-api";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/core";
import { detachChildConfiguration, detachJsonObject, frozen } from "./child-configuration.ts";
import type { ChildConfiguration } from "./child-configuration.ts";

/** The host profiles a test may select. */
export type HostProfileName = "run" | "workflow";

/** What the child's journal is, decided by the profile and the declarations. */
export type JournalPolicy = "transient" | "diagnostic" | "workflow";

/**
 * How one child execution ended.
 *
 * A run always settles. A workflow attempt may instead reach a durable wait,
 * which is neither a completed document nor a failed one — so it is a variant
 * rather than a `Result` carrying a special error.
 */
export type ExecutionOutcome =
  | { readonly kind: "settled"; readonly result: Result<Json> }
  | { readonly kind: "suspended"; readonly runId: string; readonly suspensionId: string };

/** What one `<Execution>` asks its host for, after validation. */
export interface HostProfileRequest {
  readonly host: HostProfileName;
  /** `start` or `resume` under the workflow profile; absent under `run`. */
  readonly action?: "start" | "resume";
  /** A document reference, resolved by the production root loader. */
  readonly target?: string;
  /** Inline markdown, run through the production `run -e` source path. */
  readonly source?: string;
  readonly props: Record<string, Json>;
  readonly journal: JournalPolicy;
  /** Whether a completed journal snapshot is asked for after settlement. */
  readonly collectJournal: boolean;
  /**
   * The deterministic dependencies the declarations configured, in declared
   * order, and absent when the test declared none.
   *
   * A closed union of frozen data. Nothing here is a provider, a factory, a
   * context, an Api handler, an installation, a controller or a scope: the
   * trusted host reads these values and constructs what they describe inside
   * the child, which is what keeps a test from assembling one.
   */
  readonly configuration?: readonly ChildConfiguration[];
}

/** A protocol violation by whoever is composed around a nested execution. */
export class ExecutionHostError extends Error {
  override name = "ExecutionHostError";

  constructor(problem: string) {
    super(
      `Execution host middleware ${problem}. A handler may inspect, refuse or ` +
        "delegate a request; only the invocation that issued one runs a child.",
    );
  }
}

/** What a host-profile handler is given, and the whole of what it may do. */
export interface ExecutionHostRequest {
  /** The immutable profile this invocation asked for. */
  readonly profile: HostProfileRequest;
}

/** One nested execution's private state. */
class Invocation {
  consumed = false;
  settled: HostProfileRequest | undefined;
}

class CanonicalHostRequest implements ExecutionHostRequest {
  readonly #invocation: Invocation;
  readonly profile: HostProfileRequest;

  constructor(invocation: Invocation, profile: HostProfileRequest) {
    this.#invocation = invocation;
    this.profile = profile;
    Object.freeze(this);
  }

  /**
   * Take this request's profile on behalf of `invocation`, once.
   *
   * The expected invocation is supplied by the caller rather than read off the
   * request: a request another `<Execution>` issued is also canonical, and
   * accepting it would let one harness run another's child. Every check runs
   * before anything is written, so a rejected delegation consumes neither.
   */
  static consume(request: unknown, invocation: Invocation): void {
    if (!CanonicalHostRequest.own(request)) {
      throw new ExecutionHostError("delegated a request no <Execution> issued");
    }
    if (request.#invocation !== invocation) {
      throw new ExecutionHostError("delegated a request another <Execution> issued");
    }
    if (invocation.consumed) {
      throw new ExecutionHostError("delegated a host request more than once");
    }
    invocation.consumed = true;
    invocation.settled = request.profile;
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is CanonicalHostRequest {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #invocation in value;
    } catch {
      // A revoked proxy, or one whose `has` trap refuses. Not one of ours.
      return false;
    }
  }
}

/**
 * The profile this child runs under, detached from whoever delegated it.
 *
 * The chain unwinds before the terminal runs the child, so a handler that
 * delegates and then edits what it delegated would otherwise change what runs.
 * Props are the child's document inputs, so they are copied all the way down,
 * and so is every layer of the declared configuration.
 */
function detachProfile(profile: HostProfileRequest): HostProfileRequest {
  const { props, configuration, ...rest } = profile;
  return frozen({
    ...rest,
    props: detachJsonObject(props),
    ...(configuration === undefined
      ? {}
      : { configuration: detachChildConfiguration(configuration) }),
  });
}

/** One nested execution's request, and what its invocation reads back. */
export interface IssuedHostRequest {
  readonly request: ExecutionHostRequest;
  /** Settle this invocation on `request`, or refuse it. */
  consume(request: unknown): void;
  /** The profile the terminal recorded, or a refusal when it was never reached. */
  settle(): HostProfileRequest;
}

export function issueHostRequest(profile: HostProfileRequest): IssuedHostRequest {
  const invocation = new Invocation();
  const request = detachProfile(profile);
  return {
    request: new CanonicalHostRequest(invocation, request),
    consume(request: unknown): void {
      CanonicalHostRequest.consume(request, invocation);
    },
    settle(): HostProfileRequest {
      const settled = invocation.settled;
      if (!invocation.consumed || settled === undefined) {
        throw new ExecutionHostError("returned without delegating the host request");
      }
      return settled;
    },
  };
}

/**
 * Execution host Api — a policy surface around one nested execution.
 *
 * Its default always refuses. A stable name composes replaceable policy across
 * loaded copies, and this descriptor is the one everybody can reach — so it
 * must not be a terminal that would settle any request handed to it. Each
 * `<Execution>` dispatches through a private instance of the same name instead,
 * exactly as canonical core does for a document execution.
 */
export interface ExecutionHostApi {
  run(request: ExecutionHostRequest): Operation<void>;
}

export const ExecutionHost: Api<ExecutionHostApi> = createApi<ExecutionHostApi>("ExecutionHost", {
  // deno-lint-ignore require-yield
  *run(_request: ExecutionHostRequest): Operation<void> {
    throw new ExecutionHostError("was invoked outside an <Execution> invocation");
  },
});

/**
 * One test-owned workflow run's storage, as the harness sees it.
 *
 * Opaque on purpose: the public run id is the only thing a test may learn. The
 * directory, the database and the append path stay inside the provider that
 * created them, so nothing authored can read or write a run's physical state —
 * or the user's configured run directory, which this never is.
 */
export interface WorkflowRunScope {
  /** The run id this scope executes under, generated when none was declared. */
  readonly id: string;
}

/** What the harness hands a provider for one child, and nothing more. */
export interface ChildInvocation {
  /** The profile the terminal recorded. */
  readonly request: HostProfileRequest;
  /** The isolated workflow run this child belongs to, under the workflow profile. */
  readonly run: WorkflowRunScope | undefined;
  /**
   * One rendered chunk of child output, as it arrives.
   *
   * Called by the provider while the child runs, which is what makes display
   * progressive. Whether anything accumulates it is the harness's business and
   * invisible here: a provider that must stream in order to be collected would
   * make collection change routing.
   */
  chunk(text: string): Operation<void>;
}

/** What a provider answers with once its child is over and torn down. */
export interface ChildSettlement {
  readonly outcome: ExecutionOutcome;
  /** Complete output, or the partial prefix rendered before a failure. */
  readonly output: string;
  /** The child journal's completed snapshot, when the profile retained one. */
  readonly journal?: readonly DurableEvent[];
}

/**
 * The trusted answer to a host request.
 *
 * Captured by the trusted test-harness installation, which owns production
 * assembly. Reached only from an `<Execution>`'s own terminal, so public
 * middleware never holds it and no Context selects it.
 */
export interface ExecutionHostProvider {
  runChild(invocation: ChildInvocation): Operation<ChildSettlement>;
  /**
   * Open isolated production workflow storage for one `<WorkflowRun>` scope.
   *
   * A resource: it is acquired in the invocation's frame and removed when that
   * invocation is dismantled, so the physical root belongs to the test.
   *
   * Optional, because the workflow profile is a host capability rather than a
   * harness one: an entrypoint that cannot execute workflow runs supplies no
   * member here, and `<WorkflowRun>` refuses on that basis rather than on a
   * refusal this package invented.
   */
  useWorkflowRun?(options: { readonly id?: string }): Operation<WorkflowRunScope>;
}
