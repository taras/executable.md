import { define } from "../utils.ts";

const SITE = "https://executable.md";

const THEME_SCRIPT =
  `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

// static/favicon.svg — the ink tile: `x` on near-black, over an accent rule.
const FAVICON = "/favicon.svg";

const DEFAULT_TITLE =
  "executable.md — turn documentation into repeatable workflows";

const DEFAULT_DESC =
  "executable.md keeps procedures readable as Markdown, then gives them reusable components, typed inputs, and executable steps so the same process can run consistently.";

// Per-route metadata so each page has a distinct title and its own canonical URL.
const META: Record<string, { title: string; desc: string }> = {
  "/": {
    title: "executable.md — turn repeatable work into programs",
    desc:
      "Turn repeatable work into readable Markdown programs. Encode what you already know how to do, and use agents only where judgment remains.",
  },
  "/docs": {
    title: "Getting started · executable.md docs",
    desc:
      "Install the xmd binary and run your first executable markdown document.",
  },
  "/docs/components": {
    title: "Components · executable.md docs",
    desc:
      "Invoke markdown files as JSX-style components with typed props and slots.",
  },
  "/docs/exec-eval": {
    title: "Exec & Eval · executable.md docs",
    desc:
      "Run fenced code blocks as subprocesses or in-process Effection operations, with modifier chains.",
  },
  "/docs/providers": {
    title: "LLM providers · executable.md docs",
    desc:
      "Wire cloud and local models into a document with provider components and <Sample>.",
  },
  "/docs/agents": {
    title: "Coding agents · executable.md docs",
    desc:
      "Run an ACP-compatible coding agent from executable markdown and test the integration deterministically.",
  },
  "/docs/reference": {
    title: "Reference · executable.md docs",
    desc:
      "CLI usage, the document model, and pointers to the full specification.",
  },
};

export default define.page(function App({ Component, url }) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const meta = META[path] ?? { title: DEFAULT_TITLE, desc: DEFAULT_DESC };
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
          content="#fffdf5"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#131210"
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
