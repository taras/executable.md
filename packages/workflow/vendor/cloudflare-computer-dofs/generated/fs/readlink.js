import { createWorkspaceError } from "../errors.js";
import { resolveInode } from "./resolve.js";
// Return the stored target of a symlink. Does not follow the link.
// Mirrors POSIX semantics: ENOENT for a missing path, EINVAL when
// the path resolves to something that isn't a symlink.
export function readlink(db, path) {
    const node = resolveInode(db, path, { followSymlinks: false });
    if (node === null) {
        throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    if (node.type !== "symlink" || node.linkTarget === undefined) {
        throw createWorkspaceError("EINVAL", `not a symlink: ${path}`, path);
    }
    return node.linkTarget;
}
