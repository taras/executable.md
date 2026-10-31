/**
 * The things a REPL screen is made of.
 *
 * Each one renders exactly what its input says and handles exactly the input it
 * has a meaning for. A row that has no use for Escape lets Escape pass, so the
 * drawer above it still closes. That is the whole reason event handlers are per-node
 * rather than a table somewhere: the answer to "what does this keystroke mean"
 * depends on what is under the cursor.
 *
 * A row that has no use for text handles none, and text nothing handles reaches
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

import { caretFor, moveCaret } from "../caret.ts";
import type { ReplCaretRow } from "../caret.ts";

import { component, fields } from "../description.ts";
import type { ReplComponent, ReplInputEvent, ReplNode, ReplViewData } from "../description.ts";
import type { ReplAction, ReplCaretKey, ReplFieldPurpose } from "./actions.ts";

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

/**
 * A field drawn as a block: its marker and its name, with no value on the row.
 *
 * For the one field whose value is fitted into rows of its own beneath it. The
 * value is deliberately absent here rather than shortened: it is drawn in full
 * below, so putting the last line of it on the name as well would say the same
 * text twice, and the count of earlier lines would stand in for rows that are
 * really there.
 */
export function fieldLabel(prompt: string, focused: boolean): string {
  const parts = fieldParts(prompt, "", focused);
  return `${parts.marker}${parts.prompt}`;
}

/** The keys a field keeps for its caret, so they never become navigation. */
const CARET_KEYS: ReadonlyMap<string, ReplCaretKey> = new Map<string, ReplCaretKey>([
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["Home", "Home"],
  ["End", "End"],
]);

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
      if (event.kind === "key") {
        const beyond = revealed(node.input, event.key);
        if (beyond !== undefined) {
          return { kind: "reveal", key: beyond };
        }
      }
      if (event.kind !== "pointer" && (event.kind !== "key" || event.key !== "Enter")) {
        return undefined;
      }
      return activation(node.input);
    });
  },
});

/**
 * The row this key reaches that its window is not showing, if there is one.
 *
 * A row of a windowed list is told, by key, which of its logical neighbours lie
 * outside the window. Every other arrow is left for navigation among the rows
 * that are mounted.
 */
function revealed(input: ReplViewData, key: string): string | undefined {
  const reveal = fields(fields(input)?.["reveal"] ?? null)?.[key];
  return typeof reveal === "string" ? reveal : undefined;
}

