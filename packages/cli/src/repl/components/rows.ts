/**
 * The things a REPL screen is made of.
 *
 * Each one renders exactly what its input says and claims exactly the input it
 * has a meaning for. A row that has no use for Escape lets Escape pass, so the
 * drawer above it still closes. That is the whole reason claims are per-node
 * rather than a table somewhere: the answer to "what does this keystroke mean"
 * depends on what is under the cursor.
 *
 * A row that has no use for text claims none, and text nothing claims reaches
 * nothing: propagation runs up the ancestors of whatever holds focus, and the
 * draft is a sibling of these rows rather than an ancestor of them. So typing at
 * a control leaves the draft exactly as it was — which is the behavior, not an
 * oversight, because a keystroke that silently edited a field nobody is looking
 * at would be worse than one that does nothing. What makes it usable is that the
 * screen says so: the guidance above the surface names the way back to the draft
 * for as long as a control holds focus.
 *
 * No component here holds a `DurableEvent`, a stream, a session, a repository,
 * the route or a host operation. They are given detached view data and they
 * answer with a semantic action.
 */

import { component, fields } from "../description.ts";
import type { ReplComponent, ReplInputEvent, ReplNode, ReplViewData } from "../description.ts";
import type { ReplAction } from "./actions.ts";

/** Read one string field, by parsing rather than by assertion. */
export function textOf(input: ReplViewData, name: string): string {
  const value = fields(input)?.[name];
  if (typeof value !== "string") {
    throw new Error(`this component is given a { ${name}: string } input`);
  }
  return value;
}

/**
 * Whether this control holds focus, as the view said when it was built.
 *
 * Marked so a person can see which control their next keystroke reaches. It is
 * one frame behind the tree's own answer, because focus is derived from the tree
 * and a description is written before the commit that settles it — which is
 * exactly why the marker is redrawn after every commit rather than remembered.
 */
function marked(input: ReplViewData, label: string): string {
  return focusPrefixed(label, fields(input)?.["focused"] === true);
}

/**
 * One selectable row's text, focus marker included.
 *
 * Pure, and exported, because the pass that measures a region has to ask how
 * wide this row is before any node renders it. A measurement taken without the
 * marker is two columns narrower than the row drawn in its place, which is how a
 * control comes to be admitted to a row that cannot hold it.
 */
export function focusPrefixed(label: string, focused: boolean): string {
  return focused ? `> ${label}` : `  ${label}`;
}

/**
 * One editable line, as the four stretches it is drawn in.
 *
 * Separate because they are four different things — where the keystroke goes,
 * what the line is called, how much of the value is not on this row, and the
 * value itself — and the screen colours them separately. `fieldText` is their
 * concatenation, so there is one answer to what the row says and the parts
 * cannot drift from it.
 *
 * A value holding several lines shows its last one under a count of the rest: a
 * cell is a row, so a line that paid itself out over four of them would push the
 * controls below it off the screen.
 */
export function fieldParts(
  prompt: string,
  text: string,
  focused: boolean,
): {
  readonly marker: string;
  readonly prompt: string;
  readonly earlier: string;
  readonly value: string;
} {
  const lines = text.split("\n");
  const earlier = lines.length - 1;
  return Object.freeze({
    marker: focused ? ">" : " ",
    prompt,
    earlier: earlier === 0 ? "" : `[${earlier} line${earlier === 1 ? "" : "s"}] `,
    value: lines[lines.length - 1],
  });
}

/**
 * One editable line's text, for the pass that measures it.
 *
 * Pure, and exported, because the pass that measures a region has to ask how
 * wide this row is before any node renders it.
 */
export function fieldText(prompt: string, text: string, focused: boolean): string {
  const parts = fieldParts(prompt, text, focused);
  return `${parts.marker}${parts.prompt}${parts.earlier}${parts.value}`;
}

/** Read an optional string field. */
function optional(input: ReplViewData, name: string): string | undefined {
  const value = fields(input)?.[name];
  return typeof value === "string" ? value : undefined;
}

/** Text nobody can select: a transcript line, a binding summary, a heading. */
export const LINE: ReplComponent<ReplAction> = component<ReplAction>({
  name: "line",
  attach(node: ReplNode<ReplAction>): void {
    node.render(textOf(node.input, "label"));
    node.onInput((input: ReplViewData) => node.render(textOf(input, "label")));
  },
});

