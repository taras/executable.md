/**
 * Which component an admitted fragment runs, and for how long it may run it.
 *
 * A host states that a generated fragment may read a file, and this is what
 * decides *what* answers that name. The answer is canonical core's own ordinary
 * component — the same `<File>`, `<File.Delete>`, `<Dir>`, `<Glob>`, `<Fetch>`
 * and `<Elicit>` an author writes — so a generated element and an authored one
 * are one implementation performing one operation through one provider.
 *
 * There is deliberately nothing else here. The operations used to be a private
 * transport: a host handed its own filesystem object to the profile, capture
 * read each method off it once, and core closed a fragment-facing body over the
 * bound result. That made a generated read a second filesystem implementation,
 * invisible to the `API.Files` middleware every other read crosses, and it put
 * a fragment's working directory in a cursor this module owned rather than in
 * the contextual environment the rest of the engine uses. Both are gone. What a
 * fragment may do is now mediated where every other caller's operations are
 * mediated — by the installed provider, and by `Permissions` at the
 * implementation that performs the I/O.
 *
 * ## What a host still decides
 *
 * Everything about admission, and nothing about performance:
 *
 * - **which names** a fragment may write, and under which identity a
 *   continuation compares them;
 * - **which spelling** each name is admitted for, so `<File />` observing and
 *   `<File>…</File>` writing are two grants rather than one — decided in
 *   preflight, from the scan, before the fragment's first effect;
 * - **which requests** an admitted `<Fetch />` may perform, as an exact ceiling
 *   belonging to that entry;
 * - **how long** any of it lasts: every admitted implementation is held to the
 *   execution that captured it, and refuses once that execution has ended.
 *
 * What it no longer decides is which filesystem or transport the operation
 * reaches. That was never a property of the name — it is the installed
 * provider's, and a workflow run's transaction-bound provider is as much the
 * ordinary route as the host adapter is.
 *
 * ## Why the engine still selects the component's own dispatcher
 *
 * `<File>` runs two irreversible bodies, and which one an element gets is
 * canonical dispatch's decision, taken from the scan. A dispatcher refuses an
 * invocation whose selection is not itself, so an adapter that wrapped one in a
 * second dispatcher would be an adapter no form could get through. The guard
 * below is therefore a plain wrapper — it opens no scope and selects no body —
 * and the component's own dispatcher travels beside it as the entry's
 * `dispatch`, where canonical selection records it.
 */

import { scoped } from "effection";
import type { Operation } from "effection";

import type {
  FunctionComponent,
  FunctionComponentDefinition,
  Json,
  PropsSchema,
  ReturnsSchema,
} from "./types.ts";
import { getExpansion } from "./expansion.ts";
import { observeFetch } from "./components/Fetch.ts";
import { persistFetch } from "./fetch-journal.ts";
import { parseResponseRecord } from "./fetch-response.ts";
import { fixedFilesystemDefinition } from "./components/fixed-filesystem.ts";
import { coreComponentDefinition, ELICIT_COMPONENT } from "./components/registry.ts";
import { FileAccessError } from "./components/File.ts";
import { FileDeleteError } from "./components/FileDelete.ts";
import { DirInvocationError } from "./components/Dir.ts";
import { GlobError } from "./components/Glob.ts";
import { markGeneratedRequestRefusal } from "./generated-request-refusal.ts";
import { isFormDispatcher } from "./invocation-identity.ts";
import type { ComponentInvocation } from "./invocation-identity.ts";
import type { FetchRequest } from "./fetch-request.ts";
import { Permissions } from "@executablemd/runtime";

/** A refusal an admitted fragment's own request produced. */
export class FragmentCapabilityError extends Error {
  override name = "FragmentCapabilityError";
}

/** What a fragment operation reached after its execution had ended. */
export const REVOKED_CAPABILITY =
  "an admitted fragment reached an operation belonging to an execution that has ended.";

/** Whether the execution that admitted these components is still running. */
export interface CapturedCapabilities {
  /** Whether the execution that captured these is still running. */
  live(): boolean;
  /** Called at execution teardown. Every admitted implementation refuses afterwards. */
  revoke(): void;
}

