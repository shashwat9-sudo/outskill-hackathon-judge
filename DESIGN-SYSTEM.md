# Outskill Hackathon Portal: Design System Reference

This document describes the complete visual system of the Outskill group-allocator /
hackathon portal so a sister site can replicate it exactly. Copy the CSS block in
section 7 verbatim into your stylesheet, then follow the usage rules.

Character in one line: **refined dark, editorial serif headlines, warm orange accent,
soft multi-colour aurora background, restrained motion.** Full dark and light modes.

---

## 1. Brand accent

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#FF5E3A` | THE brand colour. Warm orange. Primary buttons, selected states, progress fills, glows. Identical in both themes. |
| `--accent-hover` | `#FF7A5E` | Primary button hover. |
| `--accent-pressed` | `#E54A28` | Primary button active/pressed. |
| `--accent-text` | dark: `#FF5E3A` / light: `#C9391A` | Orange used AS TEXT (serif italic words in headlines, links, category pills, stat numbers). Darkens in light mode so it passes WCAG AA (4.9:1). Never use raw `--accent` for text on light backgrounds. |
| `--accent-soft` | `rgba(255,94,58,0.12)` dark / `0.10` light | Tinted fills: selected cards, chips, icon backgrounds, focus rings. |
| `--accent-glow` | `rgba(255,94,58,0.40)` dark / `0.30` light | Box-shadow glow under hovered primary buttons and the pulsing brand dot. |

Text placed ON an accent fill (button labels, icons in orange circles) is always
**`#1A0A00`** (near-black warm ink), never white. Contrast 6.4:1.

## 2. Neutrals

### Dark theme (default)
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0A0A0B` | Page background. |
| `--bg-elevated` | `#111114` | Active tab, drawer/panel surfaces. |
| `--bg-card` | `#141418` | Cards, tab bars, tiles. |
| `--bg-inset` | `#0C0C0E` | Inputs, sunken wells, table detail rows. |
| `--border-subtle` | `#1C1C20` | Card borders, dividers, hairlines. |
| `--border` | `#26262C` | Inputs, buttons, stronger separators. |
| `--border-strong` | `#3A3A42` | Hover borders. |
| `--text` | `#FAFAFA` | Headlines, primary copy. |
| `--text-secondary` | `#A1A1A8` | Body copy, descriptions. |
| `--text-muted` | `#83838D` | Labels, eyebrows, mono captions (AA-safe: 4.9:1 on cards). |
| `--text-dim` | `#56565F` | Placeholders, decorative index numbers. Decorative only, not for essential text. |

### Light theme (`:root[data-theme="light"]`)
| Token | Hex |
|---|---|
| `--bg` | `#FAFAFA` |
| `--bg-elevated` | `#FFFFFF` |
| `--bg-card` | `#FFFFFF` |
| `--bg-inset` | `#F4F4F5` |
| `--border-subtle` | `#EBEBEE` |
| `--border` | `#E4E4E7` |
| `--border-strong` | `#D4D4D8` |
| `--text` | `#18181B` |
| `--text-secondary` | `#52525B` |
| `--text-muted` | `#63636B` |
| `--text-dim` | `#97979F` |

## 3. Semantic / state colours

| Token | Dark | Light | Use |
|---|---|---|---|
| `--success` | `#4ADE80` | `#15803D` | "Matched", "Submissions open" chips, success icons. |
| `--success-soft` | `rgba(74,222,128,0.12)` | `rgba(22,163,74,0.10)` | Success chip/icon fill. |
| `--danger` | `#F87171` | `#DC2626` | Errors, "closed", delete buttons, urgent countdown. |
| `--danger-soft` | `rgba(248,113,113,0.12)` | `rgba(220,38,38,0.08)` | Danger fills. |
| `--info` | `#60A5FA` | `#2563EB` | Edit/info icons. |
| `--info-soft` | `rgba(96,165,250,0.10)` | `rgba(37,99,235,0.08)` | Info fills. |

