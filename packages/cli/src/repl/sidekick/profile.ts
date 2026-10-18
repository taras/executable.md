/**
 * The ceiling a reply is evaluated under, and the description of it a reply reads.
 *
 * One list does both jobs. The pinned entries below are what Core admits — a
 * name and an authored form resolve to exactly one of them or to nothing — and
 * the compact surface a new conversation is given is *derived from those same
 * entries*. That is the whole design choice here: a second catalogue, written
 * by hand to describe the first, is a document that starts out true and drifts.
 * An agent told about a control that is not admitted will write it and be
 * refused; one not told about a control that is cannot use it.
 *
 * ## What the ceiling says, and what it therefore cannot say
 *
 * Every control in this ceiling is *designated*: what it answered is collected
 * and sent to the next turn. Writes included — a reply that asked the root to
 * admit an entry has to be told which entry it admitted, or its next response is
 * written against a guess, and a reply that asked somebody a question has to be
 * told what they said. Canonical `<Syntax />` is the one exception, and it is an
 * exception about interception rather than about admission: it describes this
 * response context, and its return is the reply's own to render or capture.
 *
 * Two classes. `read` observes and returns: the acknowledged bindings, the
 * entry vocabulary, the six guide chapters, the environment, and an entry's
 * output. `write` is what changes what a person sees or asks them something:
 * filling the shared draft, submitting it, and canonical `<Elicit>`. Keeping
 * them separate is what lets a captured ceiling state that a reply which only
 * read could not have written and interrupted nobody — something nobody can say
 * about a single undifferentiated list.
 *
 * The question is Core's own component rather than one of this feature's, so
 * `Elicit` is *selected* and not answered for: it is protected, canonical
 * resolution answers it from core's own tier, and the body a reply reaches is
 * the body an authored document reaches. What makes it the *Sidekick's*
 * question is where the provider is installed, which is the owner's scope and
 * not the session's.
 *
 * Everything else is unavailable, and unavailable by *absence* rather than by a
 * rule written here: `<Content>`, `<Return>`, executable fences, JavaScript
 * expressions, component definitions and unpinned resolution are refused by
 * Core's own root admission, and this module adds no filter of its own. There
 * is no second evaluator and no regular-expression preview parser in the CLI.
 *
 * Canonical `<Syntax />` is admitted too, by the execution that evaluates the
 * root rather than from here: a root is evaluated through
 * `HostExecution.evaluateGeneratedXmdRoot()`, and the execution lends it the
 * canonical implementation and the documentation it captured before its own
 * root import, so `<Syntax />` answers from the table this reply actually
 * admitted and from the chapters this execution's packages contributed. So it
 * appears in the description below, in the read class, and it is deliberately
 * not a designated result — its ordinary return is the reply's to render or
 * capture.
 *
 * ## Response syntax and entry syntax are different things
 *
 * They are described separately and labelled as such, because conflating them
 * is the mistake an unfamiliar agent will otherwise make: `<Each>` is ordinary
 * in an entry and unavailable in a reply, and a reply that tried to run one
 * would be refused for a reason it had no way to anticipate. The compact
 * surface below is the *reply's* vocabulary. The entry vocabulary is a read —
 * `<REPL.Syntax />` — because it is large, it changes with the profile and
 * plugins in play, and a reply needs it only when it is about to write one.
 */

import { Component, SYNTAX_COMPONENT } from "@executablemd/core";
import type { GeneratedSelection, InvocationForm } from "@executablemd/core";
import { coreCompositionVocabulary } from "@executablemd/core/host";
import type {
  ComponentAnswerInstallation,
  ComponentAnswerRegistrar,
  ExecutionInstallation,
} from "@executablemd/core/host";
import type { FunctionComponentDefinition } from "@executablemd/core";
import type { Operation } from "effection";

import {
  DESIGNATED,
  sidekickDestinations,
  sidekickMutations,
  sidekickObservations,
} from "./controls.ts";
import type {
  ControlJournal,
  SidekickControl,
  SidekickDestinations,
  SidekickRequests,
} from "./controls.ts";

/**
 * The ceiling one response is admitted under, as its execution captures it.
 *
 * Not a table passed with each call. A root is admitted from the selection its
 * owning execution captured, so what this holds is what that capture needs: the
 * controls this conversation owns, and the classes a response may draw on. The
 * installation below is how they reach the execution — once, at setup, before
 * any response exists.
 */
export interface ResponseCeiling {
  /** Every control this conversation owns, reads and writes alike. */
  readonly controls: readonly SidekickControl[];
  /** Both classes, always: a reply may read and may write the draft. */
  readonly allow: readonly ["read", "write"];
  /**
   * Where a selected result of one of those controls goes.
   *
   * Beside the controls rather than behind them, because the two are one
   * capture: an entry names the exact definition this conversation published,
   * and the occurrence a control body is in is the occurrence its destination
   * receives.
   */
  readonly destinations: SidekickDestinations;
}

