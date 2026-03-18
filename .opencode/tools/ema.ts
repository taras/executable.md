import { tool } from "@opencode-ai/plugin"

export const issues = tool({
  description:
    "Fetch cleanup issues from EMA repo analysis. Returns GitHub issues " +
    "labeled 'ema-cleanup' with file path, violation count, co-occurring " +
    "rules, and category breakdown. Each issue represents a file that needs " +
    "cleanup based on deterministic static analysis.",
  args: {
    number: tool.schema
      .number()
      .optional()
      .describe(
        "Specific issue number to fetch. If omitted, returns all open ema-cleanup issues.",
      ),
  },
  async execute(args, context) {
    const env: Record<string, string> = {}
    if (process.env.GITHUB_TOKEN) {
      env.GITHUB_TOKEN = process.env.GITHUB_TOKEN
    }
    if (args.number) {
      env.ISSUE_NUMBER = String(args.number)
    }
    const result =
      await Bun.$`deno run --allow-all .internal/exec.ts .internal/FetchIssues.md`
        .env(env)
        .cwd(context.worktree)
        .text()
    return result.trim()
  },
})
