import { define } from "../utils.ts";
// INSTALL_SCRIPT is generated from the repo-root install.sh (single source of
// truth) by `deno task embed:install`, run before dev/build. The self-reference
// is rewritten per request so the served script points at whatever origin is
// serving it.
import { INSTALL_SCRIPT } from "../lib/install-script.ts";

export const handler = define.handlers({
  GET(ctx) {
    const body = INSTALL_SCRIPT.replaceAll(
      "https://executable.md/install.sh",
      `${ctx.url.origin}/install.sh`,
    );
    return new Response(body, {
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  },
});
