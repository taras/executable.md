import { Err, Ok, type Result, type Operation } from "effection";
import { agentSessionKeyDigest, AgentSessionOwnershipError } from "@executablemd/runtime";
import type {
  AgentSessionOwnershipAdministration,
  AgentSessionOwnershipFailureCode,
} from "@executablemd/runtime";

export const SESSION_HELP = `Inspect or explicitly reclaim one session ownership record.

xmd session ownership --key-digest D [--json]
xmd session ownership --provider P --agent-command A --session-key K [--json]
xmd session recover --key-digest D --expect R --force [--json]
xmd session --help
xmd session ownership --help
xmd session recover --help

D and R are lowercase SHA-256 digests. A is the exact resolved configured
agent command, not an alias. Inspection reads one record without probing its lock.
--force accepts backend quiescence unproved and interrupted outcome UNKNOWN.
A live lock holder stays busy. These commands send no provider requests.
`;

type Command =
  | { kind: "help" }
  | { kind: "ownership"; keyDigest: string; json: boolean }
  | { kind: "recover"; keyDigest: string; expectedRevision: string; force: true; json: boolean };
const digest = /^[0-9a-f]{64}$/;

function parse(args: string[]): Result<Command> {
  if (
    (args.length === 1 && args[0] === "--help") ||
    (args.length === 2 && ["ownership", "recover"].includes(args[0]!) && args[1] === "--help")
  ) {
    return Ok({ kind: "help" });
  }
  const kind = args[0];
  if (kind !== "ownership" && kind !== "recover") {
    return Err(new Error("expected session ownership, recover or --help"));
  }
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!;
    const equal = token.indexOf("=");
    const name = equal < 0 ? token : token.slice(0, equal);
    if (
      ![
        "--key-digest",
        "--provider",
        "--agent-command",
        "--session-key",
        "--expect",
        "--force",
        "--json",
      ].includes(name)
    ) {
      return Err(new Error("unknown session option or positional argument"));
    }
    if (values.has(name)) {
      return Err(new Error(`duplicate session option ${name}`));
    }
    if (name === "--force" || name === "--json") {
      if (equal >= 0) {
        return Err(new Error(`${name} accepts no value`));
      }
      values.set(name, "true");
    } else {
      const value = equal < 0 ? args[++i] : token.slice(equal + 1);
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        return Err(new Error(`${name} requires a nonempty value`));
      }
      values.set(name, value);
    }
  }
  const direct = values.get("--key-digest");
  const provider = values.get("--provider");
  const agent = values.get("--agent-command");
  const sessionKey = values.get("--session-key");
  const triple = provider !== undefined || agent !== undefined || sessionKey !== undefined;
  if (direct !== undefined && (!digest.test(direct) || triple)) {
    return Err(
      new Error(
        "use one lowercase --key-digest or the complete provider/agent-command/session-key triple",
      ),
    );
  }
  if (kind === "recover" && triple) {
    return Err(new Error("recovery accepts only --key-digest"));
  }
  let keyDigest: string;
  if (direct !== undefined) {
    keyDigest = direct;
  } else if (provider && agent && sessionKey) {
    keyDigest = agentSessionKeyDigest({ provider, agent, sessionKey });
  } else {
    return Err(
      new Error("supply --key-digest or the complete provider/agent-command/session-key triple"),
    );
  }
  const json = values.has("--json");
  if (kind === "ownership") {
    if (values.has("--expect") || values.has("--force")) {
      return Err(new Error("inspection accepts neither --expect nor --force"));
    }
    return Ok({ kind, keyDigest, json });
  }
  const expectedRevision = values.get("--expect");
  if (!expectedRevision || !digest.test(expectedRevision) || !values.has("--force")) {
    return Err(new Error("recovery requires lowercase --expect and explicit --force"));
  }
  return Ok({ kind, keyDigest, expectedRevision, force: true, json });
}

function failure(
  code: AgentSessionOwnershipFailureCode,
  message: string,
  json: boolean,
  keyDigest?: string,
): number {
  if (json) {
    console.error(
      JSON.stringify({
        schema: "agent-session-ownership-error",
        code,
        message,
        ...(keyDigest ? { keyDigest } : {}),
        ...(code === "publication-unknown" ? { applied: "unknown" } : {}),
      }),
    );
  } else {
    console.error(`xmd session: ${message}`);
  }
  return 1;
}

export function* runSessionOwnership(
  args: string[],
  administration?: AgentSessionOwnershipAdministration,
): Operation<number> {
  const command = parse(args);
  if (!command.ok) {
    return failure("record-invalid", command.error.message, args.includes("--json"));
  }
  const input = command.value;
  if (input.kind === "help") {
    console.log(SESSION_HELP);
    return 0;
  }
  if (!administration) {
    const error = new AgentSessionOwnershipError("unsupported-capability");
    return failure(error.code, error.message, input.json, input.keyDigest);
  }
  try {
    if (input.kind === "ownership") {
      const result = yield* administration.inspectOwnership(input.keyDigest);
      if (!result.ok) {
        const error =
          result.error instanceof AgentSessionOwnershipError
            ? result.error
            : new AgentSessionOwnershipError("io-failure");
        return failure(error.code, error.message, input.json, input.keyDigest);
      }
      const value = result.value;
      console.log(
        input.json
          ? JSON.stringify({ schema: "agent-session-ownership-inspection", ...value })
          : `Session ${value.keyDigest}\nState: ${value.record.state}\nOwner: ${value.record.ownerKind} ${value.record.operationId}\nRecord revision: ${value.recordRevision}`,
      );
    } else {
      const result = yield* administration.forceRecoverOwnership({
        keyDigest: input.keyDigest,
        expectedRevision: input.expectedRevision,
        force: true,
      });
      if (!result.ok) {
        const error =
          result.error instanceof AgentSessionOwnershipError
            ? result.error
            : new AgentSessionOwnershipError("io-failure");
        return failure(error.code, error.message, input.json, input.keyDigest);
      }
      const value = result.value;
      console.log(
        input.json
          ? JSON.stringify({ schema: "agent-session-force-recovery", ...value })
          : `Session ${value.keyDigest}\nForced reclaim: ${value.recoveryId}\nBackend quiescence: unproved\nInterrupted outcome: UNKNOWN\nProvider requests: none\nRecord revision: ${value.recordRevision}`,
      );
    }
    return 0;
  } catch (cause) {
    const error =
      cause instanceof AgentSessionOwnershipError
        ? cause
        : new AgentSessionOwnershipError("io-failure");
    return failure(error.code, error.message, input.json, input.keyDigest);
  }
}
