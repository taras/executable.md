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

export function crashDocument(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Git.Switch branch="${CRASH_BRANCH}" />`,
    "</Repository>",
  ].join("\n");
}