/**
 * The lifetime every admitted implementation in one capture is held to.
 *
 * All a capture owns now. There is no operation to read off a host object and
 * nothing to bind, because the implementations are core's own — so what remains
 * is the one thing an execution has to be able to say afterwards: this run is
 * over, and a definition somebody kept is not a way back into it.
 */
export function captureCapabilities(): CapturedCapabilities {
  let alive = true;
  return Object.freeze({
    live: () => alive,
    revoke: () => {
      alive = false;
    },
  });
}

/** Which ordinary component one admitted entry runs. */
export type FragmentCapability =
  | "file:read"
  | "files:glob"
  | "file:write"
  | "file:delete"
  | "directory:ensure"
  | "fetch"
  | "elicit:ask";

/** The authored forms each capability is written in. */
export const CAPABILITY_FORMS: Readonly<
  Record<FragmentCapability, readonly ("self-closing" | "paired")[]>
> = Object.freeze({
  "file:read": ["self-closing"],
  "files:glob": ["self-closing"],
  "file:write": ["paired"],
  "file:delete": ["self-closing"],
  "directory:ensure": ["paired"],
  fetch: ["self-closing"],
  // The question is the content, so there is nothing a self-closing spelling
  // could be asking.
  "elicit:ask": ["paired"],
});

/** The component canonical core runs for one capability. */
const OWNERS: Readonly<Record<FragmentCapability, string>> = Object.freeze({
  "file:read": "File",
  "file:write": "File",
  "file:delete": "File.Delete",
  "directory:ensure": "Dir",
  "files:glob": "Glob",
  fetch: "Fetch",
  "elicit:ask": ELICIT_COMPONENT,
});

/**
 * The exact definition canonical core supplies for one capability.
 *
 * Read from the one place that owns it — the fixed tier for the three
 * filesystem names, the core registry for the rest — rather than restated here.
 * A copy would be a second component, and a generated fragment behaving
 * differently from an authored element is precisely what that drift looks like.
 */
function capabilityOwner(capability: FragmentCapability): FunctionComponentDefinition {
  const name = OWNERS[capability];
  const definition = fixedFilesystemDefinition(name) ?? coreComponentDefinition(name);
  if (definition === undefined) {
    throw new FragmentCapabilityError(`canonical core supplies no <${name}> to admit.`);
  }
  return definition;
}

/** The schema an admitted entry's props are validated against. */
export function capabilityProps(capability: FragmentCapability): PropsSchema {
  return capabilityOwner(capability).props;
}

/**
 * What a capability binds, for the ones that bind a value rather than render.
 *
 * The owning component's own declaration. Declaring it is what makes the
 * admitted element a value component exactly as it does for the authored one:
 * the engine requires `as`, renders nothing, and validates what comes back.
 */
export function capabilityReturns(capability: FragmentCapability): ReturnsSchema | undefined {
  return capabilityOwner(capability).returns;
}

/** Which capability one name is admitted for, in each authored spelling. */
export interface AdmittedForms {
  readonly "self-closing"?: FragmentCapability;
  readonly paired?: FragmentCapability;
}

/** One admitted name's implementation, and the dispatcher underneath it. */
export interface CapabilityImplementation {
  readonly definition: FunctionComponentDefinition;
  /**
   * The owning component's form dispatcher, when it has one.
   *
   * It travels separately because the definition above runs behind the lifetime
   * guard, so what a selection would read off it is core's wrapper rather than
   * the component's dispatcher — and a dispatcher read off the wrong function
   * selects no body at all.
   */
  readonly dispatch?: unknown;
}

/**
 * The implementation one admitted name runs, built once per capture.
 *
 * One definition per *name*, however many capabilities that name holds: a
 * profile admitting `<File />` to read and `<File>…</File>` to write is
 * describing one component with two spellings, and the evaluator resolves an
 * import by name. Which spelling reaches which body is the component's own
 * dispatch, from the scan; which spellings are admitted at all is the entry's,
 * in preflight.
 */
