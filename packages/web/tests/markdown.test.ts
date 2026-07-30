import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { renderBody } from "../src/markdown.ts";

describe("markdown: ordinary structure survives", () => {
  it("renders headings, paragraphs, emphasis, and rules", function* () {
    const html = renderBody("# Review\n\nPlease *read* the **plan**.\n\n---\n");

    expect(html).toContain("<h1>Review</h1>");
    expect(html).toContain("<em>read</em>");
    expect(html).toContain("<strong>plan</strong>");
    expect(html).toContain("<hr>");
  });

  it("renders lists, blockquotes, and code", function* () {
    const html = renderBody("- one\n- two\n\n> quoted\n\n`inline`\n\n```js\nconst x = 1;\n```\n");

    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain("<pre><code>const x = 1;");
  });

  /**
   * A fenced block's language becomes `class="language-js"`, and `className` is
   * absent from the allowlist: the page's styling belongs to the theme, and a
   * class from the body could reach into it.
   */
  it("drops class and id attributes from the body", function* () {
    const html = renderBody("```js\nconst x = 1;\n```\n");

    expect(html.includes("class=")).toBe(false);
    expect(html.includes("language-js")).toBe(false);
    expect(html.includes("id=")).toBe(false);
  });
});

describe("markdown: raw HTML and active markup", () => {
  it("drops a raw element entirely", function* () {
    const html = renderBody("<div><p>injected</p></div>\n\nafter\n");

    expect(html.includes("<div>")).toBe(false);
    expect(html).toContain("after");
  });

  it("drops a script tag and never emits one", function* () {
    const html = renderBody("<script>globalThis.stolen = 1;</script>\n\nafter\n");

    expect(html.includes("<script")).toBe(false);
    expect(html).toContain("after");
  });

  it("drops an inline event handler with its element", function* () {
    const html = renderBody('<img src="x" onerror="globalThis.stolen = 1">\n\nafter\n');

    expect(html.includes("onerror")).toBe(false);
    expect(html.includes("<img")).toBe(false);
    expect(html).toContain("after");
  });

  it("drops navigation and document metadata", function* () {
    const html = renderBody(
      '<meta http-equiv="refresh" content="0;url=https://elsewhere.test">\n' +
        '<base href="https://elsewhere.test/">\n' +
        '<link rel="stylesheet" href="https://elsewhere.test/x.css">\n\nafter\n',
    );

    expect(html.includes("http-equiv")).toBe(false);
    expect(html.includes("<meta")).toBe(false);
    expect(html.includes("<base")).toBe(false);
    expect(html.includes("<link")).toBe(false);
    expect(html).toContain("after");
  });

  it("drops inline styles and style elements", function* () {
    const html = renderBody(
      '<style>body { display: none }</style>\n\n<p style="color:red">text</p>\n\nafter\n',
    );

    expect(html.includes("<style")).toBe(false);
    expect(html.includes("style=")).toBe(false);
    expect(html).toContain("after");
  });

  it("drops form controls", function* () {
    const html = renderBody(
      '<form action="https://elsewhere.test"><input name="decision"><button>Go</button></form>\n\nafter\n',
    );

    expect(html.includes("<form")).toBe(false);
    expect(html.includes("<input")).toBe(false);
    expect(html.includes("<button")).toBe(false);
    expect(html).toContain("after");
  });

  it("drops frames and embedded objects", function* () {
    const html = renderBody(
      '<iframe src="https://elsewhere.test"></iframe>\n<object data="x.swf"></object>\n' +
        '<embed src="x.swf">\n\nafter\n',
    );

    expect(html.includes("<iframe")).toBe(false);
    expect(html.includes("<object")).toBe(false);
    expect(html.includes("<embed")).toBe(false);
    expect(html).toContain("after");
  });

  it("drops HTML comments", function* () {
    const html = renderBody("<!-- hidden -->\n\nafter\n");

    expect(html.includes("<!--")).toBe(false);
    expect(html).toContain("after");
  });

  it("emits no external URL from any injected markup", function* () {
    const html = renderBody(
      '<script src="https://elsewhere.test/x.js"></script>\n' +
        '<img src="https://elsewhere.test/pixel.gif">\n' +
        '<iframe src="https://elsewhere.test"></iframe>\n\nafter\n',
    );

    expect(html.includes("elsewhere.test")).toBe(false);
  });
});