/**
 * A row that selects something when it is activated.
 *
 * `select` names what activating it asks for. The action is built from the
 * input's own fields rather than from the node's key, because a key is a
 * reconciliation identity and reading product meaning out of one would make
 * renaming a key a behavior change.
 */
export const SELECT_ROW: ReplComponent<ReplAction> = component<ReplAction>({
  name: "select-row",
  attach(node: ReplNode<ReplAction>): void {
    node.focusable();
    node.render(marked(node.input, textOf(node.input, "label")));
    node.onInput((input: ReplViewData) => node.render(marked(input, textOf(input, "label"))));
    node.claim((event: ReplInputEvent): ReplAction | undefined => {
      if (event.kind === "text") {
        return undefined;
      }
      if (event.kind !== "pointer" && event.key !== "Enter") {
        return undefined;
      }
      return activation(node.input);
    });
  },
});

/** What activating one row asks for, read from its own input. */
function activation(input: ReplViewData): ReplAction | undefined {
  const named = fields(input);
  if (named === undefined) {
    return undefined;
  }
  const select = named["select"];
  if (select === "surface") {
    const surface = named["surface"];
    return surface === "repl" || surface === "sessions"
      ? { kind: "select-surface", surface }
      : undefined;
  }
  if (select === "scope") {
    const scopes = named["scopes"];
    if (!Array.isArray(scopes)) {
      return undefined;
    }
    const keys: string[] = [];
    for (const key of scopes) {
      if (typeof key !== "string") {
        return undefined;
      }
      keys.push(key);
    }
    return { kind: "select-scope", scopes: keys };
  }
  if (select === "marker") {
    const marker = named["marker"];
    return typeof marker === "string" ? { kind: "select-marker", marker } : undefined;
  }
  if (select === "binding") {
    const name = named["name"];
    return typeof name === "string"
      ? { kind: "open-drawer", drawer: { kind: "binding", name } }
      : undefined;
  }
  if (select === "recorded-elicit") {
    const marker = named["marker"];
    return typeof marker === "string"
      ? { kind: "open-drawer", drawer: { kind: "recorded-elicit", marker } }
      : undefined;
  }
  if (select === "live-elicit") {
    return { kind: "open-drawer", drawer: { kind: "live-elicit" } };
  }
  if (select === "history") {
    return { kind: "open-drawer", drawer: { kind: "history" } };
  }
  if (select === "live") {
    return { kind: "go-live" };
  }
  if (select === "pause") {
    return { kind: "pause" };
  }
  if (select === "continue") {
    return { kind: "continue" };
  }
  if (select === "close") {
    return { kind: "close-drawer" };
  }
  if (select === "exit") {
    return { kind: "exit" };
  }
  if (select === "form-field") {
    const field = named["field"];
    return typeof field === "string" ? { kind: "select-field", field } : undefined;
  }
  if (select === "form-choice") {
    const field = named["field"];
    const option = named["option"];
    return typeof field === "string" && typeof option === "string"
      ? { kind: "choose", field, option }
      : undefined;
  }
  if (select === "form-submit") {
    return { kind: "answer" };
  }
  if (select === "scroll") {
    // A direction, not a position: the control knows which way it points, and
    // how far the region may travel is the frame's to decide.
    const delta = named["delta"];
    return typeof delta === "number" ? { kind: "scroll", delta } : undefined;
  }
  if (select === "scroll-sessions") {
    const delta = named["delta"];
    return typeof delta === "number" ? { kind: "scroll-sessions", delta } : undefined;
  }
  if (select === "scroll-entries") {
    const delta = named["delta"];
    return typeof delta === "number" ? { kind: "scroll-entries", delta } : undefined;
  }
  if (select === "session") {
    const session = named["session"];
    return typeof session === "string" && session.length > 0
      ? { kind: "select-session", session }
      : undefined;
  }
  if (select === "all-sessions") {
    return { kind: "all-sessions" };
  }
  if (select === "permission") {
    const request = named["request"];
    return typeof request === "string" ? { kind: "select-permission", request } : undefined;
  }
  if (select === "permission-choice") {
    const request = named["request"];
    const option = named["option"];
    return typeof request === "string" && typeof option === "string"
      ? { kind: "choose-permission", request, option }
      : undefined;
  }
  if (select === "permission-dismiss") {
    const request = named["request"];
    return typeof request === "string" ? { kind: "dismiss-permission", request } : undefined;
  }
  return undefined;
}

