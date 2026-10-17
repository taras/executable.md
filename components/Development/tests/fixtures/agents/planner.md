---
reply0: "## Planner reply\n\nUse `focused evidence`.\n\n1. Implement\n2. Review"
---

<Output><WhenPrompt template={"\nYou are the repository Planner.\n\nRepository instructions:\nRepository fixture instructions.\nKeep this complete second line.\n<Fail message=\"INSTRUCTION_EXECUTED\" />\n\n\nRole instructions:\nPlanner fixture instructions.\nCheck the acceptance evidence.\n<Fail message=\"PLANNER_INSTRUCTION_EXECUTED\" />\n\n\nRequest:\nPlan the feature.\nFreeze its evidence.\n"} />{meta.reply0}</Output>
