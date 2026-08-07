/**
 * The wordmark. With `fold`, it rests as `executable.md` and collapses to
 * `xmd` on hover — the `x` is the hinge and never moves, so the mark folds
 * down to the command you actually type. The slot reserves the expanded
 * width, so the nav beside it does not shift.
 */
export function Wordmark(
  { size = "1.1rem", fold = false }: { size?: string; fold?: boolean },
) {
  return (
    <span
      class={fold ? "wordmark wordmark-fold" : "wordmark"}
      style={`font-size:${size}`}
    >
      {fold ? <span class="fold fold-step1">e</span> : <span>executable</span>}
      {fold ? <span>x</span> : null}
      {fold ? <span class="fold fold-rest">ecutable</span> : null}
      <span class="md">
        {fold ? <span class="fold fold-step1">.</span> : <span>.</span>}
        <span>md</span>
      </span>
    </span>
  );
}
