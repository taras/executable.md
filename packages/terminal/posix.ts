/**
 * The POSIX host adapters.
 *
 * A host that can hand a child its own terminal installs the foreground
 * launcher from here, and a provider that needs process facts installs the
 * POSIX observation beside it. Nothing else in this package reaches a
 * platform primitive, so a host that is not POSIX installs something else and
 * imports none of this.
 */

export { installForegroundLauncher, installPosixProcessObservation, reap } from "./src/posix.ts";

export { NO_TERMINAL, NativeLauncherUnavailableError } from "./src/errors.ts";
