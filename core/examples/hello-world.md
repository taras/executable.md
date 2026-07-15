---
title: Hello World
---

# {meta.title} from executable.md

This program uses Opus 4.5 and open-source llama3.2 model to tell jokes.

<AnthropicProvider model="claude-opus-4-5">
  <OllamaProvider model="llama3.2">
    <Instruction system="You are a creative comedian who combines wisdom with humor. Be concise.">
      <Sample model="llama3.2">
        Smart: <Sample prompt="Say something smart" model="claude-opus-4-5" />
        Joke: <Sample prompt="Tell me a joke" model="llama3.2" />
        Combine Smart and Joke to create one smart joke
      </Sample>
    </Instruction>
  </OllamaProvider>
</AnthropicProvider>
