/**
 * @module
 *
 * The credential helper this package's Git invocations run.
 *
 * A separate entrypoint because it is an executable: Git starts it as its own
 * process and speaks the credential-helper protocol to it over standard IO.
 * Nothing that imports `@executablemd/git` loads this, and nothing here reaches
 * the rest of the package.
 */

export * from "./src/deno/composition/credential-helper.ts";
