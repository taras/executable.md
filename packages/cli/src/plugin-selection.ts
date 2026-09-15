/**
 * `--plugin` — the one grammar that selects trusted code, read straight from
 * argv.
 *
 * It runs before every other scanner for the same reason the eval scan does:
 * whatever a command line turns out to mean, the Plugins it selects are
 * installed before anything reads a document, and a selection the props phase
 * had already rewritten would be a selection made from somebody else's view of
 * the command line.
 *
 * What it produces is deliberately small: the specifiers in the order they were
 * written, the argv with exactly those tokens removed, a frozen copy of the
 * argv as the caller wrote it, and the normalized top-level command. Nothing
 * here loads, resolves or evaluates anything.
 */

const PLUGIN_OPTION = "--plugin";
const PLUGIN_ASSIGNMENT = `${PLUGIN_OPTION}=`;

/** The public top-level commands a Plugin is told about, by their own names. */
const COMMANDS: ReadonlySet<string> = new Set([
  "run",
  "plan",
  "test",
  "syntax",
  "upgrade",
  "workflow",
]);

/**
 * The internal worker mode, which activates no operator Plugin.
 *
 * It is not a public command: nothing a caller writes as a document runs in it,
 * and a Plugin installed there would compose around a controller's own
 * protocol rather than around anybody's document.
 */
const WORKER_COMMAND = "test-agent";

/** What one invocation selected, before anything has been loaded. */
export interface PluginSelection {
  /** The specifiers the caller wrote, in the order they wrote them. */
  readonly specifiers: readonly string[];
  /** argv with the `--plugin` tokens removed, for every existing scanner. */
  readonly rest: string[];
  /** The original argv, frozen, as every install request carries it. */
  readonly args: readonly string[];
  /** The normalized public command; the shorthand document form is `run`. */
  readonly command: string;
  /**
   * Whether this invocation installs Plugins at all.
   *
   * Help, `--version` and the internal worker mode describe or serve a grammar
   * rather than running a document, so none of them loads a module.
   */
  readonly loads: boolean;
  /** Why the command line names no usable selection, when it names none. */
  readonly error?: string;
}

/** What a `--plugin` written with no value is answered with. */
function missingValue(): string {
  return `${PLUGIN_OPTION} names a module to load — write \`${PLUGIN_OPTION} <specifier>\` or \`${PLUGIN_ASSIGNMENT}<specifier>\``;
}

/** What a value that reads as another option is answered with. */
function optionShapedValue(value: string): string {
  return (
    `${PLUGIN_OPTION} read ${value} as its value, and a value beginning with \`-\` is written ` +
    `\`${PLUGIN_ASSIGNMENT}${value}\``
  );
}

/**
 * The command this argv names, normalized.
 *
 * The first token, exactly as `workflow` and `plan` are recognized. A first
 * token naming no command is a document reference to the default `run`
 * command, which is what makes the shorthand form report `run`.
 */
function commandOf(args: readonly string[]): string {
  const [first] = args;
  if (first === undefined) {
    return "run";
  }
  if (first === WORKER_COMMAND) {
    return WORKER_COMMAND;
  }
  return COMMANDS.has(first) ? first : "run";
}

/** Whether this argv asks for help or the version rather than for a command. */
function describes(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    // `-v` is the version alias and `-V` is `--verbose`; only the first of
    // them describes the program rather than configuring a run.
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v") {
      return true;
    }
  }
  return false;
}

/**
 * Read `--plugin` out of one command line.
 *
 * The scan stops at `--`: every token after the separator keeps the meaning it
 * already had, so a document reference or a request that happens to read like
 * this option is left where the caller put it.
 */
export function selectPlugins(args: readonly string[]): PluginSelection {
  const original = Object.freeze([...args]);
  const specifiers: string[] = [];
  const rest: string[] = [];
  let error: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (arg === PLUGIN_OPTION) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        error ??= missingValue();
        break;
      }
      if (value.startsWith("-")) {
        error ??= optionShapedValue(value);
        break;
      }
      specifiers.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith(PLUGIN_ASSIGNMENT)) {
      const value = arg.slice(PLUGIN_ASSIGNMENT.length);
      if (value.length === 0) {
        error ??= missingValue();
        break;
      }
      specifiers.push(value);
      continue;
    }
    rest.push(arg);
  }

  const command = commandOf(rest);
  return {
    specifiers,
    rest,
    args: original,
    command,
    loads: !describes(original) && command !== WORKER_COMMAND,
    ...(error === undefined ? {} : { error }),
  };
}
