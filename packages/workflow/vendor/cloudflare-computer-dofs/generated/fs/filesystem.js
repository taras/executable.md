// WorkspaceFilesystem — class wrapper that binds a Database and a
// clock to the free fs/* functions.
//
// Every method here is a thin forward to the matching free
// function. The class exists so callers (host-side Workspace,
// in-container tools, tests) get a single instance to thread
// through their code rather than passing (db, now) pairs into
// every call.
//
// Free functions remain exported for internal callers — the
// apply paths in sync/* operate on a Database directly, and the
// in-package tests skip the class wrapper when they only need a
// single op.
import { chmod } from "./chmod.js";
import { find } from "./find.js";
import { grep } from "./grep.js";
import { ls } from "./ls.js";
import { mkdir } from "./mkdir.js";
import { readdir } from "./readdir.js";
import { readFile } from "./readFile.js";
import { readlink } from "./readlink.js";
import { rm } from "./rm.js";
import { lstat, stat } from "./stat.js";
import { symlink } from "./symlink.js";
import { writeFile } from "./writeFile.js";
export class WorkspaceFilesystem {
    db;
    now;
    constructor(db, options = {}) {
        this.db = db;
        this.now = options.now ?? Date.now;
    }
    readFile(path, optionsOrEncoding) {
        // Forward through the free function's overload set. The
        // individual overloads above let callers see the precise
        // return type for each input shape.
        // Cast through the union overload of the free function;
        // the class's overloads above carry the precise return type
        // for each input shape back to the caller.
        return readFile(this.db, path, optionsOrEncoding);
    }
    async stat(path) {
        return stat(this.db, path);
    }
    // POSIX lstat — like stat, but doesn't follow a trailing symlink.
    // Use when the caller wants to inspect the link itself: readlink
    // / unlink under a Node-style fs surface, or just-bash's adapter
    // routing lstat through to the workspace.
    async lstat(path) {
        return lstat(this.db, path);
    }
    // Return the stored target of a symlink. EINVAL when path is
    // not a symlink; ENOENT when path is missing.
    async readlink(path) {
        return readlink(this.db, path);
    }
    async readdir(path, options = {}) {
        return readdir(this.db, path, options);
    }
    async find(directory, pattern) {
        return find(this.db, directory, pattern);
    }
    async ls(prefix) {
        return ls(this.db, prefix);
    }
    grep(pattern, path, options = {}) {
        return grep(this.db, pattern, path, options);
    }
    // --- Mutations ---------------------------------------------------
    writeFile(path, content, options = {}) {
        return writeFile(this.db, path, content, options, this.now);
    }
    async mkdir(path, options = {}) {
        mkdir(this.db, path, options, this.now);
    }
    async rm(path, options = {}) {
        rm(this.db, path, options);
    }
    // Change the permission bits on a path. Follows symlinks like
    // POSIX chmod — the change lands on the target, not the link.
    // The supplied mode is masked to twelve bits.
    async chmod(path, mode) {
        chmod(this.db, path, mode, this.now);
    }
    // Create a symbolic link at `path` pointing at `target`. The
    // target is stored verbatim; it can be relative or absolute and
    // is allowed to dangle.
    async symlink(target, path) {
        symlink(this.db, target, path, this.now);
    }
}
