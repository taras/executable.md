import { Wordmark } from "./Wordmark.tsx";
import ThemeToggle from "../islands/ThemeToggle.tsx";

const GITHUB = "https://github.com/taras/executable.md";

export function Header() {
  return (
    <header style="position:sticky;top:0;z-index:50;backdrop-filter:blur(8px);background:color-mix(in srgb, var(--bg) 82%, transparent);border-bottom:1px solid var(--border);">
      <div
        class="container"
        style="display:flex;align-items:center;justify-content:space-between;height:3.5rem;gap:1rem;"
      >
        <a href="/" style="text-decoration:none;">
          <Wordmark size="1.05rem" />
        </a>
        <nav style="display:flex;align-items:center;gap:1.1rem;font-size:0.9rem;">
          <a href="/#features" class="muted nav-hide">Features</a>
          <a href="/#example" class="muted nav-hide">Example</a>
          <a href="/docs" class="muted">Docs</a>
          <a href={GITHUB} class="muted" rel="noopener">GitHub ↗</a>
          <ThemeToggle />
        </nav>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html: "@media (max-width:640px){.nav-hide{display:none;}}",
        }}
      />
    </header>
  );
}
