import { Wordmark } from "./Wordmark.tsx";
import ThemeToggle from "../islands/ThemeToggle.tsx";

const GITHUB = "https://github.com/taras/executable.md";

const LINK =
  "font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink);";
const LINK_ACTIVE =
  "font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--green);border-bottom:var(--rule) solid var(--green);padding-bottom:1px;";

/** `active` marks the top-level section the current page belongs to. */
export function Header(
  { active }: { active?: "docs" | "workflows" } = {},
) {
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
          <a
            href="/designing-workflows"
            style={active === "workflows" ? LINK_ACTIVE : LINK}
          >
            Designing workflows
          </a>
          <a href="/docs" style={active === "docs" ? LINK_ACTIVE : LINK}>
            Docs
          </a>
          <a href={GITHUB} style={LINK} target="_blank" rel="noopener">
            GitHub ↗
          </a>
          <ThemeToggle />
        </nav>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html: "header nav a:hover{color:var(--green);}",
        }}
      />
    </header>
  );
}