Rule for colour-blind users: never signal state by colour alone. Every chip carries a
text label ("Matched", "Submissions closed"); links are underlined.

## 4. Aurora background (the "pretty" part)

Two fixed, full-viewport layers of radial-gradient blobs that drift in opposite
directions on different clocks. Orange leads; violet, rose and sky support.

| Token | Dark | Light | Colour |
|---|---|---|---|
| `--glow-1` | `rgba(255,94,58,0.20)` | `rgba(255,94,58,0.15)` | Warm orange (top-left) |
| `--glow-2` | `rgba(147,91,255,0.15)` | `rgba(147,91,255,0.12)` | Violet (top-right) |
| `--glow-3` | `rgba(236,72,153,0.11)` | `rgba(236,72,153,0.10)` | Rose (bottom-right) |
| `--glow-4` | `rgba(56,189,248,0.10)` | `rgba(56,189,248,0.12)` | Sky (bottom-left) |

Layer A (`body::before`): glow-1 + glow-3, animation `aurora-a` 16s alternate.
Layer B (`.page::before`): glow-2 + glow-4, animation `aurora-b` 21s alternate.
Over these sits a faint 64px grid (`--grid-line`) masked to a centre vignette.
Full CSS in section 7.

## 5. Typography

| Token | Stack | Use |
|---|---|---|
| `--font-sans` | `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | Everything by default. Body 15px, letter-spacing -0.005em. |
| `--font-display` | `'Instrument Serif', Georgia, 'Times New Roman', serif` | Big numbers, italic accent words in headlines (`.serif`), countdown digits, drawer titles. Weight 400, often italic. |
| `--font-mono` | `'Geist Mono', 'JetBrains Mono', ui-monospace, monospace` | Eyebrows, labels, chips: 10-11px, UPPERCASE, letter-spacing 0.14em. |

Google Fonts import:
`https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Geist:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap`

Signature headline pattern: sans-serif lowercase with one word in the accent-coloured
serif italic, tight tracking (-0.045em):
`find <span class="serif">your</span> group.`

## 6. Spacing, radii, shadows, motion

- Space scale: `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48 · `--s-8` 64 · `--s-9` 96 (px)
- Radii: `--r-sm` 6 · `--r` 10 (inputs, buttons) · `--r-lg` 14 (cards) · `--r-xl` 20 · pills 999px
- Shadows (dark): `--shadow-sm` `0 1px 2px rgba(0,0,0,.3)` · `--shadow` `0 8px 24px rgba(0,0,0,.4)` · `--shadow-lg` `0 24px 48px -12px rgba(0,0,0,.6)` (light: same offsets at .05/.08/.12 alpha)
- Easing: `--ease-out` `cubic-bezier(0.16,1,0.3,1)` (almost everything) · `--ease-in-out` `cubic-bezier(0.65,0,0.35,1)` (ambient loops)
- Durations: `--dur-fast` 150ms · `--dur` 240ms · `--dur-slow` 400ms
- Entrance: `.reveal` = rise 14px + fade, 700ms, staggered 80ms per `.reveal-N`
- Always honour `prefers-reduced-motion: reduce` by killing all animations.

Signature micro-interactions: primary buttons lift 1px and get a light sweep on hover;
cards gain a hairline shadow; hovered rows wash with an accent gradient from the left;
selected cards fill with `--accent-soft` and an accent border; the brand dot pulses.

## 7. Drop-in CSS (copy verbatim)

