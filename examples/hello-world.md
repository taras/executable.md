---
title: Hello World
---

# {meta.title}

A self-contained example that starts Ollama, pulls a model,
and asks it to say hello.

<AnthropicProvider model="claude-sonnet-4-5">
  <OllamaProvider model="llama3.2">
    <Sample model="llama3.2">
      Smart: <Sample prompt="Say something smart" model="claude-sonnet-4-5" />
      Fart Joke: <Sample prompt="Tell me a fart joke" model="llama3.2" />
      Combine Smart and Fart Joke to create one smart fart joke
    </Sample>
  </OllamaProvider>
</AnthropicProvider>
