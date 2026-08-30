/**
 * `xmd prompt` argument grammar — everything decidable before a document exists
 * (specs/prompt-command-spec.md).
 *
 * A pure function over argv. It reads no Context Apis, contacts no agent, and
 * inspects nothing on disk, which is what lets the command refuse a malformed
 * command line before it builds a catalog, opens a session, asks a person, or
 * writes a file.
 *
 * The command line is read in two stages because only the first one is fixed.
 * The request, the built-in options and the end-of-options separator are known
 * from the grammar alone; whether `--props-name` takes a following token depends
 * on what the *generated* document declares, and no document exists yet. So this
 * stage classifies what it can, records each generated occurrence with the token
 * it provisionally read, and leaves the rest to the candidate that supplies the
 * schema.
 */

import { AGGREGATE_OPTION } from "./props.ts";
import type { Binding } from "./props.ts";

export const PROMPT_COMMAND = "prompt";
export const SAVE_OPTION = "--save";
export const SESSION_OPTION = "--session";

/** The built-in options that take a separated value. */
const VALUE_OPTIONS: readonly string[] = [
  "--include",
  "--journal",
  "-j",
  "--agent-provider",
  "--default-agent",
  "--timeout",
  "--timeout-exec",
  "--timeout-fetch",
  SAVE_OPTION,
  SESSION_OPTION,
];

/** The built-in options that take none. */
const SWITCH_OPTIONS: readonly string[] = [
  "--verbose",
  "-V",
  "--raw",
  "--approve-all",
  "--approve-reads",
  "--deny-all",
  "--secret-detection",
  "--no-secret-detection",
  "--help",
  "-h",
  "--version",
];

const VALUE = new Set(VALUE_OPTIONS);
const KNOWN = new Set([...VALUE_OPTIONS, ...SWITCH_OPTIONS, AGGREGATE_OPTION]);

function optionName(token: string): string {
  const equals = token.indexOf("=");
  return equals === -1 ? token : token.slice(0, equals);
}

function generatesProperty(name: string): boolean {
  return name.startsWith("--props-") || name.startsWith("--no-props");
}

/**
 * Whether this token is an option `xmd` itself defines.
 *
 * Used to decide what a generated property option may provisionally read as its
 * value. A caller writing `--props-name --raw` means the switch, not a value of
 * `--raw`; a value that really begins with `-` is written `--props-name=-value`.
 */
function isKnownOption(token: string): boolean {
  if (!token.startsWith("-") || token === "-") {
    return false;
  }
  const name = optionName(token);
  return KNOWN.has(name) || generatesProperty(name);
}

/** One `--props-*` token, as written. */
export interface PropertyOccurrence {
  /** The option name, without any `=value`. */
  option: string;
  /** The value written with `=`, when it was written that way. */
  inline?: string;
  /**
   * The following token this scan read as the option's value.
   *
   * Provisional: whether the option takes one is the candidate's answer, and a
   * candidate that declares it a switch turns this token into a second request.
   */
  provisional?: string;
}

/** What fixed grammar establishes about one `xmd prompt` command line. */
export interface PromptScan {
  /** The request, byte for byte, when exactly one was written. */
  request?: string;
  /**
   * The argv the built-in option parser sees.
   *
   * Generated property tokens and the aggregate `--props` are removed: the
   * parser defines neither, and it coerces a separated value through `Number()`
   * before any schema could judge it. Tokens after `--` are left out for the
   * same reason the workflow command leaves them out — a dash-leading positional
   * handed back to a parser is read as an option again.
   */
  fixed: string[];
  /** Every generated property occurrence, in the order it was written. */
  occurrences: PropertyOccurrence[];
  /** Why fixed grammar refuses this command line. */
  error?: string;
}

/** Whether these arguments select the `prompt` command. */
export function namesPrompt(args: readonly string[]): boolean {
  return args[0] === PROMPT_COMMAND;
}

const ORDER_HELP =
  "document properties follow the request, as in " +
  '`xmd prompt "<request>" --props-name <value>`';