```css
:root {
  --bg:#0A0A0B; --bg-elevated:#111114; --bg-card:#141418; --bg-inset:#0C0C0E;
  --border:#26262C; --border-subtle:#1C1C20; --border-strong:#3A3A42;
  --text:#FAFAFA; --text-secondary:#A1A1A8; --text-muted:#83838D; --text-dim:#56565F;
  --accent:#FF5E3A; --accent-text:#FF5E3A; --accent-hover:#FF7A5E; --accent-pressed:#E54A28;
  --accent-soft:rgba(255,94,58,0.12); --accent-glow:rgba(255,94,58,0.4);
  --success:#4ADE80; --success-soft:rgba(74,222,128,0.12);
  --danger:#F87171;  --danger-soft:rgba(248,113,113,0.12);
  --info:#60A5FA;    --info-soft:rgba(96,165,250,0.10);
  --topbar-bg:rgba(10,10,11,0.7); --grid-line:rgba(255,255,255,0.018);
  --glow-1:rgba(255,94,58,0.20); --glow-2:rgba(147,91,255,0.15);
  --glow-3:rgba(236,72,153,0.11); --glow-4:rgba(56,189,248,0.10);
  --font-display:'Instrument Serif',Georgia,'Times New Roman',serif;
  --font-sans:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-mono:'Geist Mono','JetBrains Mono',ui-monospace,monospace;
  --s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-5:24px;--s-6:32px;--s-7:48px;--s-8:64px;--s-9:96px;
  --r-sm:6px;--r:10px;--r-lg:14px;--r-xl:20px;
  --shadow-sm:0 1px 2px rgba(0,0,0,.3);--shadow:0 8px 24px rgba(0,0,0,.4);--shadow-lg:0 24px 48px -12px rgba(0,0,0,.6);
  --ease-out:cubic-bezier(.16,1,.3,1);--ease-in-out:cubic-bezier(.65,0,.35,1);
  --dur-fast:150ms;--dur:240ms;--dur-slow:400ms;
}
:root[data-theme="light"] {
  color-scheme:light;
  --bg:#FAFAFA; --bg-elevated:#FFFFFF; --bg-card:#FFFFFF; --bg-inset:#F4F4F5;
  --border:#E4E4E7; --border-subtle:#EBEBEE; --border-strong:#D4D4D8;
  --text:#18181B; --text-secondary:#52525B; --text-muted:#63636B; --text-dim:#97979F;
  --accent-text:#C9391A; --accent-soft:rgba(255,94,58,0.10); --accent-glow:rgba(255,94,58,0.30);
  --success:#15803D; --success-soft:rgba(22,163,74,0.10);
  --danger:#DC2626;  --danger-soft:rgba(220,38,38,0.08);
  --info:#2563EB;    --info-soft:rgba(37,99,235,0.08);
  --topbar-bg:rgba(250,250,250,0.75); --grid-line:rgba(0,0,0,0.04);
  --glow-1:rgba(255,94,58,0.15); --glow-2:rgba(147,91,255,0.12);
  --glow-3:rgba(236,72,153,0.10); --glow-4:rgba(56,189,248,0.12);
  --shadow-sm:0 1px 2px rgba(0,0,0,.05);--shadow:0 8px 24px rgba(0,0,0,.08);--shadow-lg:0 24px 48px -12px rgba(0,0,0,.12);
}

/* Base */
html { color-scheme:dark; -webkit-font-smoothing:antialiased; scroll-behavior:smooth; }
body {
  min-height:100vh; font-family:var(--font-sans); font-size:15px; line-height:1.5;
  color:var(--text); background:var(--bg); letter-spacing:-0.005em; overflow-x:hidden;
}
[hidden] { display:none !important; }

/* Aurora layer A: orange + rose */
body::before {
  content:''; position:fixed; inset:-18%; pointer-events:none; z-index:0;
  background-image:
    radial-gradient(ellipse 48% 36% at 22% 14%, var(--glow-1) 0%, transparent 62%),
    radial-gradient(ellipse 46% 40% at 76% 86%, var(--glow-3) 0%, transparent 62%);
  animation:aurora-a 16s var(--ease-in-out) infinite alternate; will-change:transform,opacity;
}
@keyframes aurora-a {
  0%   { transform:translate(-4%,-3%) rotate(-2deg) scale(1);   opacity:.75; }
  50%  { transform:translate(3%,2%)  rotate(1.5deg) scale(1.12); opacity:1; }
  100% { transform:translate(5%,4%)  rotate(3deg)  scale(1.05); opacity:.85; }
}
/* Faint grid, vignetted */
body::after {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background-image:linear-gradient(var(--grid-line) 1px,transparent 1px),
                   linear-gradient(90deg,var(--grid-line) 1px,transparent 1px);
  background-size:64px 64px;
  -webkit-mask-image:radial-gradient(ellipse at center,black 25%,transparent 80%);
          mask-image:radial-gradient(ellipse at center,black 25%,transparent 80%);
}
/* Page shell + aurora layer B: violet + sky */
.page { position:relative; z-index:1; min-height:100vh; display:flex; flex-direction:column; }
.page::before {
  content:''; position:fixed; inset:-18%; pointer-events:none; z-index:-1;
  background-image:
    radial-gradient(ellipse 42% 42% at 82% 18%, var(--glow-2) 0%, transparent 65%),
    radial-gradient(ellipse 40% 38% at 14% 80%, var(--glow-4) 0%, transparent 65%);
  animation:aurora-b 21s var(--ease-in-out) infinite alternate; will-change:transform,opacity;
}
@keyframes aurora-b {
  0%   { transform:translate(4%,3%)   rotate(2deg)   scale(1.08); opacity:.8; }
  50%  { transform:translate(-3%,-2%) rotate(-1.5deg) scale(1);   opacity:1; }
  100% { transform:translate(-5%,3%)  rotate(-3deg)  scale(1.1);  opacity:.85; }
}

/* Type helpers */
.serif { font-family:var(--font-display); font-style:italic; font-weight:400; letter-spacing:-0.01em; color:var(--accent-text); }
.eyebrow { font-family:var(--font-mono); font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:.14em; color:var(--text-muted); }

/* Primary button */
.btn-primary {
  display:inline-flex; align-items:center; gap:var(--s-2); padding:11px 18px;
  background:var(--accent); color:#1A0A00; border:1px solid var(--accent); border-radius:var(--r);
  font-size:13.5px; font-weight:600; cursor:pointer; position:relative; overflow:hidden;
  transition:all var(--dur) var(--ease-out);
}
.btn-primary:hover { background:var(--accent-hover); box-shadow:0 4px 20px var(--accent-glow); transform:translateY(-1px); }

/* Card */
.card { background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--r-lg); padding:var(--s-6); }

/* Input */
.input { width:100%; padding:11px 14px; background:var(--bg-inset); border:1px solid var(--border); border-radius:var(--r); color:var(--text); font-size:14px; }
.input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); background:var(--bg-card); }

/* Entrance */
@keyframes rise { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
.reveal{animation:rise 700ms var(--ease-out) both}
.reveal-1{animation-delay:80ms}.reveal-2{animation-delay:160ms}.reveal-3{animation-delay:240ms}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
```

## 8. Theme toggle (JS)

Theme is stored in `localStorage("theme")`, default `"dark"`, applied as
`data-theme` on `<html>`. Put this in `<head>` before any CSS paints, on every page:

```html
<script>
(function(){try{document.documentElement.setAttribute('data-theme',localStorage.getItem('theme')||'dark')}
catch(e){document.documentElement.setAttribute('data-theme','dark')}})();
</script>
```
Toggle: flip the attribute between `dark`/`light` and write it back to localStorage.

## 9. Do / Don't

- DO use `--accent-text` (not `--accent`) whenever orange is text.
- DO use `#1A0A00` ink on orange fills.
- DO pair every colour-coded state with a text label.
- DON'T use em dashes anywhere in copy (house style). Use periods, commas or parentheses.
- DON'T introduce new hues; the palette is orange + neutrals + the four aurora tints.
