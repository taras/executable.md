/**
 * How each runtime re-invokes this CLI.
 *
 * One builder per runtime-named entrypoint, each used by exactly one of them.
 * They are separate from those entrypoints because an entrypoint is a script —
 * importing one runs the CLI — and these are the part worth asserting on.
 *
 * Every builder appends `args` after its entry module, so a caller receives a
 * complete invocation rather than a prefix it has to extend correctly.
 * `entrypoint` is always an absolute path taken from the entry module's
 * `import.meta.url`, never `process.argv[1]`: the worker is launched from
 * wherever the document runs, and a path relative to the parent's working
 * directory would not resolve there.
 */

export function denoCommand(execPath: string, entrypoint: string, args: string[]): string[] {
  return [execPath, "run", "--allow-all", entrypoint, ...args];
}

/**
 * `execArgv` carries across the relaunch — a loader the parent needs, the
 * child needs too — except `--inspect`, which would make the worker exit
 * immediately on the debug port the parent already holds.
 */
export function nodeCommand(
  execPath: string,
  execArgv: string[],
  entrypoint: string,
  args: string[],
): string[] {
  return [
    execPath,
    ...execArgv.filter((option) => !option.startsWith("--inspect")),
    entrypoint,
    ...args,
  ];
}

export function bunCommand(execPath: string, entrypoint: string, args: string[]): string[] {
  return [execPath, entrypoint, ...args];
}

/** The compiled binary carries its own entry module: the executable is the command. */
export function compiledCommand(execPath: string, args: string[]): string[] {
  return [execPath, ...args];
}
