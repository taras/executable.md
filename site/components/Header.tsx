import { Wordmark } from "./Wordmark.tsx";
import ThemeToggle from "../islands/ThemeToggle.tsx";

const GITHUB = "https://github.com/taras/executable.md";

const LINK =
  "font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--fg);";
const LINK_ACTIVE =
  "font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--accent-strong);border-bottom:var(--rule) solid var(--accent-strong);padding-bottom:1px;";

/** `active` marks the top-level section the current page belongs to. */
export function Header({ active }: { active?: "docs" } = {}) {
  return (
    <header style="position:sticky;top:0;z-index:50;background:var(--bg);border-bottom:var(--rule) solid var(--ink);">
      <div
        class="container"
        style="display:flex;align-items:center;justify-content:space-between;height:3.5rem;gap:1rem;"
      >
        <a href="/">
          <Wordmark size="1rem" />
        </a>
        <nav style="display:flex;align-items:center;gap:1.125rem;font-size:0.8125rem;">
          <a href="/#features" class="nav-hide" style={LINK}>Features</a>
          <a href="/#example" class="nav-hide" style={LINK}>Example</a>
          <a href="/docs" style={active === "docs" ? LINK_ACTIVE : LINK}>
            Docs
          </a>
          <a href={GITHUB} style={LINK} rel="noopener">GitHub ↗</a>
          <ThemeToggle />
        </nav>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@media (max-width:640px){.nav-hide{display:none;}} header nav a:hover{color:var(--accent-strong);}",
        }}
      />
    </header>
  );
}
