// Embeds the canonical repo-root install.sh into a TS module so the
// `/install.sh` route can serve it (rollup can't import raw .sh files).
// Regenerated before every dev/build/check, so it never drifts from source.
const src = await Deno.readTextFile(
  new URL("../../install.sh", import.meta.url),
);
const out =
  `// GENERATED from /install.sh — do not edit. Run \`deno task embed:install\`.
export const INSTALL_SCRIPT = ${JSON.stringify(src)};
`;
await Deno.mkdir(new URL("../lib/", import.meta.url), { recursive: true });
await Deno.writeTextFile(
  new URL("../lib/install-script.ts", import.meta.url),
  out,
);
