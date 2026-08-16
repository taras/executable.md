/** Filesystem members of the `Deno` global, one per surface the rule names. */
export function readTree(root: string): string[] {
  const names: string[] = [];

  for (const entry of Deno.readDirSync(root)) {
    names.push(entry.name);
  }

  const text = Deno.readTextFileSync(`${root}/manifest.json`);
  Deno.writeTextFileSync(`${root}/copy.json`, text);

  const info = Deno.lstatSync(root);
  const target = Deno.readLinkSync(`${root}/link`);
  const canonical = Deno.realPathSync(target);
  Deno.removeSync(`${root}/copy.json`);

  return [...names, String(info.isDirectory), canonical];
}

/** The same global reached through `globalThis`, and a member named by a string. */
export function readThroughGlobalThis(path: string): string {
  globalThis.Deno.makeTempDirSync({ prefix: "probe-" });
  return globalThis.Deno["readTextFileSync"](path);
}

/** A descriptor the global exposes, and one an opener bound directly. */
export function announce(path: string, bytes: Uint8Array): number {
  const written = Deno.stdout.writeSync(bytes);
  Deno.stderr.writeSync(bytes);

  const file = Deno.openSync(path, { write: true });
  file.writeSync(bytes);
  file.close();

  return written;
}

/** Running a subprocess is not filesystem work, whatever it is named. */
export function listProcesses(): Uint8Array {
  return new Deno.Command("ps", { args: ["-A"] }).outputSync().stdout;
}

/** A `Deno` of somebody's own is a different value. */
export function local(Deno: { readTextFileSync(path: string): string }, path: string): string {
  return Deno.readTextFileSync(path);
}