describe("markdown: links", () => {
  it("keeps http, https, and mailto destinations", function* () {
    const html = renderBody(
      "[a](https://example.test/x) [b](http://example.test/y) [c](mailto:a@example.test)\n",
    );

    expect(html).toContain('href="https://example.test/x"');
    expect(html).toContain('href="http://example.test/y"');
    expect(html).toContain('href="mailto:a@example.test"');
  });

  it("strips the destination of an unsafe protocol but keeps the text", function* () {
    for (const unsafe of [
      "javascript:globalThis.stolen=1",
      "data:text/html,<script>1</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      const html = renderBody(`[click](${unsafe})\n`);

      expect(html).toContain("click");
      expect(html.includes("href=")).toBe(false);
    }
  });
});

describe("markdown: image sources", () => {
  it("keeps a token-relative source", function* () {
    for (const source of ["a.png", "img/a.png", "deep/nested/a.png", "a.png?v=2", "a.png#frag"]) {
      const html = renderBody(`![alt](${source})\n`);

      expect(html).toContain(`src="${source}"`);
    }
  });

  it("strips every source that leaves the token path", function* () {
    const unsafe = [
      "/root.png",
      "//elsewhere.test/x.png",
      "https://elsewhere.test/x.png",
      "http://elsewhere.test/x.png",
      "data:image/png;base64,AAAA",
      "blob:http://localhost/abc",
      "file:///etc/passwd",
      "../parent.png",
      "img/../../escape.png",
      "img\\back.png",
      "custom-scheme:payload",
      // Only a decode reveals these: the URL parser normalizes %2e%2e to `..`,
      // and %2f to a separator.
      "%2e%2e/parent.png",
      "img%2f%2e%2e%2f%2e%2e%2fescape.png",
    ];

    for (const source of unsafe) {
      const html = renderBody(`![alt](${source})\n`);

      expect(html.includes("src=")).toBe(false);
      // The image itself remains, so the body still reads as it was written.
      expect(html).toContain("<img");
    }
  });

  it("strips a source carrying whitespace or control characters", function* () {
    // Markdown's angle-bracket destination admits a space, and the conversion
    // percent-encodes it before this package ever sees it.
    for (const source of ["<a b.png>", "<java\tscript:x>", "%20leading.png", "a%09b.png"]) {
      const html = renderBody(`![alt](${source})\n`);

      expect(html.includes("src=")).toBe(false);
    }
  });

  it("keeps alt and title", function* () {
    const html = renderBody('![the alt](a.png "the title")\n');

    expect(html).toContain('alt="the alt"');
    expect(html).toContain('title="the title"');
  });
});

describe("markdown: sanitization is last", () => {
  /**
   * The image pass runs before the sanitizer, so a source it kept must still
   * satisfy the sanitizer, and a source it removed must not be reintroduced.
   * Running the same body twice also shows rendering holds no state.
   */
  it("produces the same HTML on every render", function* () {
    const body = "# T\n\n![a](a.png) ![b](https://elsewhere.test/b.png)\n\n[l](javascript:x)\n";

    expect(renderBody(body)).toBe(renderBody(body));
  });

  it("leaves nothing that could execute or fetch", function* () {
    const html = renderBody(
      "# Review\n\n<script>1</script>\n\n<img src=x onerror=1>\n\n" +
        "[l](javascript:x)\n\n![i](https://elsewhere.test/p.gif)\n",
    );

    expect(/on[a-z]+=/.test(html)).toBe(false);
    expect(html.includes("<script")).toBe(false);
    expect(html.includes("javascript:")).toBe(false);
    expect(html.includes("https://")).toBe(false);
  });
});