/** What activating one row asks for, read from its own input. */
function activation(input: ReplViewData): ReplAction | undefined {
  const named = fields(input);
  if (named === undefined) {
    return undefined;
  }
  const select = named["select"];
  if (select === "surface") {
    const surface = named["surface"];
    return surface === "entries" || surface === "sessions"
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
  if (select === "pane") {
    const pane = named["pane"];
    return pane === "bindings" || pane === "sidekick" ? { kind: "select-pane", pane } : undefined;
  }
  if (select === "send-message") {
    return { kind: "send-message" };
  }
  if (select === "remove-sidekick-message") {
    const message = named["message"];
    return typeof message === "string" ? { kind: "remove-sidekick-message", message } : undefined;
  }
  if (select === "resume-sidekick-queue") {
    return { kind: "resume-sidekick-queue" };
  }
  if (select === "stop-sidekick") {
    return { kind: "stop-sidekick" };
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
  // The Sidekick's own question, named on every one of its controls. Two
  // owners ask questions, and an action that said only "the form" would be
  // answered by whichever one the reducer looked at.
  if (select === "sidekick-question") {
    const question = named["question"];
    return typeof question === "string" ? { kind: "open-sidekick-question", question } : undefined;
  }
  if (select === "sidekick-question-close") {
    return { kind: "close-sidekick-question" };
  }
  if (select === "sidekick-form-field") {
    const question = named["question"];
    const field = named["field"];
    return typeof question === "string" && typeof field === "string"
      ? { kind: "select-sidekick-field", question, field }
      : undefined;
  }
  if (select === "sidekick-form-choice") {
    const question = named["question"];
    const field = named["field"];
    const option = named["option"];
    return typeof question === "string" && typeof field === "string" && typeof option === "string"
      ? { kind: "choose-sidekick", question, field, option }
      : undefined;
  }
  if (select === "sidekick-form-submit") {
    const question = named["question"];
    return typeof question === "string" ? { kind: "answer-sidekick", question } : undefined;
  }
  if (select === "configure") {
    const conversation = named["conversation"];
    return {
      kind: "open-configure",
      ...(typeof conversation === "string" ? { conversation } : { conversation: undefined }),
    };
  }
  if (select === "configure-refresh") {
    return { kind: "refresh-configure" };
  }
  if (select === "configure-close") {
    return { kind: "close-configure" };
  }
  if (select === "configure-model") {
    const model = named["model"];
    return typeof model === "string" ? { kind: "choose-model", model } : undefined;
  }
  if (select === "configure-effort") {
    const effort = named["effort"];
    return typeof effort === "string" ? { kind: "choose-effort", effort } : undefined;
  }
  if (select === "configure-agent") {
    return { kind: "name-agent" };
  }
  if (select === "configure-apply") {
    return { kind: "apply-configure" };
  }
  if (select === "retry-message") {
    const conversation = named["conversation"];
    const message = named["message"];
    return typeof conversation === "string" && typeof message === "number"
      ? { kind: "retry-message", conversation, message }
      : undefined;
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
  if (select === "session-filter") {
    return { kind: "toggle-session-filter" };
  }
  if (select === "submit-draft") {
    return { kind: "submit" };
  }
  if (select === "catalog") {
    return { kind: "open-catalog" };
  }
  if (select === "catalog-close") {
    return { kind: "close-catalog" };
  }
  if (select === "stop-entry") {
    // The entry this control was drawn against, and only a real one: a row
    // with no entry to name is a row that stops nothing.
    const entry = named["entry"];
    return typeof entry === "string" && entry.length > 0
      ? { kind: "stop-entry", entry }
      : undefined;
  }
  // One saved Sidekick turn, by its own chat and canonical ordinal. Both,
  // because a turn number means nothing outside the conversation that holds
  // it, and a row that carried only one of them would open a chat at a turn
  // somebody else's conversation had.
  if (select === "sidekick-turn") {
    const conversation = named["conversation"];
    const turn = named["turn"];
    if (typeof conversation !== "string" || conversation.length === 0) {
      return undefined;
    }
    if (turn === undefined) {
      return { kind: "read-sidekick-turn", conversation, turn: undefined };
    }
    return typeof turn === "number" && turn > 0
      ? { kind: "read-sidekick-turn", conversation, turn }
      : undefined;
  }
  if (select === "sidekick-back") {
    return { kind: "read-current-chat" };
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
      if (event.kind === "key" && (event.key === "Alt+ArrowUp" || event.key === "Alt+ArrowDown")) {
        const beyond = revealed(node.input, event.key);
        if (beyond !== undefined) {
          return { kind: "reveal", key: beyond };
        }
      }
      const named = optional(node.input, "field");
      const purpose = optional(node.input, "purpose");
      const question = optional(node.input, "question");
      if (
        purpose !== "draft" &&
        purpose !== "message" &&
        purpose !== "answer" &&
        purpose !== "sidekick-answer" &&
        purpose !== "configure-agent"
      ) {
        return undefined;
      }
      const owns: {
        readonly purpose: ReplFieldPurpose;
        readonly field?: string;
        readonly question?: string;
      } = {
        purpose,
        ...(named === undefined ? {} : { field: named }),
        ...(question === undefined ? {} : { question }),
      };
      if (event.kind === "text") {
        return { kind: "type", text: event.text, ...owns };
      }
      if (event.kind !== "key") {
        return undefined;
      }
      if (event.key === "Backspace") {
        return { kind: "erase", ...owns };
      }
      const caret = CARET_KEYS.get(event.key);
      if (caret !== undefined) {
        const input = fields(node.input);
        const value = textOf(node.input, "text");
        const offset = input?.["caret"];
        const column = input?.["column"];
        const position = caretFor(
          value,
          typeof offset === "number"
            ? {
                value,
                offset,
                ...(typeof column === "number" ? { column } : {}),
                ...(input?.["backward"] === true ? { backward: true } : {}),
              }
            : undefined,
        );
        return {
          kind: "move-caret",
          key: caret,
          caret: moveCaret(position, caret, editorRows(node.input)),
          ...owns,
        };
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
  if (purpose === "configure-agent") {
    // Enter in the agent field asks for what Configure holds, exactly as Enter
    // in the draft runs the draft: one destination, one meaning.
    return { kind: "apply-configure" };
  }
  if (purpose === "sidekick-answer") {
    // The question's key is on the line itself, for the same reason it is on
    // every other control of this form: Enter here answers the question this
    // row was drawn for and no later one.
    const question = optional(input, "question");
    return question === undefined ? undefined : { kind: "answer-sidekick", question };
  }
  if (purpose === "message") {
    // Enter in the Sidekick's box asks the Sidekick, exactly as Enter in the
    // draft runs the draft. Two destinations, two meanings, and the field's own
    // description is what says which one this line is.
    return { kind: "send-message" };
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
 *
 * A **block** field is the exception, and it is one field still: its name and
 * focus marker are this row, and its value is fitted into rows of its own
 * beneath it. The node here is the same node — one focus owner, one editing
 * value, one hold on the keyboard — so the rows below add no Tab stop and
 * nothing else can answer for them.
 */
function rendered(input: ReplViewData): string {
  const shown = optional(input, "shown");
  if (shown !== undefined) {
    return shown;
  }
  const focused = fields(input)?.["focused"] === true;
  const prompt = textOf(input, "prompt");
  if (fields(input)?.["block"] === true) {
    return fieldLabel(prompt, focused);
  }
  return fieldText(prompt, textOf(input, "text"), focused);
}

/**
 * A drawer: a modal branch, closed by Escape.
 *
 * It handles Escape and nothing else. Escape closes the drawer and never answers
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
      if (event.kind !== "pointer" && (event.kind !== "key" || event.key !== "Enter")) {
        return undefined;
      }
      return back === "live" ? { kind: "go-live" } : { kind: "select-surface", surface: "entries" };
    });
  },
});

function editorRows(input: ReplViewData): readonly ReplCaretRow[] {
  const rows = fields(input)?.["caretRows"];
  if (!Array.isArray(rows)) {
    return [];
  }
  const result: ReplCaretRow[] = [];
  for (const row of rows) {
    const stops = fields(row)?.["stops"];
    if (!Array.isArray(stops)) {
      return [];
    }
    const parsed: { offset: number; column: number }[] = [];
    for (const stop of stops) {
      const offset = fields(stop)?.["offset"];
      const column = fields(stop)?.["column"];
      if (typeof offset !== "number" || typeof column !== "number") {
        return [];
      }
      parsed.push({ offset, column });
    }
    if (parsed.length > 0) {
      result.push({ stops: parsed });
    }
  }
  return result;
}

export const READING: ReplComponent<ReplAction> = component<ReplAction>({
  name: "reading-anchor",
  attach(node) {
    node.focusable();
    node.render(textOf(node.input, "label"));
    node.onInput((input) => node.render(textOf(input, "label")));
    node.claim((event) => {
      if (event.kind !== "key") {
        return undefined;
      }
      if (event.key === "Enter") {
        return { kind: "noop" };
      }
      const reading = fields(node.input)?.["reading"];
      if (
        reading !== "selected" &&
        reading !== "chat" &&
        reading !== "drawer" &&
        reading !== "empty"
      ) {
        return undefined;
      }
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        return { kind: "reading-key", reading, key: event.key };
      }
      return undefined;
    });
  },
});
