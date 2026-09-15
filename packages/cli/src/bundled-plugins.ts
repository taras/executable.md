/**
 * The Plugins this distribution ships.
 *
 * One list, and the only module in the CLI that names a Plugin package. Every
 * other surface — the run assembly, `xmd syntax`, `<Plan>`'s validation, the
 * nested run host — reads what the installed Plugins declared rather than
 * importing a package of its own, which is what keeps "what this build ships"
 * a single reviewable decision.
 *
 * Bundled Plugins install before the ones `--plugin` selects, so an operator's
 * Plugin composes around them.
 *
 * This is a code decision and is deliberately separate from the asset embedding
 * `scripts/lib/compile.ts` performs: the import is what makes the Plugin
 * executable in a compiled binary, and the whole-package include is what keeps
 * its Markdown and documentation assets readable there. Neither is derived from
 * the other.
 */

import reviewPlugin from "@executablemd/code-review-agent";
import type { Plugin } from "@executablemd/core/api";

export const BUNDLED_PLUGINS: readonly Plugin[] = Object.freeze([reviewPlugin]);
