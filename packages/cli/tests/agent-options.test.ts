/**
 * Tier AG — `xmd agent options`, as grammar and as output (issue #828).
 *
 * Both halves are pure, and both are exact. The grammar decides what a command
 * line means before anything is started, because the alternative is creating a
 * conversation in someone's history for a command line that was already wrong.
 * The renderings are what a person and a program read, and the ids in them are
 * what a `<Session>` writes — so they are asserted byte for byte rather than by
 * substring.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { AgentOptions } from "@executablemd/core";
import { renderAgentOptions, renderAgentOptionsJson, scanAgentArgs } from "../src/agent-options.ts";

/** One command line, as the dispatcher passes it: the command still at head. */
function scan(...args: string[]): ReturnType<typeof scanAgentArgs> {
  return scanAgentArgs(["agent", ...args]);
}

const GROUPED: AgentOptions = {
  agent: "codex",
  model: {
    selected: "gpt-5.4",
    options: [
      { id: "gpt-5.4", name: "GPT-5.4", description: null, group: null },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", description: null, group: null },
      {
        id: "o5-preview",
        name: "O5 Preview",
        description: "slow and thorough",
        group: { id: "reasoning", name: "Reasoning" },
      },
    ],
  },
  effort: {
    selected: "medium",
    options: [
      { id: "low", name: "Low", description: null, group: null },
      { id: "medium", name: "Medium", description: null, group: null },
      { id: "high", name: "High", description: null, group: null },
    ],
  },
};

describe("Tier AG — the agent-options grammar", () => {
  it("AG1: the accepted forms read as themselves", function* () {
    expect(scan("options")).toEqual({ json: false });
    expect(scan("options", "codex")).toEqual({ json: false, agent: "codex" });
    expect(scan("options", "codex", "--model", "gpt-5.4")).toEqual({
      json: false,
      agent: "codex",
      model: "gpt-5.4",
    });
    expect(scan("options", "codex", "--model=gpt-5.4", "--json")).toEqual({
      json: true,
      agent: "codex",
      model: "gpt-5.4",
    });
    // Order is not part of the grammar: the option may precede the agent.
    expect(scan("options", "--json", "codex")).toEqual({ json: true, agent: "codex" });
  });

  it("AG2: everything else is refused, and says what is accepted", function* () {
    const refusals: [string, string[], string][] = [
      ["no action", [], "xmd agent names an action"],
      ["another action", ["list"], 'does not have a "list" action'],
      ["a second agent", ["options", "codex", "claude"], "at most one agent name"],
      ["an unknown option", ["options", "--effort", "high"], "does not recognize --effort"],
      ["a model with no value", ["options", "--model"], "needs a model id"],
      ["a model with an empty value", ["options", "--model="], "needs a model id"],
      ["a model swallowing an option", ["options", "--model", "--json"], "needs a model id"],
      ["a value on --json", ["options", "--json=true"], "does not take a value"],
    ];
    for (const [shape, args, message] of refusals) {
      const refused = scan(...args);
      expect([shape, refused.error !== undefined]).toEqual([shape, true]);
      expect([shape, refused.error?.includes(message)]).toEqual([shape, true]);
    }
  });
});

describe("Tier AG — what the command prints", () => {
  it("AG3: a person reads ids first, in the provider's own order", function* () {
    expect(renderAgentOptions(GROUPED)).toBe(
      [
        "Agent: codex",
        "Selected model: gpt-5.4",
        "",
        "Models",
        "  gpt-5.4       GPT-5.4 (selected)",
        "  gpt-5.4-mini  GPT-5.4 Mini",
        "  Group reasoning  Reasoning",
        "    o5-preview  O5 Preview — slow and thorough",
        "",
        "Effort levels for gpt-5.4",
        "  low     Low",
        "  medium  Medium (selected)",
        "  high    High",
        "",
      ].join("\n"),
    );
  });

  it("AG4: absent choices say so rather than printing an empty list", function* () {
    expect(renderAgentOptions({ agent: "codex", model: null, effort: null })).toBe(
      [
        "Agent: codex",
        "",
        "Model choices are unavailable for codex.",
        "",
        "Effort choices are unavailable for the current model.",
        "",
      ].join("\n"),
    );
    expect(renderAgentOptions({ ...GROUPED, effort: null })).toContain(
      'Effort choices are unavailable for model "gpt-5.4".',
    );
  });

  it("AG5: the JSON is version 1, in its settled order, with null for absence", function* () {
    const json = renderAgentOptionsJson({ ...GROUPED, effort: null });
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toEqual({
      version: 1,
      agent: "codex",
      model: {
        selected: "gpt-5.4",
        options: [
          { id: "gpt-5.4", name: "GPT-5.4", description: null, group: null },
          { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", description: null, group: null },
          {
            id: "o5-preview",
            name: "O5 Preview",
            description: "slow and thorough",
            group: { id: "reasoning", name: "Reasoning" },
          },
        ],
      },
      effort: null,
    });
    // Key order is part of this output, not an accident of the object it came
    // from: a reader diffing two runs reads the same document twice.
    expect(Object.keys(JSON.parse(json))).toEqual(["version", "agent", "model", "effort"]);
    expect(json.indexOf('"version"')).toBeLessThan(json.indexOf('"agent"'));
    expect(json.indexOf('"model"')).toBeLessThan(json.indexOf('"effort"'));
  });

  it("AG6: neither rendering carries a path, a session identity or a credential", function* () {
    const rendered = `${renderAgentOptions(GROUPED)}${renderAgentOptionsJson(GROUPED)}`;
    for (const private_ of ["/", "xmd:v1:", "xmd:inspect:", "token", "acpxRecordId"]) {
      expect([private_, rendered.includes(private_)]).toEqual([private_, false]);
    }
  });
});