/**
 * A field text goes into: the entry draft, and the live Elicit answer.
 *
 * The same component for both, because typing is typing. Which field the text
 * reaches is decided by focus, and which field has focus is decided by the
 * description — so opening the live Elicit drawer moves the answer into the
 * focus root and the draft stops receiving anything, without either component
 * knowing the other exists.
 */
export const FIELD: ReplComponent<ReplAction> = component<ReplAction>({
  name: "field",
  attach(node: ReplNode<ReplAction>): void {
    node.focusable();
    node.render(rendered(node.input));
    node.onInput((input: ReplViewData) => node.render(rendered(input)));
    node.claim((event: ReplInputEvent): ReplAction | undefined => {
      // The field this line edits, read off its own description. Text reaches
      // the field the person is actually on rather than whichever one the
      // application last recorded as selected.
      const named = optional(node.input, "field");
      const owns: { readonly field?: string } = named === undefined ? {} : { field: named };
      if (event.kind === "text") {
        return { kind: "type", text: event.text, ...owns };
      }
      if (event.kind === "pointer") {
        return undefined;
      }
      if (event.key === "Backspace") {
        return { kind: "erase", ...owns };
      }
      if (event.key === "Enter") {
        return submission(node.input);
      }
      return undefined;
    });
  },
});

/** What submitting this field asks for. */
function submission(input: ReplViewData): ReplAction | undefined {
  const purpose = optional(input, "purpose");
  if (purpose === "draft") {
    return { kind: "submit" };
  }
  if (purpose === "answer") {
    return { kind: "answer" };
  }
  return undefined;
}

/**
 * A field shows its prompt and the line being edited.
 *
 * One line, because a field is one line. A pasted document is many, and the
 * earlier ones are said to be there rather than drawn into a footer that is a
 * row tall — what the whole draft is remains exactly readable in the canonical
 * location, which is where a caller reopens it from.
 */
function rendered(input: ReplViewData): string {
  return fieldText(
    textOf(input, "prompt"),
    textOf(input, "text"),
    fields(input)?.["focused"] === true,
  );
}

/**
 * A drawer: a modal branch, closed by Escape.
 *
 * It claims Escape and nothing else. Escape closes the drawer and never answers
 * the question inside it, because a person dismissing a prompt has not chosen
 * one of its options.
 */
export const DRAWER: ReplComponent<ReplAction> = component<ReplAction>({
  name: "drawer",
  attach(node: ReplNode<ReplAction>): void {
    node.render(textOf(node.input, "label"));
    node.onInput((input: ReplViewData) => node.render(textOf(input, "label")));
    node.claim((event: ReplInputEvent): ReplAction | undefined =>
      event.kind === "key" && event.key === "Escape" ? { kind: "close-drawer" } : undefined,
    );
  },
});

/**
 * A refusal, and the route back when there is one.
 *
 * Focusable only when it offers somewhere to go: a refusal with no remedy is
 * something to read, and making it focusable would put the focus chain on a
 * control that does nothing.
 */
export const REFUSAL: ReplComponent<ReplAction> = component<ReplAction>({
  name: "refusal",
  attach(node: ReplNode<ReplAction>): void {
    const back = optional(node.input, "back");
    if (back !== undefined) {
      node.focusable();
    }
    node.render(textOf(node.input, "label"));
    node.onInput((input: ReplViewData) => node.render(textOf(input, "label")));
    if (back === undefined) {
      return;
    }
    node.claim((event: ReplInputEvent): ReplAction | undefined => {
      if (event.kind === "text") {
        return undefined;
      }
      if (event.kind !== "pointer" && event.key !== "Enter") {
        return undefined;
      }
      return back === "live" ? { kind: "go-live" } : { kind: "select-surface", surface: "repl" };
    });
  },
});
