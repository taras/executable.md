# Anthropic Node.js SDK messages API reference

The `@anthropic-ai/sdk` package exposes a fully typed `messages.create()` method that returns `APIPromise<Message>` by default (non-streaming) or `APIPromise<Stream<RawMessageStreamEvent>>` when `stream: true`. The response text lives at **`response.content[0].text`**. The SDK reads the **`ANTHROPIC_API_KEY`** environment variable automatically and handles all required HTTP headers (`x-api-key`, `anthropic-version: 2023-06-01`, `content-type`) internally.

---

## Client instantiation and constructor options

```typescript
import Anthropic from '@anthropic-ai/sdk';

// Minimal — reads ANTHROPIC_API_KEY from env automatically
const client = new Anthropic();

// Explicit configuration
const client = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],   // default env var
  baseURL: 'https://api.anthropic.com',       // default
  maxRetries: 2,                               // default
  timeout: 600_000,                            // 10 min default; scales with max_tokens
  dangerouslyAllowBrowser: false,              // must be true for browser use
  logLevel: 'warn',                            // 'off' | 'error' | 'warn' | 'info' | 'debug'
  fetch: globalThis.fetch,                     // custom fetch impl
  fetchOptions: {},                            // RequestInit passthrough
  defaultHeaders: {},                          // added to every request
  defaultQuery: {},                            // added to every request
});
```

The constructor type is `ClientOptions`. Environment variables: **`ANTHROPIC_API_KEY`** (API key), `ANTHROPIC_BASE_URL` (base URL override), `ANTHROPIC_LOG` (log level). If `ANTHROPIC_API_KEY` is set, the `apiKey` option can be omitted entirely.

---

## Exact TypeScript types for request parameters

`messages.create()` accepts `MessageCreateParams`, a union of non-streaming and streaming variants. Three fields are **required**: `model`, `max_tokens`, and `messages`.

```typescript
type MessageCreateParams = MessageCreateParamsNonStreaming | MessageCreateParamsStreaming;

interface MessageCreateParamsBase {
  model: Model;                                // required — e.g. 'claude-sonnet-4-5-20250929'
  max_tokens: number;                          // required — minimum: 1
  messages: Array<MessageParam>;               // required — limit: 100,000

  system?: string | Array<TextBlockParam>;     // top-level param, NOT a message role
  temperature?: number;                        // 0.0–1.0, default 1.0
  top_p?: number;                              // 0.0–1.0
  top_k?: number;                              // minimum: 0
  stop_sequences?: Array<string>;
  metadata?: Metadata;                         // { user_id?: string }
  tools?: Array<ToolUnion>;
  tool_choice?: ToolChoice;
  thinking?: ThinkingConfigParam;
  service_tier?: 'auto' | 'standard_only';
}

interface MessageCreateParamsNonStreaming extends MessageCreateParamsBase {
  stream?: false;
}

interface MessageCreateParamsStreaming extends MessageCreateParamsBase {
  stream: true;
}
```

### MessageParam (each element in the `messages` array)

```typescript
interface MessageParam {
  role: 'user' | 'assistant';
  content: string | Array<ContentBlockParam>;
}
```

There is **no `"system"` role**. System prompts use the top-level `system` parameter, which accepts either a plain `string` or an `Array<TextBlockParam>` (the array form enables prompt caching via `cache_control`):

```typescript
// String form
system: "You are a helpful assistant."

// Array form (for prompt caching)
system: [{ type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } }]
```

### ContentBlockParam (input content block union)

When `content` is an array rather than a string, each element is one of:

```typescript
type ContentBlockParam =
  | TextBlockParam          // { type: 'text', text: string, cache_control?, citations? }
  | ImageBlockParam         // { type: 'image', source: Base64ImageSource | URLImageSource }
  | DocumentBlockParam      // { type: 'document', source: ... }
  | ToolUseBlockParam       // { type: 'tool_use', id: string, name: string, input: object }
  | ToolResultBlockParam    // { type: 'tool_result', tool_use_id: string, content?, is_error? }
  | ThinkingBlockParam      // { type: 'thinking', thinking: string, signature: string }
  | RedactedThinkingBlockParam
  | SearchResultBlockParam
  | ServerToolUseBlockParam
  | WebSearchToolResultBlockParam;
```

### Model type

`Model` is a union of known string literals plus `(string & {})` to allow arbitrary model IDs:

