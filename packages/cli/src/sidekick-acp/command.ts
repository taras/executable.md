import { env } from "@executablemd/runtime";
import { childAddressPath } from "../headless/host.ts";
import { runChildProbe } from "../headless/probe.ts";
import { z } from "zod";
import type { Operation } from "effection";
import { isAbsolute } from "node:path";
import { messageReference } from "./protocol.ts";
import { requestAttachment } from "./client.ts";
import { runSidekickBridge } from "./bridge.ts";

export const SIDEKICK_HELP = [
  "Attach to the existing Sidekick of one live REPL (POSIX only).",
  "  xmd repl [location] --sidekick-acp /absolute/private/attachment.json",
  "--sidekick-acp sends an initial Sidekick message when no conversation is selected; existing history is reused.",
  "  xmd sidekick acp --attach /absolute/private/attachment.json",
  "  xmd sidekick read --attach /absolute/private/attachment.json status",
  "  xmd sidekick read --attach FILE message MESSAGE_REF [--follow]",
  "  xmd sidekick read --attach FILE entry ENTRY source|prompt|output [--cursor CURSOR] [--prompt POSITIVE] [--field request|reply|error]",
  "  xmd sidekick read --attach FILE entry ENTRY journal [--yq EXPRESSION]",
  "Reads and follow are passive. EOF detaches observation; explicit ACP cancel/close joins only that attachment's exact exchange.",
  "No shared-draft takeover, question answering or provider configuration is granted. This is Sidekick-specific; it is independent of repository ACP.",
].join("\n");
const positive = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());
export function* runSidekickCommand(args: readonly string[]): Operation<void> {
  if (args[0] === "child-acp") {
    if (!(args.length === 1 || (args.length === 3 && args[1] === "--session-id"))) {
      throw new Error("child-acp accepts only --session-id with an exact live child reference.");
    }
    const sessionId = args[2] ?? (yield* env("XMD_HEADLESS_SESSION"));
    if (sessionId === undefined) {
      yield* runChildProbe();
    } else {
      yield* runSidekickBridge(
        (yield* env("XMD_HEADLESS_ENDPOINT")) ?? (yield* childAddressPath(sessionId)),
        sessionId,
      );
    }
    return;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(SIDEKICK_HELP);
    return;
  }
  const words: string[] = [];
  const flags = new Map<string, string>();
  let follow = false;
  for (let at = 1; at < args.length; at += 1) {
    const token = args[at] ?? "";
    if (token === "--follow") {
      if (follow) {
        throw new Error("Repeated --follow.");
      }
      follow = true;
      continue;
    }
    if (token.startsWith("--")) {
      if (
        !["--attach", "--cursor", "--prompt", "--field", "--yq"].includes(token) ||
        flags.has(token)
      ) {
        throw new Error("Unknown or repeated Sidekick option.");
      }
      const value = args[++at];
      if (
        value === undefined ||
        value.length === 0 ||
        (token !== "--yq" && value.startsWith("-"))
      ) {
        throw new Error("Sidekick options require one value.");
      }
      flags.set(token, value);
    } else {
      words.push(token);
    }
  }
  const path = flags.get("--attach");
  if (path === undefined || !isAbsolute(path)) {
    throw new Error("--attach requires one absolute attachment file.");
  }
  if (args[0] === "acp" && words.length === 0 && flags.size === 1 && !follow) {
    yield* runSidekickBridge(path);
    return;
  }
  if (args[0] !== "read") {
    throw new Error("Select sidekick acp or sidekick read.");
  }
  let value: unknown;
  if (words.length === 1 && words[0] === "status" && flags.size === 1 && !follow) {
    value = yield* requestAttachment(path, { method: "status" });
  } else if (words.length === 2 && words[0] === "message" && flags.size === 1) {
    value = yield* requestAttachment(
      path,
      { method: "message", reference: messageReference(words[1] ?? ""), follow },
      function* (update) {
        console.log(JSON.stringify(update));
      },
    );
  } else if (words.length === 3 && words[0] === "entry" && !follow) {
    const view = z.enum(["source", "prompt", "output", "journal"]).parse(words[2]);
    if (
      (view === "journal" && flags.has("--cursor")) ||
      (view !== "journal" && flags.has("--yq"))
    ) {
      throw new Error("Journal accepts --yq; --cursor applies to source, prompt and output pages.");
    }
    if (view !== "prompt" && (flags.has("--prompt") || flags.has("--field"))) {
      throw new Error("Prompt selectors apply only to prompt pages.");
    }
    value = yield* requestAttachment(path, {
      method: "entry",
      entry: positive.parse(words[1]),
      view,
      ...(flags.has("--yq") ? { yq: flags.get("--yq") } : {}),
      ...(flags.has("--cursor") ? { cursor: flags.get("--cursor") } : {}),
      ...(flags.has("--prompt") ? { prompt: positive.parse(flags.get("--prompt")) } : {}),
      ...(flags.has("--field")
        ? { field: z.enum(["request", "reply", "error"]).parse(flags.get("--field")) }
        : {}),
    });
  } else {
    throw new Error("Sidekick reads accept only status, exact message or bounded entry evidence.");
  }
  console.log(JSON.stringify(value));
}
