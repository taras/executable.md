export function Wordmark(
  { size = "1.1rem", cursor = false }: { size?: string; cursor?: boolean },
) {
  return (
    <span class="wordmark" style={`font-size:${size}`}>
      <span>executable</span>
      <span class="md">.md</span>
      {cursor ? <span class="cursor" aria-hidden="true"></span> : null}
    </span>
  );
}
