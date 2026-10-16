/**
 * The one provider a retained conversation does its work through.
 *
 * `Agent` is compositional on purpose: a Plugin narrows it, a test pins it,
 * `<Session>` composes it. That is right for a document, where composing the
 * chain *is* the extension point — and wrong for a conversation, because a
 * conversation's provider is also the thing holding it to what it was created
 * under. A handler that forwards a request's descriptive name instead of the
 * request opens an ordinary route: the provider never reaches the setup the
 * coordinator delivers, so the configuration check never happens and the turn
 * lands in a session nobody compared. A prompt handler can do the same thing
 * one call later by replacing `options.session` after it was checked.
 *
 * So the conversation does not route. Its host installs the object below, the
 * conversation reads it once in its own scope, and every operation of that chat
 * goes to that object directly. Nothing in between can choose the session a
 * message reaches, the agent it is resolved under, or whether the required
 * check is performed — which is what architecture rule 24 means by capturing a
 * selected service for a lifetime that needs a fixed provider.
 *
 * It selects trusted behavior and nothing more. Core still owns the
 * requirement, the one-use session request, the native identity and the
 * journal; this carries no coordinator, no permission flag, no configuration
 * approval and no history mapping. A later selection cannot reach a chat that
 * is already open, because the value was read in that chat's own scope and is
 * an ordinary local from then on.
 *
 * Ordinary `<Session>` and `<Prompt>` are untouched. They compose, as rule 25
 * says per-call interception should.
 */

import { createContext } from "effection";
import type { Operation, Stream } from "effection";
import type {
  AgentOptions,
  AgentOptionsRequest,
  AgentPromptEvent,
  PromptOptions,
  Session,
} from "./agent-api.ts";
import type { AgentSessionRequest } from "./session-request.ts";

/**
 * What one installed provider offers a conversation it serves.
 *
 * Four operations, each the provider's own implementation of what the public
 * chain would have reached — and each taking explicitly what the chain used to
 * supply implicitly. The agent is an argument rather than an ambient
 * selection, and the session is the exact value this conversation's own request
 * finished with, so neither can be decided by anything but the conversation.
 */
export interface AgentConversationProvider {
  /** Resolve the agent selected for this conversation. */
  agent(name: string): Operation<string>;
  /**
   * Resolve this conversation's own request under the selected agent.
   *
   * The genuine request, which is the whole point: it is what carries the
   * identity and the requirement to the setup the coordinator delivers. A name,
   * a `Session` or a look-alike names no conversation here.
   */
  session(request: AgentSessionRequest, agent: string): Operation<Session>;
  /** Read the selected agent's advertised model and effort choices. */
  options(agent: string, request?: AgentOptionsRequest): Operation<AgentOptions>;
  /**
   * A cold turn stream for the exact Session this conversation supplies.
   *
   * Cold, so obtaining it starts nothing: the turn begins when the journal
   * subscribes, which is where its liveness and its native work belong.
   */
  prompt(
    content: string,
    options: PromptOptions & { agent: string; session: Session },
  ): Operation<Stream<AgentPromptEvent, string>>;
}

/**
 * Where a provider says it can serve saved conversations.
 *
 * Set by the provider inside its own installation, so what is selected has that
 * provider's lifetime and its methods refuse once it is gone. Undefined by
 * default, and undefined is an answer: a provider that offers only ordinary
 * `Agent` middleware does not serve conversations, and a conversation opened
 * over it refuses rather than falling back to the routing this exists to avoid.
 */
export const AgentConversationProvider = createContext<AgentConversationProvider | undefined>(
  "executablemd.agent.conversation.provider",
  undefined,
);
