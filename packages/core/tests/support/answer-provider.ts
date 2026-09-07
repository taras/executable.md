/**
 * A trusted host's provider for one `component-answer` entry.
 *
 * The shape a real provider has: it composes `Component.importComponent`
 * middleware for its own name, and states an identity for the exact object it
 * returns using the request canonical execution minted for that handler
 * invocation. It holds no definition the profile could read, because the
 * profile arm it backs has nowhere to put one.
 *
 * Every deviation a row needs is a member here rather than a second provider,
 * so what one case changes about the honest one is visible in the case.
 */

import type { Operation } from "effection";

import type {
  ComponentAnswerInstallation,
  ComponentAnswerRegistrar,
  ComponentAnswerRequest,
} from "../../host.ts";
import type { FunctionComponentDefinition, Json, PropsSchema } from "../../src/types.ts";

/** The contract an implementation states when a row does not care what it is. */
const NO_PROPS: PropsSchema = { type: "object", properties: {}, additionalProperties: false };

/** One implementation a provider can answer with, and a log of what ran. */
export interface Implementation {
  readonly definition: FunctionComponentDefinition;
  readonly invoked: string[];
}

/** One named implementation that records each time it is entered. */
export function implementation(
  name: string,
  label: string,
  props: PropsSchema = NO_PROPS,
): Implementation {
  const invoked: string[] = [];
  return {
    invoked,
    definition: {
      kind: "function",
      name,
      props,
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        invoked.push(label);
        return label;
      },
    },
  };
}

/** How one row wants its provider to differ from the honest one. */
export interface ProviderOptions {
  /** The provider's own name for itself; the origin every claim carries. */
  readonly origin?: string;
  /** The key and revision this provider states. */
  readonly key?: string;
  readonly revision?: string;
  /** Every lookup this provider *answered*, in order. */
  readonly lookups?: string[];
  /** Every lookup this provider was asked at all, answered or delegated. */
  readonly asked?: string[];
  /** Return the answer without stating an identity for it at all. */
  readonly unclaimed?: boolean;
  /** State the identity, then answer with a copy of the claimed object. */
  readonly copied?: boolean;
  /** State the identity, then edit the claimed object. */
  readonly mutated?: boolean;
  /**
   * Keep answering after the capture, rather than settling.
   *
   * The refusal case: a generated import is answered by canonical execution,
   * so a provider still answering when a fragment resolves its admitted name is
   * substituting into the fragment and is refused there.
   */
  readonly keepsAnswering?: boolean;
  /**
   * Keep *claiming* after the capture, rather than settling.
   *
   * The other half of the same refusal, one step earlier: the resolution this
   * provider answered has settled, so there is no open window to state an
   * identity into and the claim refuses before the witness is ever consulted.
   */
  readonly reclaimsLater?: boolean;
  /**
   * Delegate first, and answer with this provider's own claimed object.
   *
   * What an *outer* provider does. The one installed first composes outermost,
   * so it sees the chain's answer before deciding, and returning its own
   * claimed object is an honest substitution: the identity travels with the
   * object the chain finally gives back.
   */
  readonly delegatesFirst?: boolean;
  /**
   * Delegate and answer with whatever came back, claiming nothing.
   *
   * What a *repeated* bootstrap does. A package entered through an inherited
   * layer and again through a local one composes twice, and the outer entry
   * cannot claim a second identity for the object the inner one already
   * claimed — one implementation states what it is once. So it observes and
   * passes the answer through, which is what keeps the layering additive.
   */
  readonly observesOnly?: boolean;
  /** What delegating answered with, for a row that has to prove it happened. */
  readonly delegated?: unknown[];
  /**
   * Run this inside the live resolution, just before claiming.
   *
   * The one place a row can reach that is *during* an open claim window for
   * this name — which is what a race between two resolutions has to be observed
   * from, since there is no other way to be inside one.
   */
  readonly whileResolving?: (request: ComponentAnswerRequest) => void;
  /**
   * Answer with a value whose contract reads differently each time it is read.
   *
   * The check/use gap at execution scale. `[[Get]]` alternates between the
   * claimed schema and a substitution; comparing own descriptors, which is how
   * the claim is checked, does not run the trap. So a capture that checked the
   * answer and then *read it again* to take its copy would seal the
   * substitution — and a fragment would be validated against a contract the
   * provider never claimed.
   */
  readonly alternating?: { readonly substitute: PropsSchema; readonly reads: string[] };
  /** Where this provider leaves each request its handler received, for a row to keep. */
  readonly retain?: ComponentAnswerRequest[];
}

