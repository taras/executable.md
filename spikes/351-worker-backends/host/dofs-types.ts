// Type-only resolution for the vendored Cloudflare adapter.
//
// vendor/worker-shell/adapter.ts must stay byte-identical to upstream, and it
// imports its option types from "@cloudflare/dofs". Deno does not pair a
// file:-resolved npm package with its declarations, so deno.json scopes that
// specifier — inside vendor/ only — to this module. Every import the adapter
// makes from it is `import type`, erased before runtime.

export type {
  GrepOptions,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WorkspaceDirentResult,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStatResult,
  WriteFileContent,
  WriteFileOptions,
} from "./types/dofs.d.ts";
