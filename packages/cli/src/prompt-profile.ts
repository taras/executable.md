/**
 * The prompt profile — the trusted-host assembly the prompt command document
 * runs under, and the only thing that ever runs under it
 * (specs/prompt-command-spec.md).
 *
 * `xmd prompt` owns two root document executions with a complete scope boundary
 * between them. This module is the first one. It supplies that document's
 * inputs, a
 * constrained Agent provider, Elicitation, the fixed first-party components and
 * the host-declared candidate validator, and it exposes no custom root and no
 * repository component search: the program it runs is the one the CLI ships.
 *
 * The Agent ceiling is assembled here rather than read from the command line,
 * because it is not the caller's to choose. Writing a Plan is a conversation
 * about text; it never lets an agent touch anything. So the provider gets a fresh empty
 * directory of this host's own, no additional directories, no MCP servers, an
 * empty native-tool allowlist and a private strict denial of every native
 * permission request — one that answers inside the provider and consults no
 * authored approval scope, so nothing composed around it can widen a ceiling
 * with nothing in it. `--approve-all`, `--approve-reads` and `--deny-all`
 * configure the approved document, later, and reach none of this.
 *
 * The document itself is given no Files, command, service or XMD-mediated
 * network capability either. It decides what to write; it writes nothing.
 */

import { Err, Ok, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  agentIdentityComponents,
  collect,
  installAgentComponents,
  installPermissionMode,
  installPromptFailurePolicy,
  registerAgentProvider,
  retainedSource,
} from "@executablemd/core";
import type { Json } from "@executablemd/core";
import type { IdentityComponent } from "@executablemd/core/host";
import { executeInstalled } from "@executablemd/core/host";
import { createAcpxProvider } from "@executablemd/acp";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";

import { hostAcpDependencies } from "./agent-stack.ts";
import type { AgentStack } from "./agent-stack.ts";
import { PROMPT_COMMAND_DOCUMENT, readPackagedDocument } from "./packaged-document.ts";

/**
 * The identity the prompt command document runs under.
 *
 * Stable and internal: no path selects it, no include resolves it, and a
 * position reading `(<prompt-command>:12:1)` says the source is the CLI's own.
 */
export const PROMPT_COMMAND_IDENTITY = "<prompt-command>";

/**
 * The permission mode the prompt command document runs under.
 *
 * Fixed rather than configured. The provider denies native requests privately,
 * so this is what an authored approval scope inside that document would
 * compose around if one existed — and the honest answer for a profile that
 * grants no native authority is the one that grants none.
 */
const PROFILE_PERMISSION_MODE = "deny-all";

/** The closed answer the host gives about one candidate. */
export interface CandidateAssessment {
  valid: boolean;
  /** Empty when valid; the complete structured findings when not. */
  diagnostics: Json;
}

/** What the host supplies to one prompt command document execution. */
export interface PromptProfile {
  /** The request as the person typed it. */
  request: string;
  /** The rendered syntax catalog for this run profile and these includes. */
  syntax: string;
  /** The logical name every turn in this invocation belongs to. */
  session: string;
  /** The one Agent configuration this invocation settled. */
  stack: AgentStack;
  /** What the constrained provider is built on, beyond the host's assembly. */
  acp?: AcpxProviderDependencies;
  /** Who answers the review question. */
  installElicitation(): Operation<void>;
  /**
   * The host's assessment of one candidate.
   *
   * A candidate-authored failure comes back as `valid: false` and is repairable.
   * A caller-source failure raises, which ends that execution: the document
   * has no way to catch it and no way to recategorize it as feedback
   * for an agent that could not have caused it.
   */
  assess(source: string): Operation<CandidateAssessment>;
}

/**
 * Run the packaged prompt command document and answer with the Plan it approved.
 *
 * Every resource this builds lives inside one scope, so leaving it is what tears
 * the Prompt tasks, the provider and the Elicitation provider down. A teardown
 * failure raises out of here rather than being folded into the result, because
 * a failure to release is not an outcome the source that was selected survives.
 */
