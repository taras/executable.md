---
title: Hello World
---

# {meta.title} from EMA

<AnthropicProvider model="claude-opus-4-5">
  <OllamaProvider model="llama3.2">
    <Sample model="llama3.2">
      Smart: <Sample prompt="Say something smart" model="claude-opus-4-5" />
      Joke: <Sample prompt="Tell me a joke" model="llama3.2" />
      Combine Smart and Joke to create one smart joke
    </Sample>
  </OllamaProvider>
</AnthropicProvider>
