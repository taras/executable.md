/**
 * `<Answers>` and `<Answer>` — supplying elicitation answers from the document
 * (specs/executable-mdx-spec.md §6.16.2).
 *
 * ```md
 * <Answers>
 * <Answer template="Approve {?what}?" value={{ decision: "approve" }} />
 *
 * <ReviewGate plan={plan} as="verdict" />
 * </Answers>
 * ```
 *
 * A component that elicits internally asks whoever the host's provider reaches.
 * Sometimes the surrounding document already knows the answer — a workflow
 * exercising somebody else's component non-interactively, a demo, a region of a
 * run that should not stop for a person. This is how a document says so without
 * writing TypeScript.
 *
 * `<Answers>` is elicitation middleware wearing a construct's clothes: it
 * installs a provider around its body's expansion and answers from its
 * matchers. It adds nothing to what the Elicitation Api already does — every
 * elicitation inside it is an ordinary one, judged by core against the *asking*
 * component's schema before it binds, so a supplied value that does not fit
 * fails exactly as a live provider's answer would.
 *
 * ## Why these are structural rather than registered
 *
 * A function component sees `content()` — rendered text. Matchers are
 * structure: `value` is an expression prop, `template` is a prop-or-children
 * pair, and each needs its own position for printed errors, and only the element
 * itself carries those. That is why these are structural rather than
 * components: being reserved means a repository file named `Answers.md` never
 * stands in, and it could not implement matcher semantics if it did.
 *
 * Partitioning before expanding is what the structural dispatch buys. Matchers
 * are collected from the whole child list first, so where an `<Answer>` is
 * written does not decide what it can answer; and "an `<Answers>` with no body"
 * is a structural fact rather than a guess from empty rendered text.
 *
 * ## Selection
 *
 * First declared match wins, and a matcher is reusable — it answers every
 * elicitation it matches for as long as the region lasts. That pair is the whole
 * rule, and its consequence is deliberate: a broad template above a narrow one
 * shadows it permanently. An `<Answer>` that never fires is not an error.
 *
 * ## Templates and the `{binding}` asymmetry
 *
 * Templates match the whole rendered message: literal text constrains,
 * `{?name}` matches any text and binds nothing, `{binding}` interpolates an
 * existing binding and requires it at that position.
 *
 * The two spellings are not identical for `{binding}`, and the difference is
 * inherited from `<WhenPrompt>` rather than introduced here. In the `template`
 * prop the string is a literal, so `{binding}` reaches the engine intact and the
 * engine resolves it — an unbound name is a configuration error naming the
 * template. In the children form the text is interpolated during expansion, so
 * an in-scope binding is substituted before the engine sees it, and an
 * out-of-scope one survives to be reported by the engine. The matching
 * constraint is the same either way; only which layer reports an absent binding
 * differs.
 */

import { scoped } from "effection";
import type { Operation } from "effection";

import { env, raise } from "./component-api.ts";
import { renderSegments } from "./render.ts";
import { evaluateExpression } from "./expand.ts";
import { Elicitation } from "./elicitation-api.ts";
import type { ElicitationRequest } from "./elicitation-api.ts";
import { JsonParseError, parseJson } from "./json.ts";
import { matchPrompt, parseTemplate } from "./template.ts";
import type { ParsedTemplate } from "./template.ts";
import type { ComponentElement, ErrorSegment, Json, Segment } from "./types.ts";

/**
 * The enclosing expansion's recursion, handed in by the arm that dispatched the
 * region.
 *
 * A region renders segments of its own — its body, and each matcher's template
 * children — and those have to expand with the interpolation inputs, hide set
 * and block counter of the expansion they were written in. Only the dispatching
 * arm holds that state, so it binds the recursion and passes it down; nothing
 * here could reconstruct which expansion a region belongs to.
 */
type ExpandSegments = (segments: Segment[]) => Operation<Segment[]>;

const ANSWERS = "Answers";
const ANSWER = "Answer";

/** One matcher, ready to be tried. `template` absent matches any message. */
interface Matcher {
  template?: ParsedTemplate;
  value: Json;
}

function positioned(message: string, element: ComponentElement): string {
  const { position } = element;
  if (!position) {
    return message;
  }
  const file = position.path === undefined ? "" : `${position.path}:`;
  return `${message} (${file}${position.line}:${position.column})`;
}