export function* runPromptCommandDocument(profile: PromptProfile): Operation<Result<string>> {
  // Before a directory exists, before a provider exists, and therefore before
  // any session could be placed or any turn started. A host that cannot
  // establish this ceiling refuses rather than writing a Plan under a weaker one.
  if (profile.stack.provider !== "acpx") {
    return Err(
      new Error(
        `the ${profile.stack.provider} provider cannot establish the prompt profile's ` +
          "ceiling — nothing was written or run",
      ),
    );
  }

  return yield* scoped(function* (): Operation<Result<string>> {
    const workdir = yield* useProfileDirectory();
    yield* refuseDocumentCapabilities();
    yield* profile.installElicitation();

    const acpx = createAcpxProvider(profileCeiling(profile, workdir));
    yield* registerAgentProvider("acpx", acpx);
    const options = {
      defaultAgent: profile.stack.defaultAgent,
      permissionMode: PROFILE_PERMISSION_MODE,
    } as const;
    yield* installAgentComponents({ ...options, rootProvider: { factory: acpx, options } });
    yield* installPermissionMode(PROFILE_PERMISSION_MODE);
    // A candidate comes from a turn's complete successful close value or from
    // nowhere. `<Prompt>` ordinarily renders whatever a failed turn managed to
    // emit and carries on, which for a policy that reviews source would mean
    // showing a person half a program; the host decides otherwise here, so a
    // failed, cancelled or protocol-invalid turn ends the command before anything
    // is presented. The document cannot opt out of it.
    yield* installPromptFailurePolicy(function* () {
      return true;
    });

    const source = yield* readPackagedDocument(PROMPT_COMMAND_DOCUMENT);
    try {
      const approved = yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(PROMPT_COMMAND_IDENTITY, source),
            // Invocation-owned and thrown away with the scope. Ordinary document
            // and Prompt semantics need a durable stream; nothing about writing a
            // Plan needs a durable one, and `--journal` belongs to the Plan you
            // approved rather than to the conversation that wrote it.
            stream: new InMemoryStream(),
            // No repository component search. What the document may name is
            // what this profile declares, so a file in the caller's tree cannot
            // answer for `<ValidateCandidate>`, `<Prompt>` or anything else.
            includes: [],
            props: {
              request: profile.request,
              syntax: profile.syntax,
              session: profile.session,
            },
          },
          [{ components: [...agentIdentityComponents(), validator(profile)] }],
        ),
      );
      if (typeof approved !== "string") {
        return Err(new Error("the prompt command document returned something that is not a Plan"));
      }
      return Ok(approved);
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * The host-declared candidate validator, as an internal value component.
 *
 * Declared to the execution, so canonical execution supplies its invocation
 * identity and repository resolution cannot replace it. It executes nothing it
 * is given: a candidate is a string here, and stays one until a person has
 * approved it and the host has validated it again.
 */
function validator(profile: PromptProfile): IdentityComponent {
  return {
    name: "ValidateCandidate",
    origin: "xmd prompt",
    forms: ["self-closing"] as const,
    props: {
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
      additionalProperties: false,
    },
    returns: {
      type: "object",
      properties: { valid: { type: "boolean" }, diagnostics: { type: "object" } },
      required: ["valid", "diagnostics"],
      additionalProperties: false,
    },
    factory: () =>
      function* validateCandidate(props: Record<string, Json>) {
        const assessment = yield* profile.assess(String(props.source));
        return { valid: assessment.valid, diagnostics: assessment.diagnostics };
      },
  };
}

/**
 * The Agent ceiling, stated as the dependencies the provider is built from.
 *
 * Each entry is the whole of one clause: the working directory the agent runs
 * in, the MCP servers it configures, the native tools a fresh session may use,
 * and who answers a native permission request. `mcpServers: []` and
 * `allowedTools: []` are statements rather than omissions — leaving either off
 * is the backend's default, which is not this host's.
 *
 * The host's own assembly is passed through, then overridden: a coordinator or
 * a route store says who owns a session, which this profile still has to respect,
 * while nothing a caller wrote may reach the four fields below.
 */
function profileCeiling(profile: PromptProfile, workdir: string): AcpxProviderDependencies {
  return {
    ...hostAcpDependencies(profile.stack.sessions),
    ...profile.acp,
    // deno-lint-ignore require-yield
    *agentCwd() {
      return workdir;
    },
    mcpServers: [],
    permissions: "strict",
    newSessionOptions: { systemPrompt: PROMPT_INSTRUCTIONS, allowedTools: [] },
  };
}

/**
 * What the assistant session is told once, before it is asked anything.
 *
 * The host owns this layer, and it owns only this: the shape of every answer,
 * which is the one thing a policy cannot state about itself convincingly. What
 * to write, which vocabulary is available, how to repair a draft and what a
 * person asked to change are the prompt command document's text, and they arrive
 * in the turns it sends.
 */
export const PROMPT_INSTRUCTIONS = [
  "You write complete executable Markdown root documents. Each user message is a",
  "request about one document.",
  "",
  "Every answer is replacement document source and nothing else: no enclosing code",
  "fence, no explanation, and no prose around it. What you return is validated and",
  "executed exactly as you wrote it.",
].join("\n");

/**
 * Where the assistant runs while it writes a Plan: this host's own directory,
 * and an empty one.
 *
 * The caller's working directory is deliberately not offered — an agent writing
 * a document has no reason to read the tree it will run in, and a ceiling that
 * starts at the caller's checkout is not a ceiling. Nothing this profile grants
 * can write here either, so what is created empty stays empty.
 *
 * One fixed path rather than a new directory each time, because a session's
 * identity includes the directory it lives in: a location that changed every
 * invocation would mean `--session` could never name a conversation that
 * already exists, which is the whole of what that option is for.
 */
export const PROMPT_PROFILE_DIRECTORY: string = join(homedir(), ".xmd", "prompt");

function* useProfileDirectory(): Operation<string> {
  yield* until(mkdir(PROMPT_PROFILE_DIRECTORY, { recursive: true }));
  return PROMPT_PROFILE_DIRECTORY;
}

/**
 * The capabilities the prompt command document does not get.
 *
 * Installed above whatever the entrypoint provided, so the document is
 * refused rather than served. It decides what to write; writing a file,
 * running a command, starting a service and reaching the network are all the
 * approved document's business, under the caller's own configuration.
 */
function* refuseDocumentCapabilities(): Operation<void> {
  const refuse = (capability: string) => () => {
    throw new Error(
      `xmd prompt asked for ${capability}, which the prompt profile grants to nothing`,
    );
  };
  yield* API.Files.around({
    // deno-lint-ignore require-yield
    *checkFilePath() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *readTextFile() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *writeTextFile() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *deleteFile() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *globFiles() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *temporaryDirectory() {
      return refuse("a directory")();
    },
  });
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec() {
      return refuse("a command")();
    },
  });
  yield* API.Fetch.around({
    // deno-lint-ignore require-yield
    *fetch() {
      return refuse("the network")();
    },
  });
  yield* API.Service.around({
    // deno-lint-ignore require-yield
    *start() {
      return refuse("a service")();
    },
  });
}
