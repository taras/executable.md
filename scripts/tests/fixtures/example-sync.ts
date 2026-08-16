/** Synchronous functions of this repository's own that touch no filesystem. */
export function exampleSync(input: string): string {
  return input.trim();
}

export function processSync(input: string): string {
  return input.toUpperCase();
}

/** Named for a filesystem export, exported by something that is not one. */
export function readFileSync(input: string): string {
  return input.toUpperCase();
}
