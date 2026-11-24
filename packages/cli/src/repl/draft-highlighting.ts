import { markdownStream } from "../../../core/src/markdown.ts";
import { sourceRuns } from "./presentation-text.ts";

/** Experimental draft styling; boundary decisions come from the execution tracker. */
export function draftHighlighter(source: string) {
  const stream = markdownStream(source, "", () => undefined, undefined);
  const lines: { start: number; end: number; code: boolean }[] = [];
  try {
    let start = 0;
    for (const text of source.split("\n")) {
      lines.push({ start, end: start + text.length, code: stream.line(start).code });
      start += text.length + 1;
    }
  } finally {
    stream.close();
  }
  return (text: string, offset = 0) => {
    const line = lines.find((one) => offset >= one.start && offset <= one.end);
    return line?.code ? [{ text, token: "markdown-code" } as const] : sourceRuns(text);
  };
}