/**
 * Build the ceiling for one conversation's responses.
 *
 * Built per owner rather than once per process, because the controls close over
 * the requests that answer them: two conversations are two sets of semantic
 * requests, and sharing one ceiling would let a reply in one conversation ask
 * the other one's root to submit an entry.
 */
export function sidekickResponseCeiling(
  requests: SidekickRequests,
  journal: ControlJournal,
): ResponseCeiling {
  const destinations = sidekickDestinations(journal);
  return {
    controls: Object.freeze([
      ...sidekickObservations(requests, journal, destinations),
      ...sidekickMutations(requests, journal, destinations),
    ]),
    allow: ["read", "write"] as const,
    destinations,
  };
}

/**
 * The selection this conversation's execution captures.
 *
 * One name per control, each in the single spelling it is offered for. What
 * each admitted spelling then runs under — its identity and whether it
 * observes or mutates — is read off the definition the capture resolved, so
 * this states which names a response may write and nothing about what writing
 * them grants.
 */
export function sidekickSelection(ceiling: ResponseCeiling): GeneratedSelection {
  const selection: Record<string, readonly InvocationForm[]> = {};
  for (const control of ceiling.controls) {
    selection[control.name] = [control.form];
  }
  return Object.freeze(selection);
}

/**
 * The installation that hands this conversation's controls to its execution.
 *
 * Both halves of one act, and both at setup: each control this CLI defines is
 * published as a component answer under its own name, and the selection naming
 * them is offered from `install()` — which canonical execution calls in the
 * invocation's own scope *before* it reads the selection and resolves each
 * name. A control with no definition of its own is selected and not answered
 * for: it is a protected name, and core's own tier answers it.
 *
 * Capturing here rather than per response is what makes a response's ceiling
 * this conversation's: the profile is resolved and sealed once, so a later
 * registration, a middleware replacement or a second selection changes nothing
 * a response is admitted under.
 */
export function sidekickCeilingInstallation(ceiling: ResponseCeiling): ExecutionInstallation {
  /** The definition this CLI answers each owned name with. */
  const owned = new Map<string, FunctionComponentDefinition>();
  for (const control of ceiling.controls) {
    if (control.definition !== undefined) {
      owned.set(control.name, control.definition);
    }
  }
  const selection = sidekickSelection(ceiling);
  const answers: ComponentAnswerInstallation = {
    origin: CONTROL_ORIGIN,
    *install(registrar: ComponentAnswerRegistrar): Operation<void> {
      /**
       * Which names this execution's capture has already been answered for.
       *
       * A provider answers the *capture*, once per name, and then settles: the
       * capture resolves each selected name before the conversation's root
       * import and seals what it retained, so an admitted control runs that
       * sealed snapshot — and a provider still answering when a response
       * resolves its admitted name would be substituting into the response,
       * which canonical execution refuses.
       *
       * Per `install()` and therefore per execution, because one owner opens
       * more than one conversation over its life: a reopening, a replacement
       * and a switch are each a fresh execution with a capture of its own, and
       * a set kept outside this call would have told the second one that every
       * name was already settled — leaving its selected controls unresolvable.
       */
      const settled = new Set<string>();
      yield* registrar.around(function* (request, next) {
        const definition = owned.get(request.name);
        if (definition === undefined || settled.has(request.name)) {
          // Every other name — this conversation's protected `Elicit` included,
          // and every later import of a name already answered for: the chain
          // answers, and for a protected name that is core's own tier.
          return yield* next();
        }
        settled.add(request.name);
        // Published through the request canonical execution minted for this
        // invocation, which is what makes the object the capture seals the
        // object this CLI meant to supply.
        return request.answer(definition);
      });
    },
  };
  return {
    componentAnswers: [answers],
    // The destinations this conversation owns, one per control it publishes.
    // Stated on the same installation the answers are, so what canonical
    // execution copies before any document code runs is the whole of it: the
    // definition each entry names is the exact object the request above
    // published, and an entry naming anything else routes nothing.
    resultDestinations: {
      destinations: Object.freeze([
        ...[...owned.values()].map((definition) => ceiling.destinations.entry(definition)),
        // A control this conversation selects rather than answers for —
        // canonical `<Elicit>`. There is no definition here to hand over, so
        // the entry names the selection and core resolves which implementation
        // its own tier answered with.
        ...ceiling.controls
          .filter((control) => control.selected === true)
          .map((control) => ceiling.destinations.selected(control.name)),
      ]),
      installed: (lookup, running) => {
        ceiling.destinations.installed(lookup, running);
      },
    },
    *install(): Operation<void> {
      yield* Component.around({ generated: () => selection });
    },
  };
}

/** Where this conversation's own controls are published from. */
const CONTROL_ORIGIN = "@executablemd/cli:repl/sidekick";

