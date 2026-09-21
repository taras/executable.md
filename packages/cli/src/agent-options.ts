/**
 * `xmd agent options` — its fixed grammar and its two renderings
 * (specs/acp-client-spec.md §Command-line configuration).
 *
 * The command asks one agent what model and effort choices it advertises, and
 * prints them. Everything here is pure: the grammar decides what one command
 * line means without reading anything, and the renderers turn the
 * provider-neutral answer into text. What talks to an agent is the command
 * itself, which is what keeps the exact output testable without a live one.
 *
 * The grammar is fixed rather than declared, because the parser this CLI
 * declares its commands with passes an option it does not recognize through to
 * the command. Here that would mean starting an agent — and an unretained
 * conversation in someone's history — for a command line that was already
 * wrong.
 */

import type { AgentOptions, AgentOptionSet } from "@executablemd/core";

/** The one action this command takes, and the options it accepts. */
export const AGENT_ACTION = "options";
export const AGENT_MODEL_OPTION = "--model";
export const AGENT_JSON_OPTION = "--json";

/** What fixed grammar established about one `xmd agent` command line. */
export interface AgentOptionsScan {
  /** The agent to ask, or nothing when the caller named none. */
  agent?: string;
  /** Which model to read effort choices for, when the caller named one. */
  model?: string;
  json: boolean;
  /** Why this command line is refused, before anything is started. */
  error?: string;
}

function refusal(message: string): AgentOptionsScan {
  return { json: false, error: message };
}

/**
 * Read one `xmd agent` command line.
 *
 * `args` is argv with the command name still at the head, exactly as the
 * upgrade scan receives it.
 */
export function scanAgentArgs(args: readonly string[]): AgentOptionsScan {
  const scan: AgentOptionsScan = { json: false };
  const rest = args.slice(1);
  const [action, ...tail] = rest;
  if (action === undefined) {
    return refusal(
      `xmd agent names an action — write \`xmd agent ${AGENT_ACTION} [agent] ` +
        `[${AGENT_MODEL_OPTION} <id>] [${AGENT_JSON_OPTION}]\`.`,
    );
  }
  if (action !== AGENT_ACTION) {
    return refusal(
      `xmd agent does not have a "${action}" action. The one action is ` +
        `\`xmd agent ${AGENT_ACTION}\`.`,
    );
  }

  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index]!;
    if (token.startsWith("-") && token !== "-") {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token : token.slice(0, equals);
      if (name === AGENT_MODEL_OPTION) {
        const value = equals === -1 ? tail[index + 1] : token.slice(equals + 1);
        if (value === undefined || value.length === 0 || (equals === -1 && value.startsWith("-"))) {
          return refusal(
            `${AGENT_MODEL_OPTION} needs a model id — write ` +
              `\`${AGENT_MODEL_OPTION} <id>\` with the exact id the agent advertises.`,
          );
        }
        scan.model = value;
        index += equals === -1 ? 1 : 0;
        continue;
      }
      if (name === AGENT_JSON_OPTION) {
        if (equals !== -1) {
          return refusal(`${AGENT_JSON_OPTION} does not take a value. Use it by itself.`);
        }
        scan.json = true;
        continue;
      }
      return refusal(
        `xmd agent ${AGENT_ACTION} does not recognize ${name}. It accepts one optional agent ` +
          `name and these options: ${AGENT_MODEL_OPTION}, ${AGENT_JSON_OPTION}.`,
      );
    }
    if (scan.agent !== undefined) {
      return refusal(
        `xmd agent ${AGENT_ACTION} accepts at most one agent name. ${token} is an extra argument.`,
      );
    }
    scan.agent = token;
  }
  return scan;
}

/** The version this command's JSON output is written under. */
const JSON_VERSION = 1;

/**
 * The answer as version-1 JSON, with members in their settled order.
 *
 * Built member by member rather than handed the value: key order is part of
 * what this output is, and the order a provider-neutral object happens to carry
 * is not something to inherit.
 */
export function renderAgentOptionsJson(options: AgentOptions): string {
  const set = (advertised: AgentOptionSet | null): unknown =>
    advertised === null
      ? null
      : {
          selected: advertised.selected,
          options: advertised.options.map((option) => ({
            id: option.id,
            name: option.name,
            description: option.description,
            group: option.group === null ? null : { id: option.group.id, name: option.group.name },
          })),
        };
  return `${JSON.stringify(
    {
      version: JSON_VERSION,
      agent: options.agent,
      model: set(options.model),
      effort: set(options.effort),
    },
    null,
    2,
  )}\n`;
}

/** One block of choices, with ids padded to the longest id in that block. */
function block(
  options: readonly { id: string; name: string; description: string | null }[],
  selected: string,
  indent: string,
): string[] {
  const width = options.reduce((longest, option) => Math.max(longest, option.id.length), 0);
  return options.map((option) => {
    const described = option.description === null ? "" : ` — ${option.description}`;
    const marker = option.id === selected ? " (selected)" : "";
    return `${indent}${option.id.padEnd(width)}  ${option.name}${described}${marker}`;
  });
}

/** One advertised set, direct choices and groups in the provider's order. */
function lines(advertised: AgentOptionSet): string[] {
  const rendered: string[] = [];
  let index = 0;
  while (index < advertised.options.length) {
    const option = advertised.options[index]!;
    if (option.group === null) {
      const direct: (typeof advertised.options)[number][] = [];
      while (index < advertised.options.length && advertised.options[index]!.group === null) {
        direct.push(advertised.options[index]!);
        index += 1;
      }
      rendered.push(...block(direct, advertised.selected, "  "));
      continue;
    }
    const group = option.group;
    const members: (typeof advertised.options)[number][] = [];
    while (index < advertised.options.length && advertised.options[index]!.group?.id === group.id) {
      members.push(advertised.options[index]!);
      index += 1;
    }
    rendered.push(`  Group ${group.id}  ${group.name}`);
    rendered.push(...block(members, advertised.selected, "    "));
  }
  return rendered;
}

/**
 * The answer as a person reads it.
 *
 * Exact ids first, then the display name, then whatever the provider said about
 * a choice — because the id is what a `<Session>` writes and everything else is
 * there to help choose it.
 */
export function renderAgentOptions(options: AgentOptions): string {
  const sections: string[][] = [[`Agent: ${options.agent}`]];
  if (options.model !== null) {
    sections[0]!.push(`Selected model: ${options.model.selected}`);
    sections.push(["Models", ...lines(options.model)]);
  } else {
    sections.push([`Model choices are unavailable for ${options.agent}.`]);
  }
  if (options.effort !== null) {
    const heading =
      options.model === null
        ? "Effort levels for the current model"
        : `Effort levels for ${options.model.selected}`;
    sections.push([heading, ...lines(options.effort)]);
  } else {
    sections.push([
      options.model === null
        ? "Effort choices are unavailable for the current model."
        : `Effort choices are unavailable for model "${options.model.selected}".`,
    ]);
  }
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}
