// A Plugin that imports nothing at all, so every product can load it: a source
// checkout, the emitted npm package, and a compiled binary that has no
// checkout to resolve a package specifier through.
//
// Both lines are markers a subprocess test reads. The first proves that
// selecting a module runs its top level — loading is running — and the second
// proves that its install ran, and what it was told about the command.
console.error("external-fixture: loaded");

export default {
  name: "external-fixture",
  // deno-lint-ignore require-yield
  *install(request) {
    console.error(`external-fixture: installed for ${request.command}`);
    console.error(`external-fixture: argv ${JSON.stringify(request.args)}`);
    return undefined;
  },
};
