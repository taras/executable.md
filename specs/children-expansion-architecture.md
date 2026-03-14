# Children Expansion Architecture

**Status:** Reference document  
**Date:** 2026-03-14  
**Scope:** How components consume their children in Executable MDX

---

## 1. Context

When a markdown component is invoked with children:

```markdown
<Provider model="phi3">
  Some content here
  <Sample prompt="hello" />
</Provider>
```

…the expansion engine needs to get those children into the component's
body. There are **two mechanisms** for this, each serving a different
component archetype. This document describes how each works and why
they use different eval scopes.

---

## 2. Mechanism 1: `<Content />` (Term Rewriting)

### How it works

`<Content />` is a special component name recognized during content
substitution. When a component's body contains `<Content />`, it acts
as a **slot** — the caller's children are spliced into that position
before the body is expanded.

The flow:

```
1. Scanner parses the component body -> finds <Content /> -> produces ComponentInvocation{name: "Content"}
2. substituteContent() replaces every <Content /> with the raw children segments
3. expandSegments() processes the substituted body top-down, in document order
```

### Example: LlamafileProvider

```
LlamafileProvider.md body:

  ```ts eval
  const port = yield* findFreePort();
  ```

  ```bash daemon exec
  {command} --port {port}
  ```

  ```ts persist eval
  yield* Sample.around({ ... });     <- middleware installed
  ```

  <Content />                         <- children land here, expanded AFTER middleware
```

### Key properties

- **Document-order expansion**: Children expand at the `<Content />`
  position in the body. Code blocks before `<Content />` (like
  middleware installation) execute first.
- **Children use `childEvalScope`**: Because children are spliced
  into the body before expansion, they expand within the component's
  own eval scope. This means **children see middleware** installed by
  the component's `persist eval` blocks.
- **Children are NOT pre-expanded**: The implementation passes raw
  (unexpanded) children to `substituteContent()`. This is critical —
  if children were pre-expanded, they would run before the component's
  middleware is installed, breaking the provider pattern.
- **Lifecycle correctness**: Children's expansion lives within the
  component's structured concurrency scope (`childEvalScope`). When
  the component is torn down, everything tears down together.
- **No `<Content />` = children discarded**: If the component body
  has no `<Content />`, the children are silently dropped.

### Who uses it

All provider components: `LlamafileProvider`, `OllamaProvider`,
`AnthropicProvider`. These are "wrapper" components that install
middleware and then let children run within that middleware context.

---

## 3. Mechanism 2: `renderChildren()` (Programmatic Closure)

### How it works

`renderChildren()` is a **generator closure** injected into the
component's `env.values` during `expandComponent()`. Eval blocks in
the component body call it explicitly with `yield* renderChildren()`
to expand the children and get back a rendered string.

The flow:

```
1. expandComponent() creates the closure, capturing children segments and expansion context
2. The closure is placed in componentEnv.values.renderChildren
3. When the body's eval block calls yield* renderChildren(), the closure:
   a. Re-establishes EvalEnvCtx (componentEnv) and EvalScopeCtx (parentEvalScope)
   b. Calls expandSegments() on the captured children
   c. Calls renderSegments() on the result
   d. Returns the rendered string
```

### Example: Sample component

```
Sample.md body:

  ```js persist eval
  const childrenOutput = yield* renderChildren();   <- explicit call
  const content = childrenOutput || prompt || '';

  const sampleResult = yield* Sample.operations.sample({
    stdout: content,
    ...
  });

  output(sampleResult);
  ```
```

### Key properties

- **Programmatic control**: The component decides when (and whether)
  to expand children. It gets back a string, not segments.
- **Children use `parentEvalScope`**: Children are caller-provided
  content — they expand in the caller's scope context. The component's
  `childEvalScope` and its sequential channel are for the component's
  own `persist eval` blocks (middleware installation, etc.), not for
  expanding caller content.
- **Ancestor middleware is visible**: Inner components that children
  reference create their own child scopes off `parentEvalScope`, and
  ancestor middleware is visible through Effection's scope prototype
  chain.
- **Resources are lifecycle-scoped**: Children may contain operations
  that create resources (nested components, `persist eval` blocks,
  daemons), but those resources are scoped to the expansion — their
  lifecycle is bound by their place in the structured concurrency tree.

### Who uses it

The `Sample` component. It needs children as a **string** (to send to
an LLM), not as segments to splice into a body.

---

## 4. Why they use different eval scopes

The two mechanisms use different eval scopes because they serve
different purposes:

| Aspect | `<Content />` | `renderChildren()` |
|--------|--------------|-------------------|
| Purpose | Structural wrapping | Programmatic string capture |
| Eval scope | `childEvalScope` (component's own) | `parentEvalScope` (caller's) |
| Return type | Segments (spliced into body) | String (rendered output) |
| Expansion timing | During body expansion (document order) | When closure is called |

**`<Content />`** uses `childEvalScope` because it is structural
wrapping — children become part of the component's body and should
see middleware installed by the component's own `persist eval` blocks.
This is the provider pattern: install middleware, then expand children
within that middleware context.

**`renderChildren()`** uses `parentEvalScope` because it expands
caller-provided content. The component's `childEvalScope` sequential
channel is for the component's own `persist eval` blocks. Children
are not the component's own body — they belong to the caller's scope
context. Inner components that children reference create their own
child scopes off `parentEvalScope`, and ancestor middleware (installed
by enclosing providers) is visible through Effection's scope prototype
chain.

---

## 5. Both mechanisms operate on the same children

Both `<Content />` and `renderChildren()` receive the same `children`
segments — the raw segments parsed from the caller's invocation.

```typescript
// In expandComponent():

// 1. substituteContent replaces <Content /> with raw children
const substituted = substituteContent(body, children, meta, props);

// 2. renderChildren closure captures the same raw children
componentEnv.values.renderChildren = function* () {
  const expanded = yield* expandSegments(children, ...);
  return renderSegments(expanded);
};

// 3. The substituted body is expanded
return yield* expandSegments(substituted, ...);
```

A component that uses `<Content />` is a **wrapper** (like a
provider). A component that uses `renderChildren()` is a **consumer**
(like Sample). These are different component archetypes. There is no
reason for a component to use both.

---

## 6. Companion: `render(markdown)`

There is a sibling closure `render(markdown)` that works the same way
as `renderChildren()` but for arbitrary markdown strings rather than
the component's children. It scans the markdown into segments, then
expands and renders them in `parentEvalScope` — same rationale as
`renderChildren()`.

---

## 7. Summary

The expansion engine provides two mechanisms for children consumption:

- **`<Content />`** — structural term rewriting for wrapper components
  (providers). Children are spliced into the body and expand in
  `childEvalScope`, seeing the component's middleware.

- **`renderChildren()`** — programmatic string capture for consumer
  components (Sample). Children expand in `parentEvalScope` because
  they are caller-provided content. Resources created during expansion
  are lifecycle-scoped to their position in the structured concurrency
  tree. Ancestor middleware is visible through the scope prototype chain.

The two mechanisms use different eval scopes because they serve
different purposes, not as a workaround. `childEvalScope` is for the
component's own body and middleware. `parentEvalScope` is for
caller-provided content.
