import { Wordmark } from "./Wordmark.tsx";

const GITHUB = "https://github.com/taras/executable.md";

const LINK =
  "color:var(--ink);border-bottom:var(--rule) solid var(--line);padding-bottom:1px;";

export function Footer() {
  return (
    <footer style="margin-top:4rem;border-top:var(--rule) solid var(--line);background:var(--paper);">
      <div
        class="container"
        style="padding-block:2.25rem;display:flex;flex-wrap:wrap;gap:1.5rem;justify-content:space-between;align-items:center;"
      >
        <div style="display:flex;flex-direction:column;gap:0.375rem;">
          <Wordmark size="0.9375rem" />
          <p class="muted" style="font-size:0.8125rem;margin:0;">
            Turn documentation into repeatable workflows.
          </p>
        </div>
        <div style="display:flex;gap:1.375rem;font-size:0.8125rem;font-weight:700;flex-wrap:wrap;">
          <a href={GITHUB} style={LINK} rel="noopener">GitHub</a>
          <a
            href={`${GITHUB}/blob/main/specs/executable-mdx-spec.md`}
            style={LINK}
            rel="noopener"
          >
            Spec
          </a>
          <a href="https://frontside.com/effection" style={LINK} rel="noopener">
            Effection
          </a>
          <a href={`${GITHUB}/blob/main/LICENSE`} style={LINK} rel="noopener">
            MIT License
          </a>
        </div>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "footer a:hover{color:var(--green);border-bottom-color:var(--green);}",
        }}
      />
    </footer>
  );
}
