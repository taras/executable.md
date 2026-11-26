export interface ReplLaunch {
  readonly command: readonly string[];
  readonly directory?: string | undefined;
  readonly assignments?: Readonly<Record<string, string>>;
}

function quote(word: string): string {
  return "'" + word.replaceAll("'", "'\\''") + "'";
}

export function formatLaunchCommand(launch: ReplLaunch): string {
  const assignments = Object.entries(launch.assignments ?? {}).map(
    ([name, value]) => `${name}=${quote(value)}`,
  );
  const words = launch.command.map((word) =>
    /^[a-zA-Z0-9_./-]+$/.test(word) ? word : quote(word),
  );
  const command = [...assignments, ...words].join(" ");
  return launch.directory === undefined ? command : `cd ${quote(launch.directory)} && ${command}`;
}

export function formatReopenCommand(launch: ReplLaunch, location: string): string {
  return `${formatLaunchCommand(launch)} repl ${quote(location)}`;
}
