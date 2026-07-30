/**
 * The static form page: its shell markup and its fixed security headers.
 *
 * The shell is fully static. It carries no author content and no interpolated
 * values: it references the client script and stylesheet by same-origin
 * relative paths and leaves an empty `#root` for the client to render into —
 * so the page needs no inline script and admits none.
 *
 * The headers are fixed and restrictive, and no author setting relaxes them.
 * `default-src 'none'` denies every resource class that is not named, so fonts,
 * media, frames, objects, workers, and manifests are all forbidden without
 * being listed. `script-src 'self'` admits only same-origin scripts — the
 * client bundle and the server-precompiled validator script — and no
 * inline script, nonce, `unsafe-eval`, blob, or data script.
 *
 * Styling is the one place inline content is admitted, and only as attributes.
 * RJSF's shadcn theme sets `style` attributes on ordinary widgets and on the
 * elements it positions, so the page would not render without them.
 * `style-src-attr 'unsafe-inline'` admits exactly those attributes;
 * `style-src 'self'` still governs stylesheets, so an inline `<style>` element
 * and any external stylesheet remain forbidden. Scripts are unaffected: the
 * style relaxation is expressed in its own directive and cannot widen
 * `script-src`.
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

export const PAGE_SHELL = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>executable.md</title>
    <link rel="stylesheet" href="theme.css">
  </head>
  <body>
    <div id="root"></div>
    <script src="client.js"></script>
  </body>
</html>
`;
