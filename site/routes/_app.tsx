import { define } from "../utils.ts";

const SITE = "https://executable.md";

const THEME_SCRIPT =
  `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

const FAVICON = "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f9e63"/><text x="16" y="22" font-family="ui-monospace,monospace" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">.md</text></svg>`,
  );

const DEFAULT_DESC =
  "executable.md treats plain markdown documents as durable, executable workflows: expand components, run code blocks, and replay from a journal after a crash — in a file that still renders as normal markdown anywhere.";

// Per-route metadata so each page has a distinct title and its own canonical URL.
const META: Record<string, { title: string; desc: string }> = {
  "/": { title: "executable.md — markdown that runs", desc: DEFAULT_DESC },
  "/docs": {
    title: "Getting started · executable.md docs",
    desc:
      "Install the xmd binary and run your first executable markdown document.",
  },
  "/docs/components": {
    title: "Components · executable.md docs",
    desc:
      "Invoke markdown files as JSX-style components with typed inputs and slots.",
  },
  "/docs/exec-eval": {
    title: "Exec & Eval · executable.md docs",
    desc:
      "Run fenced code blocks as subprocesses or in-process Effection operations, with modifier chains.",
  },
  "/docs/durability": {
    title: "Durable replay · executable.md docs",
    desc:
      "Journal every I/O operation so runs replay from where they left off after a crash.",
  },
  "/docs/providers": {
    title: "LLM providers · executable.md docs",
    desc:
      "Wire cloud and local models into a document with provider components and <Sample>.",
  },
  "/docs/reference": {
    title: "Reference · executable.md docs",
    desc:
      "CLI usage, the document model, and pointers to the full specification.",
  },
};

export default define.page(function App({ Component, url }) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const meta = META[path] ?? {
    title: "executable.md — markdown that runs",
    desc: DEFAULT_DESC,
  };
  const canonical = SITE + (path === "/" ? "/" : path);

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />

        <title>{meta.title}</title>
        <meta name="description" content={meta.desc} />
        <link rel="icon" type="image/svg+xml" href={FAVICON} />
        <link rel="canonical" href={canonical} />
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
        <meta property="og:title" content={meta.title} />
        <meta property="og:description" content={meta.desc} />
        <meta property="og:url" content={canonical} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={meta.title} />
        <meta name="twitter:description" content={meta.desc} />
      </head>
      <body>
        <Component />
      </body>
    </html>
  );
});
