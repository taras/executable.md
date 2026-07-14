import { Wordmark } from "./Wordmark.tsx";

const GITHUB = "https://github.com/taras/executable.md";

export function Footer() {
  return (
    <footer class="band" style="margin-top:4rem;">
      <div
        class="container"
        style="padding-block:2.5rem;display:flex;flex-wrap:wrap;gap:1.5rem;justify-content:space-between;align-items:center;"
      >
        <div>
          <Wordmark size="1rem" />
          <p class="muted" style="font-size:0.85rem;margin-top:0.4rem;">
            Markdown that runs — durable, executable workflows.
          </p>
        </div>
        <div style="display:flex;gap:1.4rem;font-size:0.9rem;flex-wrap:wrap;">
          <a href={GITHUB} rel="noopener">GitHub</a>
          <a
            href={`${GITHUB}/blob/main/specs/executable-mdx-spec.md`}
            rel="noopener"
          >
            Spec
          </a>
          <a href="https://frontside.com/effection" rel="noopener">Effection</a>
          <a href={`${GITHUB}/blob/main/LICENSE`} rel="noopener">MIT License</a>
        </div>
      </div>
    </footer>
  );
}
