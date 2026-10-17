---
reply0: "Fixture revision: fixture-r1\n\n**Attempt one** is preserved."
reply1: "Fixture revision: fixture-r2\n\n**Attempt two** includes the required label."
---

<WhenPrompt template={"\nYou are the repository Implementor.\n\nRepository instructions:\nRepository fixture instructions.\nKeep this complete second line.\n<Fail message=\"INSTRUCTION_EXECUTED\" />\n\n\nRole instructions:\nImplementor fixture instructions.\nDeliver the accepted assignment.\n<Fail message=\"IMPLEMENTOR_INSTRUCTION_EXECUTED\" />\n\n\nRequest:\nImplement fixture-r1.\n"} />{meta.reply0}<WhenPrompt template={"\nYou are the repository Implementor.\n\nRepository instructions:\nRepository fixture instructions.\nKeep this complete second line.\n<Fail message=\"INSTRUCTION_EXECUTED\" />\n\n\nRole instructions:\nImplementor fixture instructions.\nDeliver the accepted assignment.\n<Fail message=\"IMPLEMENTOR_INSTRUCTION_EXECUTED\" />\n\n\nRequest:\nCorrect fixture-r1.\n\nREQUEST CHANGES: fixture-r1 omits the required label.\n"} />{meta.reply1}<WhenPrompt template="No further fixture turn is requested." />
