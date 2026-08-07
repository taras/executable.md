import { define } from "../../utils.ts";
import { Header } from "../../components/Header.tsx";
import { Footer } from "../../components/Footer.tsx";

const NAV: { href: string; label: string }[] = [
  { href: "/docs", label: "Getting started" },
  { href: "/docs/components", label: "Components" },
  { href: "/docs/control-flow", label: "Control flow" },
  { href: "/docs/exec-eval", label: "Exec & Eval" },
  { href: "/docs/providers", label: "LLM providers" },
  { href: "/docs/agents", label: "Coding agents" },
  { href: "/docs/journal", label: "Journal gates" },
  { href: "/docs/reference", label: "Reference" },
];

export default define.page(function DocsLayout({ Component, url }) {
  const path = url.pathname.replace(/\/$/, "") || "/docs";
  return (
    <>
      <Header active="docs" />
      <div
        class="container"
        style="display:grid;grid-template-columns:220px minmax(0,1fr);gap:2.5rem;align-items:start;padding-block:2.5rem 4rem;"
      >
        <aside style="position:sticky;top:4.75rem;display:flex;flex-direction:column;gap:0.625rem;">
          <span class="eyebrow">Documentation</span>
          <nav class="doc-nav">
            {NAV.map((n) => {
              const active = path === n.href.replace(/\/$/, "");
              return (
                <a
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                >
                  {n.label}
                </a>
              );
            })}
          </nav>
        </aside>
        <main class="doc" style="min-width:0;max-width:74ch;">
          <Component />
        </main>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@media (max-width:768px){.container:has(aside){grid-template-columns:1fr !important;} aside{position:static !important;}}",
        }}
      />
      <Footer />
    </>
  );
});
