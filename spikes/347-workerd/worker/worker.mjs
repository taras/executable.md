// Worker-side module: the Workers platform mandates async handlers, so this
// file follows the platform contract rather than repository Code Rule 1.
import { DurableObject } from "cloudflare:workers";
import { getWorkspace, withWorkspace } from "@cloudflare/computer";

// The worker backends reach the Workspace through a loopback self-binding:
// ctx.exports.WorkspaceServiceProxy requires this class as a top-level export.
export { WorkspaceServiceProxy } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";

export class ProofObject extends withWorkspace(
  class extends DurableObject {},
  (self) => ({
    storage: self.ctx.storage,
    waitUntil: self.ctx.waitUntil.bind(self.ctx),
    backends: self.env.LOADER
      ? [
        new WorkerShellBackend({
          loader: self.env.LOADER,
          workspace: { binding: "PROOF", id: self.ctx.id.toString() },
          ctx: self.ctx,
        }),
        new WorkerJavaScriptBackend({ loader: self.env.LOADER }),
      ]
      : [],
  }),
) {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/increment") {
      const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
      await this.ctx.storage.put("count", count);
      return Response.json({ count });
    }
    if (url.pathname === "/count") {
      const count = (await this.ctx.storage.get("count")) ?? 0;
      return Response.json({ count });
    }
    return Response.json({ error: `unknown path ${url.pathname}` }, { status: 404 });
  }
}

async function fsOp(ws, url) {
  const path = url.searchParams.get("path");
  switch (url.pathname) {
    case "/fs/mkdir":
      await ws.fs.mkdir(path, { recursive: true });
      return { ok: true };
    case "/fs/write":
      await ws.fs.writeFile(path, url.searchParams.get("body") ?? "");
      return { ok: true };
    case "/fs/read":
      return { content: await ws.fs.readFile(path, "utf8") };
    case "/fs/ls": {
      const entries = await ws.fs.readdir(path);
      return {
        entries: entries.map((entry) =>
          typeof entry === "string" ? entry : entry.name
        ),
      };
    }
    case "/fs/rm":
      await ws.fs.rm(path, {
        recursive: url.searchParams.get("recursive") === "1",
      });
      return { ok: true };
    default:
      return { error: `unknown fs op ${url.pathname}` };
  }
}

async function execOp(ws, url) {
  const backend = url.searchParams.get("backend");
  const source = url.searchParams.get("source");
  const handle = await ws.runtime.exec(source, {
    backend,
    encoding: "utf8",
    timeoutMs: 30_000,
  });
  const result = await handle.result();
  return { result };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const identity = url.searchParams.get("identity") ?? "proof-347";
    const stub = env.PROOF.get(env.PROOF.idFromName(identity));
    if (url.pathname.startsWith("/fs/") || url.pathname.startsWith("/exec")) {
      const ws = await getWorkspace(stub);
      try {
        const body = url.pathname.startsWith("/fs/")
          ? await fsOp(ws, url)
          : await execOp(ws, url);
        return Response.json(body);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      } finally {
        ws[Symbol.dispose]?.();
      }
    }
    return stub.fetch(request);
  },
};
