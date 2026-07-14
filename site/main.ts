import { App, staticFiles } from "fresh";
import { type State } from "./utils.ts";

export const app = new App<State>();

// Serve /install.sh from static/, but rewrite its self-referencing install URL
// to the request origin so the script matches whatever host serves it
// (executablemd.taras.deno.net today, executable.md once the domain is attached).
app.use(async (ctx) => {
  const url = new URL(ctx.req.url);
  if (url.pathname === "/install.sh") {
    const res = await ctx.next();
    if (!res.ok) return res;
    const body = (await res.text()).replaceAll(
      "https://executable.md/install.sh",
      `${url.origin}/install.sh`,
    );
    return new Response(body, {
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }
  return ctx.next();
});

app.use(staticFiles());

// File-system based routes (routes/ + islands/).
app.fsRoutes();
