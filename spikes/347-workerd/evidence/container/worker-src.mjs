import { DurableObject } from "cloudflare:workers";
import { withWorkspace, getWorkspace, WorkspaceProxy } from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";

// Loopback entrypoint used by ctx.exports.WorkspaceProxy for container
// egress interception (computerd dials ws://computer.internal/ws).
export { WorkspaceProxy };

class ContainerBase extends withWorkspaceContainer(class extends DurableObject {}) {
  backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "AGENT", id: this.ctx.id.toString() },
  });
}

function workspaceOptions(self) {
  return {
    storage: self.ctx.storage,
    backends: [self.backend],
    waitUntil: self.ctx.waitUntil.bind(self.ctx),
  };
}

export class Agent extends withWorkspace(ContainerBase, workspaceOptions) {
  // computerd's outbound /ws upgrade arrives here via WorkspaceProxy.
  async fetch(request) {
    return this.backend.handleFetch(request);
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const id = env.AGENT.idFromName("container-probe");
    const stub = env.AGENT.get(id);
    const ws = await getWorkspace(stub);
    try {
      switch (url.pathname) {
        case "/exec": {
          const command = url.searchParams.get("cmd") ?? (await request.text());
          const handle = await ws.runtime.exec(command, { encoding: "utf8" });
          const result = await handle.result();
          return json({ ok: true, op: "exec", command, result });
        }
        case "/write": {
          const body = url.searchParams.get("body") ?? (await request.text());
          await ws.fs.writeFile(path, body);
          return json({ ok: true, op: "write", path, bytes: body.length });
        }
        case "/read": {
          const content = await ws.fs.readFile(path, "utf8");
          return json({ ok: true, op: "read", path, content });
        }
        case "/ls": {
          const entries = await ws.fs.readdir(path);
          return json({ ok: true, op: "ls", path, entries });
        }
        default:
          return json({ ok: false, error: `unknown route ${url.pathname}` }, 404);
      }
    } catch (error) {
      return json(
        { ok: false, error: String(error && error.stack ? error.stack : error) },
        500,
      );
    } finally {
      ws[Symbol.dispose]?.();
    }
  },
};