export function scanPromptArgs(args: readonly string[]): PromptScan {
  const fixed: string[] = [PROMPT_COMMAND];
  const occurrences: PropertyOccurrence[] = [];
  let request: string | undefined;
  let extra: string | undefined;
  let parsingOptions = true;
  let index = 1;

  while (index < args.length) {
    const token = args[index];

    if (parsingOptions && token === "--") {
      parsingOptions = false;
      index += 1;
      continue;
    }

    if (parsingOptions && token.startsWith("-") && token !== "-") {
      const equals = token.indexOf("=");
      const name = optionName(token);

      if (name === AGGREGATE_OPTION) {
        index += equals === -1 && args[index + 1] !== undefined ? 2 : 1;
        continue;
      }

      if (generatesProperty(name)) {
        if (request === undefined) {
          return {
            fixed,
            occurrences,
            error: `unrecognized option: ${name} — ${ORDER_HELP}`,
          };
        }
        if (equals !== -1) {
          occurrences.push({ option: name, inline: token.slice(equals + 1) });
          index += 1;
          continue;
        }
        const next = args[index + 1];
        if (next === undefined || next === "--" || isKnownOption(next)) {
          occurrences.push({ option: name });
          index += 1;
          continue;
        }
        occurrences.push({ option: name, provisional: next });
        index += 2;
        continue;
      }

      const separated =
        equals === -1 && VALUE.has(name) && args[index + 1] !== undefined
          ? args[index + 1]
          : undefined;
      // Read here rather than after parsing, because an empty value is exactly
      // what the parser cannot report: an option it reads as absent falls back
      // to the default, so a caller who asked for a session and named none would
      // silently get the generated one instead.
      if (name === SESSION_OPTION) {
        const value = equals === -1 ? separated : token.slice(equals + 1);
        if (value === undefined || value.length === 0) {
          return {
            ...(request === undefined ? {} : { request }),
            fixed,
            occurrences,
            error:
              `${SESSION_OPTION} needs a name — write \`${SESSION_OPTION} <name>\` or leave ` +
              "it out for a session unique to this invocation",
          };
        }
      }
      fixed.push(token);
      if (separated !== undefined) {
        fixed.push(separated);
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (request === undefined) {
      request = token;
      // Kept out of the parser's argv when the separator carried it: a
      // dash-leading request written after `--` is positional because of where
      // it is, and handing it back would make it an option again.
      if (parsingOptions) {
        fixed.push(token);
      }
    } else if (extra === undefined) {
      extra = token;
    }
    index += 1;
  }

  if (extra !== undefined) {
    return {
      ...(request === undefined ? {} : { request }),
      fixed,
      occurrences,
      error:
        `unrecognized argument for xmd prompt: ${extra} — the command takes exactly one ` +
        "request, and " +
        ORDER_HELP,
    };
  }

  if (request === undefined) {
    return {
      fixed,
      occurrences,
      error: 'xmd prompt requires one request — `xmd prompt "<what you want>"`',
    };
  }

  if (request.trim().length === 0) {
    return {
      request,
      fixed,
      occurrences,
      error: "xmd prompt requires a request with at least one non-whitespace character",
    };
  }

  return { request, fixed, occurrences };
}

/**
 * How a supplied individual option is written: whether it takes a token, and
 * whether repeating it accumulates.
 *
 * This is what a later candidate may not change. The comparison happens before
 * any token is extracted, so a switch that became a value option cannot reach
 * forward and consume the `--raw` written after it.
 */
export interface OptionSignature {
  boolean: boolean;
  array: boolean;
}

export function signatureOf(binding: Binding): OptionSignature {
  return { boolean: binding.boolean, array: binding.array };
}

function describeSignature(signature: OptionSignature): string {
  if (signature.boolean) {
    return "a bare switch";
  }
  return signature.array ? "a repeated value option" : "a single-value option";
}

/**
 * Whether the candidate still declares every supplied option the way the
 * candidate that first bound it did.
 *
 * A removed option or a changed shape is the caller's command line meaning
 * something else than it did, which no revision may do silently.
 */
export function signatureFailure(
  frozen: ReadonlyMap<string, OptionSignature>,
  bindings: readonly Binding[],
): string | undefined {
  const current = new Map(bindings.map((binding) => [binding.option, signatureOf(binding)]));
  for (const [option, signature] of frozen) {
    const now = current.get(option);
    if (now === undefined) {
      return (
        `${option} was accepted by an earlier draft and this one declares no such property — ` +
        "the command line no longer describes the document under review"
      );
    }
    if (now.boolean !== signature.boolean || now.array !== signature.array) {
      return (
        `${option} was ${describeSignature(signature)} in an earlier draft and is ` +
        `${describeSignature(now)} in this one — the command line no longer describes the ` +
        "document under review"
      );
    }
  }
  return undefined;
}

/**
 * The token a candidate's own arity turns into a second request.
 *
 * `--props-loud true` reads as an option and a value until a candidate declares
 * `loud` a boolean; from then on `true` is a positional, and the command takes
 * exactly one.
 */
export function strayPropertyValue(
  occurrences: readonly PropertyOccurrence[],
  bindings: readonly Binding[],
): string | undefined {
  const byOption = new Map(bindings.map((binding) => [binding.option, binding]));
  for (const occurrence of occurrences) {
    const { provisional } = occurrence;
    if (provisional === undefined) {
      continue;
    }
    const binding = byOption.get(occurrence.option);
    if (binding?.boolean === true) {
      return (
        `unrecognized argument for xmd prompt: ${provisional} — ${occurrence.option} is a ` +
        `switch, so this is a second request; write \`${occurrence.option}=${provisional}\` ` +
        "to give it a value"
      );
    }
  }
  return undefined;
}

/**
 * Whether this token is an option the invocation owns, and therefore one a
 * generated property may not read as its value.
 */
export function isReservedOption(token: string): boolean {
  return isKnownOption(token);
}
