import { bannedProseWords } from "../lib/banned-words.js";

function annotationEnd(text, start) {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? "") && cursor < text.length) {
    cursor++;
  }
  if (text[cursor] !== "{") {
    return start;
  }
  let depth = 0;
  let quote;
  for (; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (quote) {
      if (character === "\\") {
        cursor++;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      if (--depth === 0) {
        return cursor + 1;
      }
    }
  }
  return start;
}

function prose(comment) {
  const characters = [];
  const offsets = [];
  const body = comment.value.slice(1);
  let offset = comment.range[0] + 3;

  for (const line of body.matchAll(/[^\n]*(?:\n|$)/g)) {
    const margin = /^\s*\* ?/.exec(line[0])?.[0].length ?? 0;
    for (let index = margin; index < line[0].length; index++) {
      characters.push(line[0][index]);
      offsets.push(offset + index);
    }
    offset += line[0].length;
  }

  // Annotation syntax and link targets name code; their descriptions remain prose.
  let text = characters.join("");
  text = text.replace(/\{@(?:link|linkcode|linkplain)\s+[^\s|}]+/g, (value) =>
    " ".repeat(value.length),
  );
  text = text.replace(/^[ \t]*@example\b[^]*?(?=^[ \t]*@[\w-]+|$(?![^]))/gm, (value) =>
    value.replace(/[^\r\n]/g, " "),
  );
  const original = text;
  for (const tag of original.matchAll(/^[ \t]*@([\w-]+)/gm)) {
    let end = annotationEnd(original, tag.index + tag[0].length);
    if (
      /^(?:param|arg|argument|property|prop|typedef|callback|template|typeParam|extends|implements|see)$/.test(
        tag[1],
      )
    ) {
      const name = /^[ \t]+(?:\[[^\]\n]*\]|[\w.$]+(?:[ \t]*,[ \t]*[\w.$]+)*)/.exec(
        original.slice(end),
      );
      end += name?.[0].length ?? 0;
    }
    text =
      text.slice(0, tag.index) +
      text.slice(tag.index, end).replace(/[^\r\n]/g, " ") +
      text.slice(end);
  }
  return { text, offsets };
}

export const noBannedJsdocWords = {
  meta: {
    type: "suggestion",
    messages: {
      forbidden:
        'Avoid "{{word}}" in prose; choose wording for its meaning (scripts/banned-words.js).',
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      Program() {
        for (const comment of source.getAllComments()) {
          if (comment.type !== "Block" || !source.text.startsWith("/**", comment.range[0])) {
            continue;
          }
          const { text, offsets } = prose(comment);
          for (const { word, offset } of bannedProseWords(text)) {
            const start = offsets[offset];
            context.report({
              loc: {
                start: source.getLocFromIndex(start),
                end: source.getLocFromIndex(start + word.length),
              },
              messageId: "forbidden",
              data: { word },
            });
          }
        }
      },
    };
  },
};
