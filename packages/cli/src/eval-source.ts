/**
 * `--eval, -e` — the inline root document, read from argv.
 *
 * Read here rather than from the resolved configuration, for the same reason
 * `--props` is: configliere coerces every separated option value through
 * `Number()` and falls back to the field default when the coerced value fails
 * validation, so `-e '42'` — a perfectly good document — would become the
 * number `42` and then disappear. The tokens are lifted out of argv entirely,
 * which also keeps the document's text away from every other scanner: argv
 * tokens are whole strings, so a one-token document reading `-h` or `--props`
 * would otherwise be taken for the option it resembles.
 *
 * The value is whatever token follows, verbatim. A markdown document routinely
 * begins with `-` — a bullet list, a thematic break — so the leading-dash rule
 * `--pattern` uses would reject the most ordinary inline document there is.
 * Running out of argv is the only missing value.
 */

export const EVAL_OPTION = "--eval";
export const EVAL_ALIAS = "-e";

export interface EvalFlags {
  /** Documents supplied, in the order they were written. */
  values: string[];
  /** argv with the option and its values removed. */
  rest: string[];
  /** How many times the option appeared, however it was written. */
  occurrences: number;
  /** The option ran out of argv. */
  missingValue: boolean;
  /** `-e -`, the reserved stdin form. */
  stdin: boolean;
  /** `-e=…`, which the alias has no inline form for. */
  aliasEquals: boolean;
}

export function readEvalFlags(args: string[]): EvalFlags {
  const values: string[] = [];
  const rest: string[] = [];
  let occurrences = 0;
  let missingValue = false;
  let stdin = false;
  let aliasEquals = false;
  let index = 0;

  while (index < args.length) {
    const token = args[index];

    if (token === "--") {
      rest.push(...args.slice(index));
      break;
    }

    if (token === EVAL_OPTION || token === EVAL_ALIAS) {
      occurrences += 1;
      const value = args[index + 1];
      if (value === undefined) {
        missingValue = true;
        index += 1;
        continue;
      }
      if (value === "-") {
        stdin = true;
      } else {
        values.push(value);
      }
      index += 2;
      continue;
    }

    if (token.startsWith(`${EVAL_OPTION}=`)) {
      occurrences += 1;
      const value = token.slice(EVAL_OPTION.length + 1);
      if (value === "-") {
        stdin = true;
      } else {
        values.push(value);
      }
      index += 1;
      continue;
    }

    if (token.startsWith(`${EVAL_ALIAS}=`)) {
      occurrences += 1;
      aliasEquals = true;
      index += 1;
      continue;
    }

    rest.push(token);
    index += 1;
  }

  return { values, rest, occurrences, missingValue, stdin, aliasEquals };
}

/** What is wrong with how the option was written, if anything. */
export function evalGrammarError(flags: EvalFlags): string | undefined {
  if (flags.aliasEquals) {
    return `${EVAL_ALIAS} takes a separate value — write \`${EVAL_ALIAS} <markdown>\` or \`${EVAL_OPTION}=<markdown>\``;
  }
  if (flags.missingValue) {
    return `${EVAL_OPTION} requires a markdown document — write \`${EVAL_ALIAS} '<markdown>'\``;
  }
  if (flags.stdin) {
    return `${EVAL_OPTION} does not read from stdin — pass the document as the value`;
  }
  if (flags.occurrences > 1) {
    return `${EVAL_OPTION} was given more than once — a run has exactly one root document`;
  }
  return undefined;
}
