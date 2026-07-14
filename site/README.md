# executable.md — website

The landing page and docs for [executable.md](https://executable.md), built with
[Fresh](https://fresh.deno.dev) and deployed to
[Deno Deploy](https://deno.com/deploy).

This is a member of the repo's Deno workspace, so install deps from the **repo
root** (`deno install`), then run tasks from this directory.

## Develop

```bash
deno task dev      # dev server at http://localhost:5173
deno task build    # production build into _fresh/
deno task start    # serve the production build
```

The install script served at `https://executable.md/install.sh` lives at
`static/install.sh` — keep it in sync with the repo-root `install.sh`.

## Deploy to Deno Deploy

**Recommended — Git integration:** create a project at https://console.deno.com,
link this repository, set the **install command** to `deno install` (run at the
repo root), the **build command** to `cd site && deno task build`, and the
**entrypoint** to `site/_fresh/server.js`. Deno Deploy rebuilds on every push to
`main`.

**Alternative — GitHub Actions:** see `.github/workflows/deploy.yml` (uses
`deployctl`; requires a `DENO_DEPLOY_TOKEN` secret and a `DENO_DEPLOY_PROJECT`
repo variable).

## Custom domain (executable.md)

1. In the Deno Deploy project → **Settings → Domains**, add `executable.md`.
2. Add the DNS records Deno Deploy shows (an `A`/`ANAME`/`CNAME` for the apex
   plus the TXT verification record) at your registrar.
3. Enable automatic TLS once the domain verifies.
4. After the domain is live, confirm `https://executable.md/install.sh` resolves
   — the hero install one-liner depends on it.
