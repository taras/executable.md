import { Fragment } from "preact";
import type { ComponentChildren } from "preact";

/* The type scale the marketing pages set their prose at. Sizes carry their
 * own measure where the design gives them one, so a page states a style
 * rather than restating a stack of declarations. */

export const MONO = "font-family:var(--font-mono);";

export const H3 =
  "margin:0;font-size:1.0625rem;font-weight:800;letter-spacing:-0.01em;line-height:1.25;";
export const P_SM =
  "margin:0;font-size:0.875rem;line-height:1.6;color:var(--body);";
export const P_MD =
  "margin:0;max-width:74ch;font-size:0.9375rem;line-height:1.6;color:var(--body);";
export const P_MEASURED = `${P_SM}max-width:74ch;`;

/** A claim set at the weight of a heading, opening a panel or closing a list. */
export const CLAIM =
  "margin:0;font-size:1.0625rem;line-height:1.45;color:var(--ink);font-weight:800;letter-spacing:-0.01em;";

/** An inline bold lead-in inside a prose paragraph. */
export const STRONG = "font-weight:800;color:var(--ink);";

export const CHAIN_ITEM =
  `${MONO}font-size:0.8125rem;font-weight:700;color:var(--ink);`;

/** An inline identifier: monospace, at full contrast against body prose. */
export function Term({ children }: { children: ComponentChildren }) {
  return (
    <code style={`${MONO}font-weight:700;color:var(--ink);`}>{children}</code>
  );
}

/** A ruled arrow chain, e.g. `Repository → Worktree → Implementor`. */
export function Chain(
  { steps, boxed }: { steps: string[]; boxed?: boolean },
) {
  return (
    <div
      style={`display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;${
        boxed
          ? "border:var(--rule) solid var(--line);padding:0.75rem 0.875rem;"
          : "padding-top:0.125rem;"
      }`}
    >
      {steps.map((step, i) => (
        <Fragment key={step}>
          <span style={CHAIN_ITEM}>{step}</span>
          {i < steps.length - 1
            ? <span style="color:var(--dim);">→</span>
            : null}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The marketing pages close on a production note rather than the docs
 * footer's link set — see `Footer.tsx` for the one the docs carry.
 */
export function PageFooter() {
  return (
    <footer style="border-top:var(--rule) solid var(--line);padding:1.5rem 0;margin-top:1rem;">
      <div
        class="container"
        style={`${MONO}font-size:0.8125rem;color:var(--dim);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0.5rem 1rem;`}
      >
        <span>
          Made with ❤️{" "}
          <a href="https://frontside.com/effection/" rel="noopener">
            Effection
          </a>.
        </span>
        <span style="display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;">
          <a href="https://github.com/taras/executable.md" rel="noopener">
            GitHub ↗
          </a>
          <span aria-hidden="true">·</span>
          <a href="https://discord.gg/r9F5QrZrP" rel="noopener">Discord ↗</a>
        </span>
      </div>
    </footer>
  );
}
