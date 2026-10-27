---
reply0: "REQUEST CHANGES: fixture-r1 omits the required label."
reply1: "PASS: Planner reviewed fixture-r2."
---

<WhenPrompt template={"\nYou are the repository Planner.\n\nRepository instructions:\nRepository fixture instructions.\nKeep this complete second line.\n<Fail message=\"INSTRUCTION_EXECUTED\" />\n\n\nRole instructions:\nPlanner fixture instructions.\nCheck the acceptance evidence.\n<Fail message=\"PLANNER_INSTRUCTION_EXECUTED\" />\n\n\nRequest:\nReview fixture-r1.\n"} />{meta.reply0}<WhenPrompt template={"\nYou are the repository Planner.\n\nRepository instructions:\nRepository fixture instructions.\nKeep this complete second line.\n<Fail message=\"INSTRUCTION_EXECUTED\" />\n\n\nRole instructions:\nPlanner fixture instructions.\nCheck the acceptance evidence.\n<Fail message=\"PLANNER_INSTRUCTION_EXECUTED\" />\n\n\nRequest:\nReview fixture-r2.\n"} />{meta.reply1}<WhenPrompt template="No further fixture turn is requested." />
