import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { find } from "./find.js";
import { readFile } from "./readFile.js";
import { resolveInode } from "./resolve.js";
export async function grep(db, pattern, path, options = {}) {
    const { path: canonical } = canonicalizePath(path);
    const node = resolveInode(db, canonical);
    if (node === null) {
        throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    const filePaths = node.type === "file"
        ? [canonical]
        : find(db, canonical)
            .filter((entry) => entry.type === "file")
            .map((entry) => entry.path);
    const matches = [];
    for (const filePath of filePaths) {
        await scanFile(db, filePath, pattern, options, matches);
    }
    return matches;
}
// Stream the file in chunks so very large files don't load fully into
// memory. Carry a partial-line tail between chunks (everything after
// the last '\n') so a line that straddles a chunk boundary still
// matches as one line. Line numbers are 1-indexed.
async function scanFile(db, path, pattern, options, out) {
    const stream = await readFile(db, path);
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const needle = options.ignoreCase ? pattern.toUpperCase() : pattern;
    let tail = "";
    let lineNo = 1;
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        if (value === undefined)
            continue;
        const text = tail + decoder.decode(value, { stream: true });
        const newlineIdx = text.lastIndexOf("\n");
        const ready = newlineIdx === -1 ? "" : text.slice(0, newlineIdx);
        tail = newlineIdx === -1 ? text : text.slice(newlineIdx + 1);
        if (ready.length > 0) {
            lineNo = scanLines(ready, lineNo, needle, options.ignoreCase === true, path, out);
        }
    }
    // Drain the decoder and scan whatever's left (final line without a
    // trailing newline).
    tail += decoder.decode();
    if (tail.length > 0) {
        scanLines(tail, lineNo, needle, options.ignoreCase === true, path, out);
    }
}
// Walk `block` line-by-line, push matches into `out`, return the next
// 1-indexed line number to use for the following block.
function scanLines(block, startLine, needle, ignoreCase, path, out) {
    let line = startLine;
    let cursor = 0;
    while (cursor <= block.length) {
        const next = block.indexOf("\n", cursor);
        const end = next === -1 ? block.length : next;
        const text = block.slice(cursor, end);
        const haystack = ignoreCase ? text.toUpperCase() : text;
        if (haystack.includes(needle)) {
            out.push({ path, line, text });
        }
        line += 1;
        if (next === -1)
            break;
        cursor = next + 1;
    }
    return line;
}
