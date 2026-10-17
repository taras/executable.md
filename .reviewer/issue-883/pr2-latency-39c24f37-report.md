# Sidekick typing latency at 39c24f37

The growing chat is remeasured in full after every typed key, including while Bindings hides it. This is a measured cause of sluggishness. A real mounted command went from about 16 ms to about 152 ms per key after two replies containing 100 wrapped text lines. It drew one frame per key and no idle frames; the measured problem is the work inside each frame.

Reviewed source: `39c24f37fdb967c3aa90870f9b4e22e536dc0fec`, parent `d634b28b24afa9a16a0a10ec7906c09d924c9db9`, signature G / tarasm@gmail.com. The implementation worktree was clean before and after diagnosis. No production source, tracked test, dependency, cache configuration or lock was changed. Diagnostic files live only under ROOT `.reviewer/issue-883/pr2-latency-39c24f37-*`.

## Measured work

The frame probe uses the existing `useCountingRenderer`, the real Freedom tree, production `viewFor` and `commitReplFrame`, and the same source `createFitStore` the running program owns. It warms one frame, then changes only Draft five times. Its chat facts are detached display fixtures, so this probe isolates presentation cost rather than claiming an agent generated those facts.

Each row below reports the deterministic measurement-render count on every warmed frame and the median of five local wall times. All cases draw exactly one committed frame. These wall times were observed alongside other focused tests and are diagnostic comparisons, not portable performance thresholds.

| Selected chat content | Sidekick visible: measurements / median ms | Hidden by Bindings: measurements / median ms |
| --- | ---: | ---: |
| Empty | 5 / 1.91 | 5 / 1.40 |
| 20 short messages | 24 / 2.57 | 24 / 1.79 |
| 100 short messages | 104 / 5.53 | 104 / 4.12 |
| 200 short messages | 204 / 8.13 | 204 / 6.13 |
| 20 wrapping messages, 248 text characters each | 1,284 / 35.18 | 1,284 / 34.03 |

There is no warm-cache reduction for chat text: each of the five ordinary Draft changes repeats exactly the same measurement count. The source-reading cache remains warm throughout.

The mounted probe uses the existing `useMountedRepl` and `sendMessage`, the real command, repository, owner and provider, and the controlled agent transport. It sends one actual 20-line reply, then another actual 80-line reply, and types five individual Draft keys at each stage. It then selects Bindings and repeats without changing history. Timing ends when the terminal's first presentation arrives; polling is bounded and the fixture's terminal write still supplies its normal suspension.

| Actual mounted state | Median input-to-first-presentation | Presentations per typed key | Presentations during 100 ms idle |
| --- | ---: | ---: | ---: |
| Empty chat | 15.56 ms | 1 | 0 |
| One reply with 20 wrapping lines | 39.25 ms | 1 | 0 |
| Two replies totaling 100 wrapping lines | 151.97 ms | 1 | 0 |
| Same two replies, Bindings selected | 150.98 ms | 1 | 0 |

These are real multiline replies saved by the command, not 100 requests or 100 provider sessions. The measured Draft remains correct after every sequence.

## Cause and path

1. `program.ts:1499` drains the pending input/session wakes as a batch. An ordinary typed key is dispatched and reduced. The existing `readsGeometry` guard at `program.ts:1263` already avoids a separate pre-action geometry measurement for typing.
2. The batch still paints through `program.ts:1709`. `commitReplFrame` calls `prepareFrame` for that presentation.
3. `program.ts:3325–3337` chooses a chat width and unconditionally calls `fitPlain(sidekickChatLines(view.live.sidekick))` whenever that width is positive. It does not test whether this frame shows Sidekick. A wide frame with Bindings selected still has a positive inspection width.
4. `fitting.ts:469` fits every logical chat line, including lines above the visible window. There is no retained plain-text geometry argument or cache lookup. By contrast, `prepareReading` at `fitting.ts:311` checks its retained store before measuring the entry reading.
5. `fitLine` at `fitting.ts:527` measures each full nonempty line through the actual rendering engine. A wrapping line enters `cutAt` at `fitting.ts:581`, which repeatedly measures prefixes while searching grapheme boundaries. Those searches are repeated for every wrapped piece. Twenty moderately long messages therefore turn one typing frame into 1,284 measurement renders.
6. The chat's complete fitted list is then used for row counts, window admission and descriptions. That shared list is correct for layout, but fitting it again does no useful work when its input text and measured width have not changed.

