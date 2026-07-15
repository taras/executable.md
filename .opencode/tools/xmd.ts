import { tool } from "@opencode-ai/plugin";
import { run } from "effection";
import { xmdRun } from "../../.internal/xmd-run.ts";

export const issues = tool({
  description:
    "Fetch cleanup issues from executable.md repo analysis. Returns GitHub issues " +
    "labeled 'cleanup' with file path, violation count, co-occurring " +
    "rules, and category breakdown. Each issue represents a file that needs " +
    "cleanup based on deterministic static analysis.",
  args: {
    number: tool.schema
      .number()
      .optional()
      .describe("Specific issue number to fetch. If omitted, returns all open cleanup issues."),
  },
  async execute(args, context) {
    const env: Record<string, string> = {};
    if (args.number) {
      env.ISSUE_NUMBER = String(args.number);
    }
    const output = await run(() =>
      xmdRun({
        docPath: ".internal/FetchIssues.md",
        env,
        signal: context.abort,
      }),
    );
    return output.trim();
  },
});
