/**
 * What the Git crash process and the test that drives it agree on.
 *
 * A module that starts nothing: the child's `main()` lives in the child's own
 * file, and importing a constant from there would run the child inside the test.
 */

/** The branch the killed process switches to, and never publishes. */
export const CRASH_BRANCH = "release";

/** What the checkout holds on each branch, so a reader says which one is there. */
export const MAIN_CONTENT = "main\n";
export const RELEASE_CONTENT = "release\n";

/** The pathspec the killed staging names, and the file it stages. */
export const CRASH_PATH = "added.txt";

/** The message the killed commit composes, and never records. */
export const CRASH_MESSAGE = "recorded by the crash child";

export function crashDocument(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Git.Switch branch="${CRASH_BRANCH}" />`,
    "</Repository>",
  ].join("\n");
}

/**
 * The staging half: a file this run wrote, and one command to stage it.
 *
 * The write commits in its own effect, so what the kill interrupts is the
 * staging alone — and a recovered database must hold the file and an index that
 * never saw it.
 */
export function addDocument(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<File path="${CRASH_PATH}">`,
    "fresh",
    "</File>",
    `<Git.Add paths="${CRASH_PATH}" />`,
    "</Repository>",
  ].join("\n");
}

/**
 * The commit half: a file, a staging, and one commit of what they produced.
 *
 * The write and the staging each commit in their own effect before the commit
 * begins, so what the kill interrupts is the commit alone — and a recovered
 * database must hold the staged file and a branch that never moved.
 */
export function commitDocument(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<File path="${CRASH_PATH}">`,
    "fresh",
    "</File>",
    `<Git.Add paths="${CRASH_PATH}" />`,
    `<Git.Commit message="${CRASH_MESSAGE}" as="recorded" />`,
    "</Repository>",
  ].join("\n");
}
