const DIVIDER = /^([-=_*])\1{19,}$/;

function isDivider(comment) {
  return comment.type === "Line" && DIVIDER.test(comment.value.trim());
}

function isNextLine(previous, next) {
  return next.loc.start.line === previous.loc.end.line + 1;
}

const noSectionDividerComments = {
  meta: {
    type: "layout",
    fixable: "code",
    messages: {
      forbidden: "Remove decorative section header.",
    },
  },

  create(context) {
    const source = context.sourceCode;

    return {
      Program() {
        const comments = source.getAllComments();

        for (let index = 0; index < comments.length - 2; index++) {
          const opening = comments[index];

          if (!isDivider(opening)) {
            continue;
          }

          let cursor = index + 1;

          while (
            cursor < comments.length &&
            comments[cursor].type === "Line" &&
            !isDivider(comments[cursor]) &&
            isNextLine(comments[cursor - 1], comments[cursor])
          ) {
            cursor++;
          }

          const hasTitle = cursor > index + 1;

          if (
            !hasTitle ||
            cursor >= comments.length ||
            !isDivider(comments[cursor]) ||
            !isNextLine(comments[cursor - 1], comments[cursor])
          ) {
            continue;
          }

          const closing = comments[cursor];

          context.report({
            loc: {
              start: opening.loc.start,
              end: closing.loc.end,
            },
            messageId: "forbidden",
            fix(fixer) {
              const lineStart =
                source.text.lastIndexOf("\n", opening.range[0] - 1) + 1;
              const nextNewline = source.text.indexOf(
                "\n",
                closing.range[1],
              );
              const lineEnd = nextNewline === -1
                ? source.text.length
                : nextNewline + 1;

              return fixer.removeRange([lineStart, lineEnd]);
            },
          });

          index = cursor;
        }
      },
    };
  },
};

export default {
  meta: { name: "executablemd" },
  rules: {
    "no-section-divider-comments": noSectionDividerComments,
  },
};