function configError(name: string, message: string, element: ComponentElement): ErrorSegment {
  return { type: "error", message: positioned(`<${name}> ${message}`, element), source: name };
}

function isAnswer(segment: Segment): segment is ComponentElement {
  return segment.type === "component" && segment.name === ANSWER;
}

/** Markdown puts blank lines between block elements; they are not a body. */
function isBlankText(segment: Segment): boolean {
  return segment.type === "text" && segment.content.trim() === "";
}

/** A `<Answer>` written outside the `<Answers>` that would have read it. */
export function strayAnswerError(element: ComponentElement): ErrorSegment {
  return configError(
    ANSWER,
    "must be a direct child of <Answers>. It is reserved: it never resolves a " +
      "component, and only the <Answers> it belongs to can read it.",
    element,
  );
}

export function* expandAnswers(
  element: ComponentElement,
  expand: ExpandSegments,
): Operation<Segment[]> {
  for (const name of Object.keys({ ...element.props, ...element.expressions })) {
    if (name !== "delegate") {
      return [
        yield* raise(
          configError(ANSWERS, `does not accept a "${name}" prop (allowed: delegate).`, element),
        ),
      ];
    }
  }
  const delegate = yield* readDelegate(element);
  if (delegate.error) {
    return [yield* raise(configError(ANSWERS, delegate.error, element))];
  }

  const body: Segment[] = [];
  const matchers: Matcher[] = [];
  for (const child of element.children) {
    if (isAnswer(child)) {
      const parsed = yield* readAnswer(child, expand);
      if (isErrorSegment(parsed)) {
        // The region cannot be trusted to answer anything, so it does not
        // expand a body that would ask. The printed error is returned rather than
        // only raised, so the caller settles it under its own error mode.
        return [parsed];
      }
      matchers.push(parsed);
      continue;
    }
    body.push(child);
  }

  if (element.selfClosing || body.every(isBlankText)) {
    return [
      yield* raise(
        configError(
          ANSWERS,
          "has no body to answer for. It wraps the region whose elicitations it answers, so " +
            "an <Answers> containing only matchers can never do anything.",
          element,
        ),
      ),
    ];
  }

  const bindings = (yield* env)?.values ?? {};

  // Scoped, so the provider's lifetime is exactly the body's expansion. Without
  // this the install would land on the enclosing expansion's scope and the
  // region would go on answering elicitations written after its closing tag.
  return yield* scoped(function* () {
    yield* Elicitation.around(
      {
        *elicit([request], next) {
          // First declared match wins, and finding it does not remove it: a
          // matcher answers every elicitation it matches for as long as the
          // region lasts.
          const matched = matchers.find((matcher) => matches(matcher, request, bindings));
          if (matched) {
            return matched.value;
          }
          if (delegate.value) {
            return yield* next(request);
          }
          throw new Error(unmatched(request, matchers));
        },
      },
      { at: "min" },
    );

    return yield* expand(body);
  });
}

function matches(
  matcher: Matcher,
  request: ElicitationRequest,
  bindings: Record<string, unknown>,
): boolean {
  if (!matcher.template) {
    return true;
  }
  return matchPrompt(matcher.template, request.message, bindings).ok;
}

/**
 * What an unmatched elicitation says.
 *
 * Both sides, in `PromptMismatchError`'s style: the message nobody answered and
 * every template that was tried, so the comparison does not have to be
 * reconstructed from the document.
 */
function unmatched(request: ElicitationRequest, matchers: Matcher[]): string {
  const tried =
    matchers.length === 0
      ? "  (no <Answer> matchers were declared)"
      : matchers
          .map(
            (matcher) =>
              `  - ${matcher.template ? `"${matcher.template.source}"` : "(no template)"}`,
          )
          .join("\n");
  return (
    "<Answers> has no matcher for this elicitation.\n" +
    `  actual: ${JSON.stringify(request.message)}\n` +
    `  tried:\n${tried}\n` +
    "Add an <Answer> whose template matches, or write delegate={true} to pass unmatched " +
    "elicitations outward."
  );
}

function isErrorSegment(value: Matcher | ErrorSegment): value is ErrorSegment {
  return "type" in value && value.type === "error";
}

