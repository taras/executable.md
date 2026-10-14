import { remark } from "remark";
import { BANNED_WORDS } from "../banned-words.js";

export function bannedProseWords(source) {
  const forbidden = new Set(BANNED_WORDS.map((word) => word.toLowerCase()));
  const findings = [];

  function visit(node) {
    if (node.type === "text") {
      const start = node.position.start.offset;
      const text = source.slice(start, node.position.end.offset);
      for (const match of text.matchAll(/[\p{L}\p{N}_$]+/gu)) {
        if (forbidden.has(match[0].toLowerCase())) {
          findings.push({ word: match[0], offset: start + match.index });
        }
      }
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(remark().parse(source));
  return findings;
}
