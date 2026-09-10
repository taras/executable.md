/**
 * What a POSIX host can actually observe and hand over
 * (architecture.md §Package ownership).
 *
 * The process table, process groups, signals, reachability and terminal holders
 * as `ps`, `lsof` and `kill` answer them, plus the foreground child that gives
 * a native program this run's own terminal. It lives here rather than in a
 * presentation provider because a second POSIX provider should reuse the same
 * proof without depending on tmux.
 *
 * Node and Bun install none of it: a host that cannot observe a pane refuses a
 * grid rather than reporting one free it never checked.
 */

export { installForegroundLauncher } from "./src/posix-launcher.ts";
export type { ForegroundLauncherOptions } from "./src/posix-launcher.ts";
export { installDenoTerminalProcesses, posixProcessProbes } from "./src/posix-processes.ts";
export type { ProcessProbes } from "./src/posix-processes.ts";
