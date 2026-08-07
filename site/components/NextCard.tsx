/** The "next page in the docs" card that closes each documentation page. */
export function NextCard({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} class="next-card push">
      <span style="display:flex;flex-direction:column;gap:2px;">
        <span class="eyebrow">Next</span>
        <span style="font-size:1.0625rem;font-weight:800;letter-spacing:-0.01em;">
          {label}
        </span>
      </span>
      <span style="font-size:1.25rem;font-weight:800;">→</span>
    </a>
  );
}
