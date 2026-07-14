import { define } from "../utils.ts";

const THEME_SCRIPT =
  `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

const FAVICON = "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f9e63"/><text x="16" y="22" font-family="ui-monospace,monospace" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">.md</text></svg>`,
  );

export default define.page(function App({ Component }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />

        <title>executable.md — markdown that runs</title>
        <meta
          name="description"
          content="executable.md treats plain markdown documents as durable, executable workflows: expand components, run code blocks, and replay from a journal after a crash — in a file that still renders as normal markdown anywhere."
        />
        <link rel="icon" type="image/svg+xml" href={FAVICON} />
        <link rel="canonical" href="https://executable.md/" />
        <meta
          name="theme-color"
          content="#ffffff"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#0d1117"
          media="(prefers-color-scheme: dark)"
        />

        <meta property="og:type" content="website" />
        <meta
          property="og:title"
          content="executable.md — markdown that runs"
        />
        <meta
          property="og:description"
          content="Treat plain markdown documents as durable, executable workflows — components, runnable code blocks, and crash-proof replay."
        />
        <meta property="og:url" content="https://executable.md/" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="twitter:title"
          content="executable.md — markdown that runs"
        />
        <meta
          name="twitter:description"
          content="Treat plain markdown documents as durable, executable workflows."
        />
      </head>
      <body>
        <Component />
      </body>
    </html>
  );
});