/** One `<Answer>`, or the printed error that says why it is not one. */
function* readAnswer(
  element: ComponentElement,
  expand: ExpandSegments,
): Operation<Matcher | ErrorSegment> {
  for (const name of Object.keys({ ...element.props, ...element.expressions })) {
    if (name !== "template" && name !== "value") {
      return yield* refuse(element, `does not accept a "${name}" prop (allowed: template, value).`);
    }
  }

  // An expression template is never read, and silently produces a matcher with
  // no template — which first-wins plus reusable turns into permanent shadowing
  // of everything below it. `<WhenPrompt>` reaches its "requires a template"
  // error by the same route; this says so directly.
  if ("template" in element.expressions) {
    return yield* refuse(
      element,
      "template must be a literal string prop or template children, not an expression. " +
        "Write the bindings a template references as {binding} holes inside it.",
    );
  }

  const templateProp = element.props.template;
  const hasChildren = !element.selfClosing && element.children.length > 0;
  if (typeof templateProp === "string" && hasChildren) {
    return yield* refuse(element, "accepts either a template prop or template children, not both.");
  }

  let template: ParsedTemplate | undefined;
  const source =
    typeof templateProp === "string"
      ? templateProp
      : hasChildren
        ? renderSegments(yield* expand(element.children)).trim()
        : undefined;
  if (source !== undefined) {
    const parsed = parseTemplate(source);
    if (!parsed.ok) {
      return yield* refuse(element, parsed.error.message);
    }
    template = parsed.value;
  }

  if (!("value" in element.props) && !("value" in element.expressions)) {
    return yield* refuse(element, 'requires a "value" prop.');
  }
  const value = yield* readValue(element);
  if (value.error) {
    return yield* refuse(element, value.error);
  }

  return template ? { template, value: value.parsed } : { value: value.parsed };
}

function* refuse(element: ComponentElement, message: string): Operation<ErrorSegment> {
  return yield* raise(configError(ANSWER, message, element));
}

/**
 * Read `value` in either accepted spelling.
 *
 * Read here rather than where it is consumed, so a malformed one is reported at
 * the matcher that wrote it instead of surfacing later as a provider failure.
 */
function* readValue(element: ComponentElement): Operation<{ parsed: Json; error?: string }> {
  const expression = element.expressions.value;
  if (expression !== undefined) {
    let evaluated: unknown;
    try {
      evaluated = yield* evaluateExpression(expression, ANSWER, "value", element.projectedEnv);
    } catch (error) {
      return { parsed: null, error: error instanceof Error ? error.message : String(error) };
    }
    return read(evaluated);
  }
  const raw = element.props.value;
  if (typeof raw === "string") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      return {
        parsed: null,
        error:
          `value text is not JSON: ${
            error instanceof Error ? error.message : String(error)
          }. A prop string is captured JSON text, so a string answer is written ` +
          `JSON-quoted — value='"approve"' rather than value="approve".`,
      };
    }
    return read(decoded);
  }
  return read(raw);
}

function read(value: unknown): { parsed: Json; error?: string } {
  try {
    return { parsed: parseJson(value) };
  } catch (error) {
    if (error instanceof JsonParseError) {
      return { parsed: null, error: `value must be JSON: ${error.message}` };
    }
    throw error;
  }
}

/**
 * `delegate` as a boolean.
 *
 * A literal `{true}` is resolved by the scanner and arrives already a boolean;
 * only an identifier or member expression reaches `expressions` and needs
 * evaluating here.
 */
function* readDelegate(element: ComponentElement): Operation<{ value: boolean; error?: string }> {
  const expression = element.expressions.delegate;
  if (expression !== undefined) {
    let evaluated: unknown;
    try {
      evaluated = yield* evaluateExpression(expression, ANSWERS, "delegate", element.projectedEnv);
    } catch (error) {
      return { value: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (typeof evaluated !== "boolean") {
      return {
        value: false,
        error: `delegate must be a boolean, and {${expression}} is ${typeof evaluated}.`,
      };
    }
    return { value: evaluated };
  }
  if (!("delegate" in element.props)) {
    return { value: false };
  }
  const raw = element.props.delegate;
  if (typeof raw !== "boolean") {
    return {
      value: false,
      error: `delegate must be a boolean — write delegate={true}, not delegate=${JSON.stringify(
        raw,
      )}.`,
    };
  }
  return { value: raw };
}
