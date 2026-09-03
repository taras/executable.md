/**
 * `xmd plan` argument grammar — everything decidable before a document exists
 * (specs/plan-command-spec.md).
 *
 * A pure function over argv. It reads no Context Apis, contacts no agent, and
 * inspects nothing on disk, which is what lets the command refuse a malformed
 * command line before it builds a catalog, opens a session, asks a person, or
 * writes a file.
 *
 * The grammar is fixed and complete, because the command produces source rather
 * than running it: there is no generated document whose declarations could add
 * an option. Every option this command does not define is refused here, by
 * name, before the general parser can drop it, coerce its value, or read it as
 * a second positional.
 */

export const PLAN_COMMAND = "plan";

/**
 * The spelling this command had before it was named for its result.
 *
 * Refused rather than left to the default `run` grammar, which reads a first
 * token naming no command as a document reference. A file called `prompt` in
 * the working directory would otherwise be rendered and executed by a token
 * nobody wrote as a path — an effect from a spelling that is supposed to do
 * nothing at all. It is not a command: nothing registers, aliases or lists it,
 * and the refusal builds no profile and reads no document.
 */
export const RETIRED_COMMAND = "prompt";

/** Whether these arguments lead with the retired spelling, exactly. */
export function namesRetiredCommand(args: readonly string[]): boolean {
  return args[0] === RETIRED_COMMAND;
}

/**
 * What a caller who wrote the retired spelling is told.
 *
 * Both readings are answered, because the token is ambiguous by construction:
 * whoever meant the command is sent to `xmd plan`, and whoever really does have
 * a document of that name is shown the spelling that still runs it.
 */
export const RETIRED_COMMAND_REFUSAL: string =
  `xmd ${RETIRED_COMMAND} is not a command — use \`xmd ${PLAN_COMMAND} "<Prompt>"\` to create ` +
  `a Plan, or \`xmd run ./${RETIRED_COMMAND}\` to run a document named \`${RETIRED_COMMAND}\``;

/** The aggregate root-property option, and the stem the generated ones share. */
const AGGREGATE_OPTION = "--props";

export const OUTPUT_OPTION = "--output";
export const SESSION_OPTION = "--session";
export const VERBOSE_OPTION = "--verbose";
export const JOURNAL_OPTION = "--journal";

/** The switch that used to run the approved Plan, and now names its migration. */
const RUN_OPTION = "--run";

/**
 * What every `--run` spelling is answered with.
 *
 * The option is gone rather than inert, so the message says what replaced it:
 * planning writes source, and a caller who wants that source to run composes
 * the two commands themselves. Both compositions are shown, because the choice
 * between them is whether the artifact is kept.
 */
export const RUN_REMOVAL_REFUSAL: string = [
  "xmd plan --run was removed because xmd plan only produces approved source.",
  "Run the program explicitly:",
  '  xmd plan "..." | xmd run -',
  '  xmd plan "..." --output release.md && xmd run release.md',
].join("\n");

/** What every other removed option is answered with. */
export function removedOptionRefusal(option: string): string {
  return (
    `unrecognized option for xmd plan: ${option} — configure the program when you run ` +
    "the approved source with xmd run"
  );
}

/**
 * The short spellings the two authorship options deliberately do not have.
 *
 * They are `xmd run`'s aliases for options that configure a program's run. The
 * long spellings here describe writing a Plan and observe no later run, so a
 * caller reaching for the short one is answered with the long one rather than
 * with the generic removal — which would send them to `xmd run` for an option
 * this command does define.
 */
const SHORT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["-V", VERBOSE_OPTION],
  ["-j", `${JOURNAL_OPTION} <path>`],
]);

/** What a short alias of a retained authorship option is answered with. */
export function shortAliasRefusal(option: string): string {
  return `unrecognized option for xmd plan: ${option} — write \`${SHORT_ALIASES.get(option)}\``;
}

/** The options that take a separated value. */
const VALUE_OPTIONS: readonly string[] = [
  "--include",
  "--agent-provider",
  "--default-agent",
  "--timeout",
  OUTPUT_OPTION,
  SESSION_OPTION,
  JOURNAL_OPTION,
];

/** The options that take none. */
const SWITCH_OPTIONS: readonly string[] = ["--help", "-h", "--version", VERBOSE_OPTION];

/**
 * The options that configured running the approved Plan, and now configure
 * nothing.
 *
 * `xmd plan` produces source and stops, so each of these describes work this
 * command never performs. Accepting one silently would mean answering a caller
 * who asked for a permission mode or an exec deadline with a command that
 * creates none of them; `xmd run` still defines every one of them, and the
 * refusal says so.
 *
 * The generated `--props-*` and `--no-props-*` names, and the aggregate
 * `--props`, are refused by prefix rather than by list: they bind the root
 * properties of a program, and the program a Plan describes is run later.
 */
const REMOVED_OPTIONS: readonly string[] = [
  "--raw",
  "--timeout-exec",
  "--timeout-fetch",
  "--approve-all",
  "--approve-reads",
  "--deny-all",
  "--secret-detection",
  "--no-secret-detection",
];

const REMOVED = new Set(REMOVED_OPTIONS);
const VALUE = new Set(VALUE_OPTIONS);
const KNOWN = new Set([...VALUE_OPTIONS, ...SWITCH_OPTIONS]);

function optionName(token: string): string {
  const equals = token.indexOf("=");
  return equals === -1 ? token : token.slice(0, equals);
}

