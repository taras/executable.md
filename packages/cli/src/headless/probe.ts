import * as acp from "@agentclientprotocol/sdk";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { SidekickTransport } from "../sidekick-acp/protocol.ts";

export function* runChildProbe(): Operation<void> {
  const streams = yield* (yield* SidekickTransport.expect()).stdio();
  let connection: acp.AgentConnection | undefined;
  yield* ensure(() => connection?.close());
  connection = acp
    .agent({ name: "xmd-child" })
    .onRequest("initialize", () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
    }))
    .onRequest("session/new", () => {
      throw new acp.RequestError(
        -32602,
        "An exact parent-owned XMD child is required; no child was started.",
      );
    })
    .connect(acp.ndJsonStream(streams.output, streams.input));
  yield* until(connection.closed);
}
