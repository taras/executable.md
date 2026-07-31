import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { CONTENT_SECURITY_POLICY, PAGE_SHELL, SECURITY_HEADERS } from "../src/page.ts";

describe("page shell", () => {
  it("is static, with no interpolation and no external URL", function* () {
    expect(PAGE_SHELL.includes("${")).toBe(false);
    expect(PAGE_SHELL.includes("http://")).toBe(false);
    expect(PAGE_SHELL.includes("https://")).toBe(false);
  });

  it("renders an empty root and same-origin client and stylesheet", function* () {
    expect(PAGE_SHELL).toContain(`<div id="root"></div>`);
    expect(PAGE_SHELL).toContain(`<link rel="stylesheet" href="theme.css">`);
    expect(PAGE_SHELL).toContain(`<script src="client.js"></script>`);
  });

  it("carries no inline script", function* () {
    // Every <script> names a same-origin src and has an empty body.
    for (const tag of PAGE_SHELL.match(/<script\b[^>]*>/g) ?? []) {
      expect(/\bsrc="[^"]+"/.test(tag)).toBe(true);
    }
    expect(/<script\b[^>]*>[^<]+<\/script>/.test(PAGE_SHELL)).toBe(false);
  });
});

describe("security headers", () => {
  it("fixes every header to its exact value", function* () {
    expect(SECURITY_HEADERS).toEqual({
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  });

  it("locks the content security policy to same-origin scripts and no other origin", function* () {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "style-src-attr 'unsafe-inline'; font-src data:; img-src 'self'; " +
        "connect-src 'self'; base-uri 'none'; form-action 'self'; " +
        "frame-ancestors 'none'",
    );
  });

  it("admits inline style attributes without loosening scripts or origins", function* () {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split("; ").map((directive) => {
        const [name, ...values] = directive.split(" ");
        return [name, values];
      }),
    );

    expect(directives.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY.includes("unsafe-eval")).toBe(false);
    expect(/(https?|blob):/.test(CONTENT_SECURITY_POLICY)).toBe(false);
    expect(CONTENT_SECURITY_POLICY.includes("*")).toBe(false);
  });

  it("admits data: for fonts and for nothing else", function* () {
    const directives = CONTENT_SECURITY_POLICY.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return { name, values };
    });

    expect(directives.find(({ name }) => name === "font-src")?.values).toEqual(["data:"]);
    expect(
      directives
        .filter(({ values }) => values.some((value) => value.includes("data:")))
        .map(({ name }) => name),
    ).toEqual(["font-src"]);
  });
});