```typescript
type Model =
  | 'claude-sonnet-4-5-20250929' | 'claude-sonnet-4-5'
  | 'claude-opus-4-5-20251101'   | 'claude-opus-4-5'
  | 'claude-opus-4-1-20250805'
  | 'claude-opus-4-0'            | 'claude-opus-4-20250514'
  | 'claude-sonnet-4-20250514'   | 'claude-sonnet-4-0'
  | 'claude-haiku-4-5'           | 'claude-haiku-4-5-20251001'
  | 'claude-3-5-haiku-latest'    | 'claude-3-5-haiku-20241022'
  | 'claude-3-opus-latest'       | 'claude-3-opus-20240229'
  | (string & {});
```

---

## Response shape and where the text lives

`messages.create()` (non-streaming) resolves to a `Message`:

```typescript
interface Message {
  id: string;                        // "msg_013Zva2CMHLNnXjNJJKqJ2EF"
  type: 'message';                   // always "message"
  role: 'assistant';                 // always "assistant"
  content: Array<ContentBlock>;      // ← text lives here
  model: Model;
  stop_reason: StopReason | null;    // 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal'
  stop_sequence: string | null;
  usage: Usage;
  _request_id?: string;              // SDK-injected from response header
}
```

**`content` is always an array**, never a plain string. For a simple text response, extract it with:

```typescript
const message = await client.messages.create({ ... });
const text = message.content[0].text;  // when content[0].type === 'text'
```

The `ContentBlock` union for response blocks:

```typescript
type ContentBlock =
  | TextBlock                  // { type: 'text', text: string, citations: TextCitation[] | null }
  | ThinkingBlock              // { type: 'thinking', thinking: string, signature: string }
  | RedactedThinkingBlock      // { type: 'redacted_thinking', data: string }
  | ToolUseBlock               // { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
  | ServerToolUseBlock
  | WebSearchToolResultBlock;
```

The `Usage` object provides **`input_tokens`** and **`output_tokens`**, plus nullable `cache_creation_input_tokens` and `cache_read_input_tokens` for prompt caching.

---

## Streaming vs. non-streaming and method signatures

The SDK provides **three** calling patterns. The first two are overloads of `messages.create()`; the third is a separate `messages.stream()` method.

**Non-streaming (default)** returns `APIPromise<Message>`:

```typescript
const message: Anthropic.Message = await client.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello, Claude' }],
});
// message.content[0].text → string
```

**Low-level streaming** (`stream: true`) returns `APIPromise<Stream<RawMessageStreamEvent>>`, an async iterable with no accumulation (lower memory):

```typescript
const stream = await client.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const event of stream) {
  // event.type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping'
}
stream.controller.abort(); // cancel
```

**High-level streaming helper** (`messages.stream()`) returns a `MessageStream` with event emitters and message accumulation:

```typescript
const stream = client.messages.stream({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});

stream.on('text', (textDelta: string) => process.stdout.write(textDelta));
stream.on('message', (message: Message) => { /* final */ });

const finalMessage: Message = await stream.finalMessage(); // accumulated
const finalText: string = await stream.finalText();        // convenience
stream.abort(); // cancel
```

Key difference: `messages.stream()` accumulates the full `Message` in memory and exposes typed events (`text`, `thinking`, `inputJson`, `contentBlock`, `message`, `error`). `messages.create({ stream: true })` yields raw SSE events with no accumulation.

---

## Headers, API key, and error handling

The SDK handles all required HTTP headers automatically. For raw HTTP calls the requirements are `x-api-key`, `anthropic-version: 2023-06-01`, and `content-type: application/json` — but the SDK sets these internally.

All types are importable from the `Anthropic` namespace:

```typescript
import Anthropic from '@anthropic-ai/sdk';

const params: Anthropic.MessageCreateParams = { ... };
const msg: Anthropic.Message = await client.messages.create(params);
const block: Anthropic.TextBlock = msg.content[0] as Anthropic.TextBlock;
```

Errors extend `Anthropic.APIError` with typed subclasses: `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `RateLimitError` (429), and `InternalServerError` (≥500). The SDK retries **2 times** by default on 408, 409, 429, and ≥500 status codes.

## Conclusion

For the common non-streaming case, the entire flow is four lines: construct `new Anthropic()`, `await client.messages.create({ model, max_tokens, messages })`, read `response.content[0].text`. The `system` prompt is a top-level parameter (not a message role), `messages` alternate `user`/`assistant` roles with `content` as `string | ContentBlockParam[]`, and the response `content` is always an `Array<ContentBlock>` discriminated on `type`. The package version as of this writing is **0.78.0**, requires TypeScript ≥ 4.9, and runs on Node 20+, Deno, Bun, and edge runtimes.