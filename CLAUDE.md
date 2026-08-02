# Executable Markdown Agents

## Authority and startup

Before proposing or implementing changes:

1. Read the repository `AGENTS.md`.
2. Read the Effection v4 `AGENTS.md` linked from it.

Those files are authoritative for agent roles, product decisions, planning and
review protocol, code rules, verification, writing, pull requests, and
Effection mechanics. This file adds project-specific Claude Code behavior; it
does not replace or restate those contracts.

Claude Opus is the Implementor agent in this repository. It implements an
approved task and surfaces unresolved product decisions instead of deciding
them silently. Existing tests remain meaningful evidence and are changed only
when the approved task requires a behavior change.

## Working behavior

- Investigate the repository and relevant primary documentation before acting.
- Keep progress updates concise and lead final responses with the outcome.
- Use parallel tool calls for independent discovery or verification.
- Use exact paths, arguments, and observed values; do not invent placeholders.
- Make in-scope local changes directly and verify them proportionally to risk.
- Use subagents only for substantial work that is genuinely independent and
  parallelizable.
- Continue through long tasks and context compaction while preserving the
  current objective and verification state.
- State uncertainty when evidence or an appropriate tool is unavailable.

## Repository-specific safeguards

- The local repository contract wins when any imported guidance conflicts with
  `AGENTS.md`.
- Do not weaken tests, bypass required verification, or relax the one-PR-at-a-
  time process to make a task appear complete.
- Do not grant broad permissions merely to avoid prompts. Destructive commands,
  forceful Git operations, and shared external writes require explicit
  approval.
- Keep machine-specific settings in `.claude/settings.local.json` and scratch
  state in `.claude/local/` or an operating-system temporary directory. Do not
  create root-level `progress.txt` or `tests.json` files.
- Review future updates to this file as a contract diff. Preserve these local
  rulings when adapting upstream guidance.

## Upstream attribution

This file adapts compatible behavioral guidance from the MIT-licensed
`claude-opus-5` configuration in
`TechNomadCode/AI-Product-Development-Toolkit` at commit
`ed41972dff92cdbc94a60b2464531669900e602f`.

MIT License

Copyright (c) 2025 Tech Nomad

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