export function capabilityImplementation(
  name: string,
  admitted: AdmittedForms,
  capabilities: CapturedCapabilities,
  requests: readonly FetchRequest[] = [],
): CapabilityImplementation {
  const held = [admitted["self-closing"], admitted.paired].filter(
    (capability): capability is FragmentCapability => capability !== undefined,
  );
  if (held.length === 0) {
    throw new FragmentCapabilityError(`an evaluation profile admitted "${name}" for no form.`);
  }
  const owners = new Set(held.map((capability) => OWNERS[capability]));
  if (owners.size > 1) {
    // One name is one component. Two capabilities owned by different components
    // under one name would be one import with two answers, decided by how the
    // element happened to be written.
    throw new FragmentCapabilityError(
      `an evaluation profile admitted "${name}" for two different components: ` +
        `${[...owners].join(" and ")}. One name runs one component.`,
    );
  }
  const owner = capabilityOwner(held[0]);
  const inner = owner.fn;
  if (typeof inner !== "function") {
    throw new FragmentCapabilityError(
      `canonical core supplies no invocable <${owner.name}> to admit.`,
    );
  }
  const fn =
    owner.name === "Fetch"
      ? bounded(admitted, capabilities, boundedRequests(inner, requests))
      : bounded(admitted, capabilities, inner);
  return Object.freeze({
    definition: Object.freeze({ ...owner, name, fn }),
    ...(isFormDispatcher(inner) ? { dispatch: inner } : {}),
  });
}

/**
 * One admitted implementation, held to this execution and reporting a refusal
 * of the request as one.
 *
 * Two jobs, and both of them are the adapter's rather than the component's. The
 * lifetime is the execution's: a definition retained past teardown refuses
 * instead of reaching a filesystem the run no longer holds a transaction for.
 * The classification is the caller's: a host driving a loop needs to know
 * whether the fragment's own text was refused, and only the code that raised
 * the failure knows that.
 *
 * It opens no scope and selects no body, so the component's own dispatcher
 * still runs in the frame the engine issued it for.
 */