/**
 * One answer whose `props` alternates between what was claimed and something
 * else, read by read.
 *
 * Only `[[Get]]` is trapped, because that is what taking a copy of a definition
 * uses and what comparing own descriptors does not. The schema is the member to
 * move, because it is load-bearing: what a fragment's element is validated
 * against is the schema on the definition the profile sealed.
 */
function alternatingAnswer(
  answer: FunctionComponentDefinition,
  substitute: PropsSchema,
  reads: string[],
): FunctionComponentDefinition {
  return new Proxy(answer, {
    get(target, key, receiver) {
      if (key !== "props") {
        return Reflect.get(target, key, receiver);
      }
      reads.push(String(key));
      return reads.length % 2 === 1 ? target.props : substitute;
    },
  });
}

/**
 * One honest provider, with whatever one row changed about it.
 *
 * It answers the capture and settles. That is what a provider is *for*: the
 * profile resolves its name once, before the root import, and seals what it
 * retained — so a fragment runs the sealed snapshot and the provider has
 * nothing left to supply. It still observes every later import and delegates,
 * which is the most a handler may do to a generated one.
 *
 * The middleware answers without delegating while it is answering, which is the
 * case that matters: nothing is registered under this name and no file supplies
 * it, so the chain's final answer at capture is this provider's implementation
 * or the import fails. There is no second place it could come from.
 */
export function answerProvider(
  name: string,
  answer: FunctionComponentDefinition,
  options: ProviderOptions = {},
): ComponentAnswerInstallation {
  const origin = options.origin ?? "test://provider";
  const key = options.key ?? name;
  const revision = options.revision ?? "1";
  let settled = false;
  return {
    origin,
    *install(registrar: ComponentAnswerRegistrar): Operation<void> {
      yield* registrar.around(function* (request, next) {
        const asked = request.name;
        if (asked !== name) {
          return yield* next();
        }
        // Retained *per invocation*, which is what a row keeping a stale one
        // is keeping: the installation is never handed over, so there is no
        // stable object for a provider to hold instead.
        options.retain?.push(request);
        options.asked?.push(asked);
        if (settled) {
          if (options.reclaimsLater) {
            // Still trying to *identify* an answer after its resolution
            // settled. There is no window open for this name, so the claim
            // itself is what refuses.
            return request.claim(answer, { key, revision });
          }
          if (options.keepsAnswering) {
            // Still answering, without claiming. Whatever this returns is not
            // the object canonical execution issued for the import that asked,
            // so the witness is what refuses.
            return answer;
          }
          return yield* next();
        }
        settled = true;
        options.lookups?.push(asked);
        if (options.observesOnly) {
          const answered = yield* next();
          options.delegated?.push(answered);
          return answered;
        }
        if (options.delegatesFirst) {
          // An outer provider sees the chain's answer before deciding. What it
          // does with it is a row's business; recording it is what lets a row
          // say the inner half genuinely answered — and claiming *after*
          // delegating is what an outer replacement has to be able to do.
          options.delegated?.push(yield* next());
        }
        options.whileResolving?.(request);
        if (options.unclaimed) {
          return answer;
        }
        const supplied =
          options.alternating === undefined
            ? answer
            : alternatingAnswer(answer, options.alternating.substitute, options.alternating.reads);
        const claimed = request.claim(supplied, { key, revision });
        if (options.copied) {
          // The outer-replacement case: a handler further out returns its own
          // object, so the claim does not travel with the name.
          return { ...claimed };
        }
        if (options.mutated) {
          // The same object, edited after the claim. What was claimed is no
          // longer what is there.
          Object.assign(claimed, { name: `${name}Substituted` });
        }
        return claimed;
      });
    },
  };
}
