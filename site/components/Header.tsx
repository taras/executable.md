import { Wordmark } from "./Wordmark.tsx";
import ThemeToggle from "../islands/ThemeToggle.tsx";

const GITHUB = "https://github.com/taras/executable.md";

const LINK =
  "font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink);";
const LINK_ACTIVE =
  "font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--green);border-bottom:var(--rule) solid var(--green);padding-bottom:1px;";

/** The home page's sections, in the order they appear on it. */
const SECTIONS = [
  { href: "/#readme", label: "README" },
  { href: "/#agent", label: "Agents" },
  { href: "/#runtime", label: "Runtime" },
  { href: "/#compose", label: "Compose" },
  { href: "/#durability", label: "Durability" },
  { href: "/#install", label: "Install" },
];

/** `active` marks the top-level section the current page belongs to. */
export function Header({ active }: { active?: "docs" } = {}) {
  return (
    <header style="position:sticky;top:0;z-index:50;background:var(--paper);border-bottom:var(--rule) solid var(--line);">
      <div
        class="container"
        style="display:flex;align-items:center;justify-content:space-between;height:3.5rem;gap:1rem;"
      >
        <a href="/">
          <Wordmark size="1rem" fold />
        </a>
        <nav style="display:flex;align-items:center;gap:1.125rem;font-size:0.8125rem;">
          {SECTIONS.map((s) => (
            <a key={s.href} href={s.href} class="nav-hide" style={LINK}>
              {s.label}
            </a>
          ))}
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
            "@media (max-width:900px){.nav-hide{display:none;}} header nav a:hover{color:var(--green);}",
        }}
      />
    </header>
  );
}