There is secondary repeated allocation/composition: `sidekickReadingOf` maps saved rows again, and the presentation composes chat rows for measurement, admission and drawing. This diagnosis does not assign a separate wall-time share to that work. The renderer counts establish an independently sufficient bottleneck without treating every repeated function call as another finding.

## Notifications and invalidation

The observed idle command does not continuously repaint. The wake queue at `program.ts:472` batches already pending wakes. The owner's observation path checks whether rendered preview text changed (`owner.ts:767`) before announcing it. Genuine preview changes, canonical publication and evaluation transitions intentionally wake the screen, so they also pay the full-history fitting cost, but no runaway notification loop was needed to reproduce the delay.

Focus changes can legitimately cause a second paint (`program.ts:1725`), and actions changing offered controls can remount through `program.ts:1202`. Each would repeat the current uncached fit. The stable-focus typing scenarios above needed neither: all twenty measured keys produced exactly one presentation. Changing the notification architecture is not supported as the first remedy by this evidence.

## Smallest candidate correction

Keep the existing measured-width and grapheme-safe fitting behavior, and retain its plain-text cuts in the command's frame lifetime. Skip chat fitting when this frame presents no chat window. On a frame that does present it, reuse cuts whose exact text and measured inputs have not changed. A small per-line retained cut store also avoids refitting old messages when only the newest preview line grows; an entire-list-only cache would fix ordinary typing but still remeasure all older messages on every new delta.

The existing `ReplFitStore` establishes the right ownership and exact-input comparison pattern, but cannot simply be passed to `fitPlain`: its geometry includes the entry rail/status reservation and it holds one entry reading. Sharing that one slot between entry and chat would also make the two evict each other. Factor or mirror its private cut-retention mechanism for plain text, with separate owned storage; no new provider, durable record, timer or global cache is needed.

Cache inputs must include exact text, available width and every engine size input currently affecting fitting. Preserve keys when decorating retained cuts, evict obsolete lines rather than accumulating all prior previews, and keep one fitted list authoritative for descriptions, admission, scrolling and Sessions reveal. Switching chats, resizing and replacing a preview must not reuse another text's cuts. Hidden text must be fitted afresh or read from a valid retained answer when made visible. Unicode cell widths must continue to come from the actual engine; replacing them with string length would trade responsiveness for incorrect wrapping.

A focused implementation witness can compare the actual measurement counts of warmed unchanged short/long chats after Draft and Message typing; prove hidden chat adds no fitting work; then append or grow one preview line and show that unchanged prior lines are reused while visible output and row counts stay correct. Absolute millisecond assertions are unnecessary.

## Reproduction and retained first outputs

From the implementation worktree:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-latency-39c24f37-frame-probe.test.ts
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-latency-39c24f37-mounted-probe.test.ts
```

Both corrected probes pass, each one test / one step. `frame-first.log` preserves the diagnostic's initial TypeScript narrowing error; a local narrowed model binding fixes the probe only, with the successful run in `frame-corrected.log`. `mounted-first.log` preserves the diagnostic helper's timeout: its second message was longer than the visible composer width, so `sendMessage` could not find the whole text. Shortening only that test message to `more` fixes the diagnostic; `mounted-corrected.log` retains all four mounted measurements. Neither initial failure was a product failure or an unchanged rerun counted as flake recovery.

No performance correction is implemented or committed by this diagnosis. Header, spelling, chat-following correctness review and delivery remain the parent Planner's separate work.
