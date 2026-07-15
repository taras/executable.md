import { define } from "../../utils.ts";
import { Header } from "../../components/Header.tsx";
import { Footer } from "../../components/Footer.tsx";

const NAV: { href: string; label: string }[] = [
  { href: "/docs", label: "Getting started" },
  { href: "/docs/components", label: "Components" },
  { href: "/docs/exec-eval", label: "Exec & Eval" },
  { href: "/docs/providers", label: "LLM providers" },
  { href: "/docs/reference", label: "Reference" },
];

export default define.page(function DocsLayout({ Component, url }) {
  const path = url.pathname.replace(/\/$/, "") || "/docs";
  return (
    <>
      <Header />
      <div
        class="container"
        style="display:grid;grid-template-columns:220px 1fr;gap:2.5rem;align-items:start;padding-block:2.5rem;"
      >
        <aside style="position:sticky;top:5rem;">
          <nav style="display:flex;flex-direction:column;gap:0.15rem;font-size:0.92rem;">
            <p class="eyebrow" style="margin-bottom:0.5rem;">Documentation</p>
            {NAV.map((n) => {
              const active = path === n.href.replace(/\/$/, "");
              return (
                <a
                  key={n.href}
                  href={n.href}
                  style={`padding:0.35rem 0.6rem;border-radius:0.4rem;text-decoration:none;${
                    active
                      ? "background:var(--bg-subtle);color:var(--accent-strong);font-weight:600;"
                      : "color:var(--fg-muted);"
                  }`}
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
