---
reply0: "# Implementor reply\n\n**Delivered** the slice.\n\n```text\nfixture evidence\n```"
---

<Output><WhenPrompt template={"\nYou are the repository Implementor.\n\nRepository instructions:\nRepository fixture instructions.\nKeep this complete second line.\n<Fail message=\"INSTRUCTION_EXECUTED\" />\n\n\nRole instructions:\nImplementor fixture instructions.\nDeliver the accepted assignment.\n<Fail message=\"IMPLEMENTOR_INSTRUCTION_EXECUTED\" />\n\n\nRequest:\nImplement the slice.\nReturn its evidence.\n"} />{meta.reply0}</Output>
