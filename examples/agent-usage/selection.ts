import { isAbsolute } from "node:path";

/** One selected calibration experiment. */
export interface Selection {
  readonly host: "source" | "compiled";
  readonly agent: "claude" | "codex";
  readonly scenario: Scenario;
  readonly output: string;
  /** The exact executable a compiled selection measures. */
  readonly xmd?: string;
}

export type Scenario = "success" | "resume" | "failure" | "cancel" | "subagent";

/** What the command line asked for, before anything is created or started. */
export type Parsed =
  | { readonly kind: "help" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "selected"; readonly selection: Selection };

export const HELP = `Measure one bundled Agent through one production XMD host. Select exactly one scenario. This run may spend tokens; --allow-paid is required. The output directory must be new. Missing measurements remain unknown.

  --host=source|compiled
  --agent=claude|codex
  --scenario=success|resume|failure|cancel|subagent
  --output=<new private directory>
  --xmd=<absolute executable path>   required only for compiled
  --allow-paid                       required for any live scenario
  --help                             prints help and starts no Agent
`;

export const Refusal = Object.freeze({
  paid: "Calibration requires --allow-paid; no Agent was started.",
  compiled: "--host=compiled requires --xmd with an absolute executable path to measure.",
  unsupported:
    "Unsupported calibration selection. Choose a documented host, bundled Agent and scenario; see --help.",
  cleanup:
    "Calibration stopped because owned cleanup did not complete successfully. No later work was started.",
  exists: (path: string) =>
    `Calibration output already exists: ${path}. Choose a new --output directory.`,
});

/** The maximum outer Prompts each scenario may submit. */
export const ALLOWANCE: Readonly<Record<Scenario, number>> = Object.freeze({
  success: 2,
  resume: 2,
  failure: 1,
  cancel: 1,
  subagent: 1,
});

const HOSTS = ["source", "compiled"] as const;
const AGENTS = ["claude", "codex"] as const;
const SCENARIOS = ["success", "resume", "failure", "cancel", "subagent"] as const;
const VALUED = ["host", "agent", "scenario", "output", "xmd"] as const;

function member<T extends string>(values: readonly T[], value: string | undefined): T | undefined {
  return values.find((candidate) => candidate === value);
}

/** Read the grammar. Every refusal happens here, before any output or provider work. */
export function parseSelection(args: readonly string[]): Parsed {
  if (args.includes("--help")) {
    return { kind: "help" };
  }
  const values = new Map<string, string>();
  let paid = false;
  for (const arg of args) {
    if (arg === "--allow-paid") {
      if (paid) {
        return { kind: "refused", message: Refusal.unsupported };
      }
      paid = true;
      continue;
    }
    const match = /^--([a-z]+)=(.*)$/u.exec(arg);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined || value.length === 0) {
      return { kind: "refused", message: Refusal.unsupported };
    }
    if (member(VALUED, name) === undefined || values.has(name)) {
      return { kind: "refused", message: Refusal.unsupported };
    }
    values.set(name, value);
  }
  const host = member(HOSTS, values.get("host"));
  const agent = member(AGENTS, values.get("agent"));
  const scenario = member(SCENARIOS, values.get("scenario"));
  const output = values.get("output");
  const xmd = values.get("xmd");
  if (host === undefined || agent === undefined || scenario === undefined || output === undefined) {
    return { kind: "refused", message: Refusal.unsupported };
  }
  if (host === "source" && xmd !== undefined) {
    return { kind: "refused", message: Refusal.unsupported };
  }
  if (host === "compiled" && (xmd === undefined || !isAbsolute(xmd))) {
    return { kind: "refused", message: Refusal.compiled };
  }
  if (!paid) {
    return { kind: "refused", message: Refusal.paid };
  }
  return {
    kind: "selected",
    selection: { host, agent, scenario, output, ...(xmd === undefined ? {} : { xmd }) },
  };
}