/**
 * Whether this name binds a root property of the program a Plan describes.
 *
 * Exactly the aggregate and the two generated prefixes. `--propspective`,
 * `--no-propspective` and a bare `--no-props` are options this command does not
 * define, and an option nobody defines is answered as one: telling a caller to
 * configure their program with `xmd run` would be answering a question they did
 * not ask.
 */
function generatesProperty(name: string): boolean {
  return (
    name === AGGREGATE_OPTION ||
    name.startsWith(`${AGGREGATE_OPTION}-`) ||
    name.startsWith("--no-props-")
  );
}

/**
 * What a removed option is answered with, or `undefined` when this name is not
 * one.
 *
 * The name is read up to its first `=`, so every valued spelling arrives under
 * the name of the option it was written as: `--run=false` is a `--run`, and a
 * removed option that appears to take a value never consumes the token after
 * it.
 */
function removalRefusal(name: string): string | undefined {
  if (name === RUN_OPTION) {
    return RUN_REMOVAL_REFUSAL;
  }
  if (SHORT_ALIASES.has(name)) {
    return shortAliasRefusal(name);
  }
  if (REMOVED.has(name) || generatesProperty(name)) {
    return removedOptionRefusal(name);
  }
  return undefined;
}

/** The removal this token names, wherever it stands on the command line. */
function tokenRemoval(token: string): string | undefined {
  if (!token.startsWith("-") || token === "-") {
    return undefined;
  }
  return removalRefusal(optionName(token));
}

/**
 * The refusal a Plan command line earns for naming a removed option, or
 * `undefined` when it names none.
 *
 * Separate from {@link scanPlanArgs} because it has to be askable earlier than
 * a scan is useful. `--help` short-circuits the general dispatch before any
 * command's own grammar runs, so `xmd plan --help --run` would otherwise be
 * answered with a page describing a command that would refuse it. The two share
 * this classification rather than each keeping their own, so a spelling cannot
 * become removed in one and unknown in the other.
 *
 * Tokens after `--` are positional and are not inspected, exactly as the scan
 * leaves them.
 */
export function removedPlanOption(args: readonly string[]): string | undefined {
  for (const token of args.slice(1)) {
    if (token === "--") {
      return undefined;
    }
    const removal = tokenRemoval(token);
    if (removal !== undefined) {
      return removal;
    }
  }
  return undefined;
}

/** What fixed grammar establishes about one `xmd plan` command line. */
export interface PlanScan {
  /** The request, byte for byte, when exactly one was written. */
  request?: string;
  /**
   * The argv the built-in option parser sees.
   *
   * Tokens after `--` are left out for the same reason the workflow command
   * leaves them out — a dash-leading positional handed back to a parser is read
   * as an option again.
   */
  fixed: string[];
  /** Why fixed grammar refuses this command line. */
  error?: string;
}

/** Whether these arguments select the `plan` command. */
export function namesPlan(args: readonly string[]): boolean {
  return args[0] === PLAN_COMMAND;
}

export function scanPlanArgs(args: readonly string[]): PlanScan {
  const fixed: string[] = [PLAN_COMMAND];
  let request: string | undefined;
  let extra: string | undefined;
  let parsingOptions = true;
  let index = 1;

  const refuse = (error: string): PlanScan => ({
    ...(request === undefined ? {} : { request }),
    fixed,
    error,
  });

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

      const removed = removalRefusal(name);
      if (removed !== undefined) {
        return refuse(removed);
      }

      if (!KNOWN.has(name)) {
        // The parser stops at the first option it does not define and drops the
        // rest, so an option nobody defines would otherwise be accepted in
        // silence — and a caller who asked for something the command never did
        // has not been answered. `--save` is named because it is the one
        // spelling somebody may remember; it was replaced before release, so
        // there is no alias to keep.
        return refuse(
          name === "--save"
            ? `unrecognized option for xmd plan: --save — the approved Plan goes to stdout, ` +
                `and ${OUTPUT_OPTION} writes it to a file`
            : `unrecognized option for xmd plan: ${name}`,
        );
      }

      const next = args[index + 1];
      const separated = equals === -1 && VALUE.has(name) && next !== undefined ? next : undefined;
      if (separated !== undefined) {
        // A removed option is refused where it stands, including where a
        // retained option would otherwise swallow it: `--include --run` names
        // a directory nobody has, and reading it as one is how a removed
        // spelling survives.
        const swallowed = tokenRemoval(separated);
        if (swallowed !== undefined) {
          return refuse(swallowed);
        }
      }
      // Read here rather than after parsing, because an empty value is exactly
      // what the parser cannot report: an option it reads as absent falls back
      // to the default, so a caller who asked for a session and named none would
      // silently get the generated one instead.
      if (name === SESSION_OPTION) {
        const value = equals === -1 ? separated : token.slice(equals + 1);
        if (value === undefined || value.length === 0) {
          return refuse(
            `${SESSION_OPTION} needs a name — write \`${SESSION_OPTION} <name>\` or leave ` +
              "it out for a session unique to this invocation",
          );
        }
      }
      if (name === JOURNAL_OPTION) {
        const value = equals === -1 ? separated : token.slice(equals + 1);
        if (value === undefined || value.length === 0) {
          return refuse(
            `${JOURNAL_OPTION} needs a path — write \`${JOURNAL_OPTION} <path>\` or leave ` +
              "it out to record no journal",
          );
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
    return refuse(
      `unrecognized argument for xmd plan: ${extra} — the command takes exactly one request`,
    );
  }

  if (request === undefined) {
    return refuse('xmd plan requires one request — `xmd plan "<what you want>"`');
  }

  if (request.trim().length === 0) {
    return refuse("xmd plan requires a request with at least one non-whitespace character");
  }

  return { request, fixed };
}