function bounded(
  admitted: AdmittedForms,
  capabilities: CapturedCapabilities,
  inner: FunctionComponent,
): FunctionComponent {
  return function* held(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<unknown> {
    if (!capabilities.live()) {
      throw new FragmentCapabilityError(REVOKED_CAPABILITY);
    }
    try {
      return yield* inner(props, invocation);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      const reason = refusedReason(admitted, props, invocation, error);
      if (reason === undefined) {
        throw error;
      }
      throw markGeneratedRequestRefusal(error, reason);
    }
  };
}

/** The verb a refusal of each filesystem capability is reported with. */
const VERBS: Readonly<Partial<Record<FragmentCapability, string>>> = Object.freeze({
  "file:read": "read",
  "file:write": "write",
  "file:delete": "delete",
  "directory:ensure": "create",
});

/**
 * The safe reason this failure carries, when it is a refusal of the request.
 *
 * Core's own fixed sentence, not the component's. The component's message is
 * safe to *print* — it names the path the document wrote and a phrase from a
 * fixed vocabulary — but a write that failed because its content failed to
 * expand reports what that content said, and the content of a generated
 * fragment is text nobody audited. A refusal reason travels back to whatever is
 * driving the loop, so it is built here from the capability and the authored
 * path, and from nothing the fragment produced.
 *
 * The glob sentences are the exception and are already written for this: a
 * pattern a fragment wrote wrongly is reported by `glob-source.ts` in the same
 * words an author would be told, and no provider diagnostic reaches them.
 *
 * Everything else is unmarked, which is the safe default. An absent provider, a
 * broken provider contract, a revoked execution, a cancellation and a durable
 * failure are not the request being refused, and calling any of them one would
 * invite another turn at work that cannot succeed.
 */
function refusedReason(
  admitted: AdmittedForms,
  props: Record<string, Json>,
  invocation: ComponentInvocation,
  error: unknown,
): string | undefined {
  if (error instanceof GlobError) {
    return error.message;
  }
  if (
    !(
      error instanceof FileAccessError ||
      error instanceof FileDeleteError ||
      error instanceof DirInvocationError
    )
  ) {
    return undefined;
  }
  const verb = VERBS[writtenCapability(admitted, invocation) ?? "fetch"];
  return verb === undefined
    ? undefined
    : `an admitted fragment could not ${verb} ${JSON.stringify(String(props.path))}.`;
}

/**
 * Which of a name's capabilities this element was written as.
 *
 * Read from the authored shape, which is the only thing that separates
 * `<File />` from `<File>…</File>` once both are admitted under one name. This
 * is **not** how the effect was selected: the component's own dispatcher
 * already did that, from the scan, before its body ran — and the failure this
 * words a sentence for has already happened. A forged invocation can therefore
 * change which verb a refusal is phrased with and nothing else, which is why
 * reading it here is observation rather than authentication.
 */
function writtenCapability(
  admitted: AdmittedForms,
  invocation: ComponentInvocation,
): FragmentCapability | undefined {
  try {
    return invocation.hasContent() ? admitted.paired : admitted["self-closing"];
  } catch {
    return undefined;
  }
}

/**
 * The admitted request this element matched, performed under its entry's
 * ceiling.
 *
 * Preflight already compared the element against the ceiling, from the scan,
 * before the fragment's first effect. This finds the admitted request it
 * matched and performs *that* — never the props, which would let a header the
 * ceiling normalized away travel anyway, and never a timeout read from
 * wherever the performance happened rather than the one the host resolved when
 * it stated the profile.
 *
 * The ceiling is then installed as an ordinary `Permissions` restriction for
 * the duration of this one invocation, so it stays in force at the place the
 * request is actually sent: contextual `API.Fetch` middleware may observe,
 * sign or route what goes out, and a transformation that moves the request off
 * this entry's ceiling is refused by the terminal rather than performed.
 *
 * The journal, the response detachment and the status rule are the ordinary
 * component's, reached through the shared observation it exports: one element
 * is one durable request, and a continuation restores what came back rather
 * than asking again.
 */
function boundedRequests(
  inner: FunctionComponent,
  requests: readonly FetchRequest[],
): FunctionComponent {
  return function* performed(props: Record<string, Json>): Operation<unknown> {
    const url = String(props.url);
    const admitted = requests.find((request) => request.url === url);
    if (admitted === undefined) {
      throw new FragmentCapabilityError(
        "an admitted fragment asked for a request this host did not admit.",
      );
    }
    const expansion = yield* getExpansion();
    const retained = yield* scoped(function* () {
      yield* Permissions.around({
        fetch: ([input, init], next) =>
          permitted(requests, input, init) ? next(input, init) : false,
      });
      return yield* persistFetch(
        {
          id: expansion.id,
          ...(expansion.position === undefined ? {} : { position: expansion.position }),
        },
        admitted,
        () => observeFetch(admitted),
      );
    });
    // The status rule is the authored one: a fragment binds nothing, so a
    // response it cannot branch on must not be handed back as though it were an
    // answer.
    const response = parseResponseRecord(retained);
    if (response.status < 200 || response.status > 299) {
      throw new FragmentCapabilityError(
        `an admitted fragment's request answered with status ${response.status}.`,
      );
    }
    return retained;
  };
}

/**
 * Whether the request about to be sent is still one this entry admits.
 *
 * The destination and the method, which are what a ceiling is about: a
 * transformation that sends the request somewhere else, or sends it as a
 * different method, is performing a request the host never admitted. Headers
 * are deliberately not compared — the host that stated this ceiling is the same
 * host whose middleware signs and routes what leaves it, and a restriction that
 * refused its own authentication header would make that unusable.
 */
function permitted(
  requests: readonly FetchRequest[],
  input: string,
  init: { readonly method?: string } | undefined,
): boolean {
  const method = init?.method ?? "GET";
  return requests.some((request) => request.url === input && request.method === method);
}
