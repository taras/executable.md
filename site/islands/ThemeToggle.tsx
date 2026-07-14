import { useEffect, useState } from "preact/hooks";

export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    const isDark = attr
      ? attr === "dark"
      : globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ??
        false;
    setDark(isDark);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    const theme = next ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch { /* ignore */ }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle color theme"
      title="Toggle theme"
      style="background:none;border:1px solid var(--border);border-radius:0.5rem;width:2rem;height:2rem;cursor:pointer;color:var(--fg);display:inline-flex;align-items:center;justify-content:center;font-size:0.95rem;"
    >
      {dark === null ? "◐" : dark ? "☀" : "☾"}
    </button>
  );
}
