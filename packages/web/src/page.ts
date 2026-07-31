/**
 * The static form page: its shell markup and its fixed security headers.
 *
 * The shell is fully static. It carries no author content and no interpolated
 * values: it references the client script and stylesheet by same-origin
 * relative paths and leaves three empty elements for the client to fill — so the
 * page needs no inline script and admits none.
 *
 * `#content` receives the document's rendered body, already sanitized on the
 * server. `#root` receives the form. `#status` is a live region, so a screen
 * reader announces the result of a submission instead of leaving it to be
 * noticed: `role="status"` with `aria-live="polite"` waits for a pause rather
 * than interrupting, which is right for a confirmation.
 *
 * The headers are fixed and restrictive, and no author setting relaxes them.
 * `default-src 'none'` denies every resource class that is not named, so media,
 * frames, objects, workers, and manifests are all forbidden without being
 * listed. `script-src 'self'` admits only same-origin scripts — the client
 * bundle and the server-precompiled validator script — and no inline script,
 * nonce, `unsafe-eval`, blob, or data script.
 *
 * `font-src data:` is the one place a `data:` URL is admitted, and fonts are
 * the only resource class it governs. The stylesheet carries its faces inline
 * as `data:` URIs rather than linking them, so the directive names no origin at
 * all: it cannot reach the network, and the page still makes no request off the
 * machine. `'self'` is deliberately absent — nothing serves a font file.
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
  "font-src data:",
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
    <div id="content"></div>
    <div id="root"></div>
    <div id="status" role="status" aria-live="polite"></div>
    <script src="client.js"></script>
  </body>
</html>
`;