/** One admitted control, as the compact surface describes it. */
export interface SurfaceEntry {
  readonly name: string;
  /**
   * What writing this does.
   *
   * `read` observes and returns; `write` changes something a person sees;
   * `render` turns a value the reply already holds into text and reaches
   * nothing — core's always-on composition table, which `allow` does not select
   * between and which therefore grants no permission at all.
   */
  readonly effect: "read" | "write" | "render";
  /**
   * Which spelling is admitted.
   *
   * The control's own, read off what its owner offers rather than guessed
   * here: a control offered paired is described paired, because that is the
   * one spelling the capture admitted it for.
   */
  readonly form: InvocationForm;
  /** The props this control admits, by name, from its own schema. */
  readonly props: readonly string[];
  /** Whether its return is collected and sent back as the next turn's input. */
  readonly designated: boolean;
}

/**
 * The compact canonical description of what a reply may write.
 *
 * Read off the pinned entries, so it cannot describe a control that is not
 * admitted or omit one that is. `props` comes from each definition's own
 * schema — the same schema Core validates against — which is why a control
 * gaining a prop cannot leave this description behind.
 */
export function responseSurface(ceiling: ResponseCeiling): readonly SurfaceEntry[] {
  const entries: SurfaceEntry[] = [
    {
      // Admitted by the execution that evaluates the root, not by this
      // ceiling, so it is named here rather than read off the entries. It
      // describes this response's own vocabulary, which is the one thing the
      // derived list below cannot say about itself.
      name: SYNTAX_COMPONENT,
      effect: "read",
      form: "self-closing",
      props: ["names"],
      designated: false,
    },
  ];
  // Core's always-on composition table, derived from core rather than listed
  // here. A reply may write these whatever `allow` selected, so a surface that
  // omitted one would describe a vocabulary narrower than the one the response
  // is admitted under — and a hand-kept copy would stop being true the next
  // time core admits a pure component. Their returns are the reply's own to
  // render: nothing is performed, so there is nothing to answer back.
  for (const pure of coreCompositionVocabulary()) {
    entries.push({
      name: pure.name,
      effect: "render",
      form: pure.form,
      props: ["value"],
      designated: false,
    });
  }
  for (const control of ceiling.controls) {
    entries.push({
      name: control.name,
      effect: control.effect,
      form: control.form,
      // The props each control's own schema admits. A control this CLI does not
      // define — a protected name selected rather than answered for — has no
      // schema here to read, so it states the authored contract it was selected
      // for instead.
      props: control.definition === undefined ? (control.props ?? []) : propsOf(control.definition),
      designated: DESIGNATED.has(control.name),
    });
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

/** How one control is written, in the form it is admitted for. */
function spellingOf(entry: SurfaceEntry): string {
  switch (entry.form) {
    case "paired":
      return `<${entry.name}>…</${entry.name}>`;
    case "self-closing":
      return `<${entry.name} />`;
    default:
      // Both spellings admitted, so both are stated: an agent told only one
      // would treat the other as unavailable.
      return `<${entry.name} /> or <${entry.name}>…</${entry.name}>`;
  }
}

/** The prop names one definition's schema admits, in schema order. */
function propsOf(definition: { props?: unknown }): readonly string[] {
  const schema = definition.props;
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) {
    return [];
  }
  return Object.freeze(Object.keys(properties));
}

/**
 * The compact surface as the text a first turn is given.
 *
 * Deliberately terse. A first turn carries orientation, this surface, the guide
 * index, the current draft and the person's request — and the detail lives in
 * the chapters a reply reads when it needs them. A long description here would
 * spend the first turn's attention on vocabulary the reply may never use.
 */
export function describeSurface(entries: readonly SurfaceEntry[]): string {
  const lines = [
    "Controls you may write in a reply (nothing else is available). After your " +
      "response finishes, what each one answered comes back to you as feedback, " +
      "except where a line says otherwise:",
  ];
  for (const entry of entries) {
    const spelling = spellingOf(entry);
    const props = entry.props.length === 0 ? "" : ` props: ${entry.props.join(", ")}`;
    // Stated as the exception rather than the rule. Every control in this
    // ceiling answers back, so marking each of them would be the same note on
    // every line but one — and that one line is the thing a reply has to know.
    const ordinary = entry.designated ? "" : " (its return is yours to render, not feedback)";
    lines.push(`- ${spelling} — ${entry.effect}.${props}${ordinary}`);
  }
  // Stated once, after the list, because it is one rule about every control
  // rather than a prop any of them declares: `yq` and `as` are the engine's,
  // they are consumed before a control's own props are checked, and a control's
  // schema therefore never mentions either. Describing them per line would read
  // as six separate contracts for one rule.
  lines.push(
    "",
    "Two props are the engine's own and may be written on any control above, " +
      "beside that control's own props:",
    '- yq="<expression>" — select one JSON value out of what the control returned, ' +
      "with yq. The selected value is what is captured and what comes back as feedback. " +
      "A control that returns text is queried as a JSON string, so decode it explicitly " +
      "with from_json or from_yaml. An expression that matches nothing, or matches more " +
      "than once, refuses — collect matches into an array with [ ... ].",
    '- as="<name>" — bind the result instead of rendering it.',
  );
  return lines.join("\n");
}
