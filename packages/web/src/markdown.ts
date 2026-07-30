/**
 * The body boundary: a document's Markdown as HTML the form page can hold.
 *
 * A WebForm's body is written by whoever wrote the document, and a document may
 * have generated it — from an agent's answer, a file it read, a command's output.
 * So the body is treated as untrusted input to the page, and two independent
 * things stand between it and the DOM.
 *
 * The first is the conversion itself. `remark-rehype` does not carry raw HTML
 * across from Markdown unless it is asked to, and it is not asked to here: no
 * `allowDangerousHtml`, and no `rehype-raw` to parse what it dropped. An author's
 * `<div>`, `<script>`, or `<img onerror=…>` is gone before any allowlist runs.
 *
 * The second is `rehype-sanitize`, against a fixed allowlist written out in full
 * below rather than derived from the package default. It is the **last**
 * transformation before serialization, which is what the sanitizer's own guidance
 * requires: a plugin that ran after it could reintroduce exactly what it removed.
 *
 * ## Threat model
 *
 * This boundary protects the form page from untrusted or generated body content
 * and from unrelated local web origins. Such content cannot execute code, read
 * local files, issue external requests, navigate the form away, or reach any
 * route but the authorized submission. It is **not** a sandbox against the
 * document's author or the host process: both already hold execution authority
 * over the machine, and nothing here reduces that.
 *
 * ## Images
 *
 * An image survives only if its source is token-relative — resolvable beneath the
 * form's own token-scoped path and nowhere else. Absolute, root-relative,
 * protocol-relative, parent-traversing, backslash-bearing, and scheme-bearing
 * sources all lose their `src`.
 *
 * Two things enforce that, because neither alone is enough. `confineImageSources`
 * runs before the sanitizer and is the real check: the sanitizer's `protocols`
 * list only inspects sources that carry a scheme, so `/root.png` and
 * `//host/x.png` pass it untouched. The sanitizer's own list is then set to a
 * scheme that cannot occur, so no scheme-bearing source can survive it either —
 * an empty list would not do, because `hast-util-sanitize` reads an empty
 * allowlist as no constraint at all.
 *
 * Even a surviving source resolves only if a route serves it, and the fixed route
 * table serves the shell, the client, the stylesheet, the configuration, the
 * validator, and the submission — nothing else. There is no asset route, so in
 * practice an author's image does not load. That is the intended state, not an
 * omission.
 */

import { remark } from "remark";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

/**
 * A scheme no source can carry, so `protocols.src` constrains rather than
 * permits. `hast-util-sanitize` skips the check for an empty list.
 */
const NO_SCHEME = "webform.no-scheme";

/**
 * The complete allowlist. Everything absent is removed.
 *
 * `className` is absent, so a fenced block's `language-…` class is dropped along
 * with every other class: the page's styling is the theme's, not the body's.
 * `id` is absent too — an identifier in the body could collide with the form's
 * own elements and change what a label or a fragment refers to.
 */
const SANITIZE_SCHEMA = {
  tagNames: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "em",
    "strong",
    "blockquote",
    "ul",
    "ol",
    "li",
    "code",
    "pre",
    "hr",
    "br",
    "a",
    "img",
  ],
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
  },
  protocols: {
    href: ["http", "https", "mailto"],
    src: [NO_SCHEME],
  },
  strip: ["script", "style"],
  clobber: [],
  clobberPrefix: "",
  ancestors: {},
  required: {},
  allowComments: false,
  allowDoctypes: false,
};

const processor = remark()
  .use(remarkRehype)
  .use(confineImageSources)
  .use(rehypeSanitize, SANITIZE_SCHEMA)
  .use(rehypeStringify)
  .freeze();

/**
 * Render a document's Markdown body to sanitized HTML.
 *
 * Synchronous, because every stage is: the caller is a component's expansion, and
 * rendering the body must not be a suspension point between the checks that
 * precede it and the work that follows.
 */
export function renderBody(markdown: string): string {
  return String(processor.processSync(markdown));
}

/**
 * Strip every image source that is not token-relative.
 *
 * The tree is walked structurally and narrowed by runtime checks rather than by a
 * declared `hast` type, so the plugin needs no type dependency and no assertion.
 */
function confineImageSources(): (tree: unknown) => void {
  return function transform(tree: unknown): void {
    visit(tree);
  };
}

function visit(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }
  if (node.type === "element" && node.tagName === "img" && isRecord(node.properties)) {
    const source = node.properties.src;
    if (typeof source !== "string" || !isTokenRelative(source)) {
      delete node.properties.src;
    }
  }
  const { children } = node;
  if (Array.isArray(children)) {
    for (const child of children) {
      visit(child);
    }
  }
}

/**
 * Whether a source resolves beneath the form's own token-scoped path.
 *
 * The source arrives percent-encoded: `mdast-util-to-hast` encodes the
 * destination on its way into the tree, so an author's `img\back.png` is already
 * `img%5Cback.png` and their space is already `%20` by the time this runs.
 * Judging only the encoded text would therefore miss most of what this is meant
 * to catch — including `%2e%2e/`, which the URL parser normalizes to `../`
 * exactly as if it had been written that way.
 *
 * So both forms are judged and both must pass: the text as it will sit in the
 * attribute, and the text once decoded. One decode is the depth a browser
 * resolves at, and requiring the encoded form to pass as well means another
 * layer of encoding gets no further.
 */
function isTokenRelative(source: string): boolean {
  const decoded = decodeSource(source);
  if (decoded === undefined) {
    return false;
  }
  return isConfined(source) && isConfined(decoded);
}

/**
 * One form of a source, confined or not.
 *
 * Whitespace and control characters are refused outright: a browser strips or
 * ignores them inside a URL, so admitting them would let `java\nscript:` reach
 * the DOM as something this function did not read as a scheme.
 */
function isConfined(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  if (value.includes("\\")) {
    return false;
  }
  // Catches both an absolute path and a protocol-relative `//host/…`.
  if (value.startsWith("/")) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return false;
  }
  return !value.split("/").includes("..");
}

/** A source whose escapes are malformed cannot be reasoned about, so it fails. */
function decodeSource(source: string): string | undefined {
  try {
    return decodeURIComponent(source);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
