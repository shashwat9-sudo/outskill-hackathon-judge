# Branding

The Outskill visual system for Hackathon Judge: near-black, high contrast, restrained, with a single bright accent reserved for the things that matter.

> **The exact Outskill green has not been confirmed.** The accent below is a documented placeholder, not a declared brand value. Swapping it is a two-line change — see §6.

---

## 1. Where the tokens live

There is exactly one source of truth per surface, and they are kept in step deliberately:

| File | What it defines | Consumed by |
| --- | --- | --- |
| `apps/web/src/app/globals.css` | `--brand-*` CSS variables, and the Tailwind `@theme` mapping | Every page and component in the web app |
| `packages/shared/src/config/brand.ts` | The same palette as TypeScript constants | The generated internal deck, and anything rendered outside the browser |

Nothing else hard-codes a colour. If you find a hex in a component, that is a bug.

---

## 2. Colour tokens

### The palette

| Token | Value | Role |
| --- | --- | --- |
| `--brand-accent` | `#c8ff38` | **Placeholder lime.** Primary actions, active navigation, progress, success. |
| `--brand-accent-hover` | `#b7ee2f` | Hover state for the accent. |
| `--brand-background` | `#060806` | Page canvas. Near-black, not pure black. |
| `--brand-surface` | `#10140e` | Cards and panels. |
| `--brand-surface-raised` | `#161c13` | Raised cards, sidebars, secondary buttons. |
| `--brand-surface-soft` | `#1d2419` | Inputs on raised surfaces, subtle fills. |
| `--brand-text` | `#f4f7f1` | Primary text. Off-white, never pure white. |
| `--brand-text-muted` | `#9fa89a` | Supporting text. Grey-green, not neutral grey. |
| `--brand-border` | `#2a3326` | Subtle borders and dividers. |
| `--brand-danger` | `#ff6262` | Destructive actions, failures. |
| `--brand-warning` | `#f3bd52` | Needs attention, low confidence. |
| `--brand-success` | `#77dd77` | Passed, complete, saved. |
| `--brand-link` | `#7fc4ff` | **Links and technical information only.** Never a primary action. |

Three tokens are derived at runtime with `color-mix`, so they track the accent automatically:

- `--brand-accent-tint` — 14% accent, for highlighted panels
- `--brand-accent-edge` — 38% accent, for borders on accented surfaces
- matching `--brand-danger-tint`, `--brand-warning-tint`, `--brand-success-tint`

### Tailwind mapping

`@theme inline` maps the variables to semantic utility names, so markup reads by **role** rather than by colour:

```
bg-canvas        bg-surface       bg-surface-alt    bg-surface-soft
text-ink         text-muted       text-brand
border-line      border-brand-edge
bg-brand-tint    bg-warning-tint  bg-danger-tint    bg-success-tint
```

Write `text-muted`, never `text-gray-400`. A stock Tailwind palette class in this codebase is a mistake, and an end-to-end test asserts that default blues do not appear.

---

## 3. Using the accent

The accent is the loudest thing on any screen, so it is rationed. Use it for:

- the **one** primary action on a screen (lime background, black text);
- the active navigation item;
- progress fill and completed steps;
- success states;
- the eyebrow label above a page title.

Do **not** use it for body text, for decorative glows, or for more than one call to action in the same view. Lime on near-black is extremely high contrast — used everywhere it stops meaning anything.

### Buttons

| Variant | Treatment | When |
| --- | --- | --- |
| `primary` | Lime background, black text, bold | The single main action |
| `secondary` | Raised dark surface, light text, subtle border | Everything else |
| `ghost` | Transparent, muted text | Tertiary, destructive-adjacent, cancel |
| `danger` | Dark red tint, red text, red border; fills red on hover | Destructive, always with a confirmation |

---

## 4. Typography and spacing

**Type.** System sans throughout (`ui-sans-serif, system-ui, …`). Headings are bold with `-0.02em` tracking and tight leading; body is 16px at 1.55. Eyebrow labels are small, bold, uppercase with wide tracking, in the accent.

Hierarchy is carried by **weight and size**, not colour. A heading is bold and large; it is not lime.

**Spacing.** An 8px scale (`SPACING` in `brand.ts`). Cards use `p-5` on mobile and `p-6` from `sm`. Page sections are separated by `mb-8`; related fields by `space-y-5`.

**Radii.** Two values only: `10px` for controls, `14px` for cards. Exposed as `--radius-control` and `--radius-card`, and as `RADIUS` in `brand.ts`.

---

## 5. Components

Everything lives in `apps/web/src/components/ui/index.tsx`. Accessibility is owned there rather than inherited:

| Component | Notes |
| --- | --- |
| `Wordmark` | Text wordmark. No invented logo — the mark is the name, set in wide-tracked black caps. |
| `Button` | Four variants above; `loading` shows a spinner and sets `aria-busy`. |
| `Field` | Wires `aria-describedby`, `aria-invalid` and required state to hint and error text. |
| `Card` | `default`, `raised`, `accent`. Takes an explicit `testId` — arbitrary props are not spread. |
| `Badge` / `StatusPill` | Six tones. Wrapped two-word labels stay inside the pill. |
| `Alert` | `role="alert"` for danger, `role="status"` otherwise. |
| `Stepper` | Horizontal, vertical or `responsive`. One instance only — two would mean two `nav` landmarks with the same name. |
| `Tabs` | WAI-ARIA tabs pattern with roving tabindex and arrow-key navigation. |
| `Progress`, `Stat`, `Table`, `EmptyState`, `Skeleton` | Dashboard primitives. |
| `Disclosure` | Native `<details>`. How technical detail stays reachable without being in the way. |

**Focus** is one treatment everywhere: a 2px accent outline with 2px offset, never removed.

---

## 6. Replacing the placeholder with the official brand green

Two files, two lines each. No other change is needed anywhere.

**1. `apps/web/src/app/globals.css`**

```css
:root {
  --brand-accent: #c8ff38;        /* ← official green */
  --brand-accent-hover: #b7ee2f;  /* ← ~8% darker */
}
```

**2. `packages/shared/src/config/brand.ts`**

```ts
export const BRAND = {
  accent: '#c8ff38',       // ← same value
  accentHover: '#b7ee2f',  // ← same value
  …
```

Then:

```bash
npm run gen:deck            # regenerate the internal deck in the new colour
npm run verify              # lint, typecheck, unit tests, build
npx playwright test         # the branding spec asserts the token values
```

**The branding test will fail**, by design — `e2e/branding.spec.ts` pins the expected hex values so the swap is a deliberate, reviewed change rather than a silent drift. Update the two expected values in that spec at the same time.

### Before you swap, check contrast

The placeholder was chosen for contrast as much as for looks:

| Pair | Ratio | Requirement |
| --- | --- | --- |
| `#c8ff38` on `#060806` | 17.9:1 | AAA |
| Black text on `#c8ff38` | 16.3:1 | AAA — this is why primary buttons use black text |
| `#f4f7f1` on `#060806` | 18.4:1 | AAA |
| `#9fa89a` on `#060806` | 8.6:1 | AAA for body text |

If the official green is darker or more saturated, re-check **black text on the accent** first. If that pair drops below 4.5:1, primary buttons need white text instead, and `BUTTON_VARIANTS.primary` in the component file changes with it.

### Environment override

`BRAND_GREEN` in `.env` is read by `resolveBrandAccent()` for generated artefacts. It does **not** affect the CSS — a build-time override for the web app would defeat the point of a single token file.

---

## 7. What is deliberately not here

- **No logo file.** The wordmark is text. Supply an SVG and it replaces `Wordmark`.
- **No custom webfont.** System fonts keep first paint fast and avoid a licensing question nobody has answered. A brand face drops into `--font-sans`.
- **No light theme.** The product is dark-first and `color-scheme: dark` is declared. A light theme would mean a second full palette, and nothing has asked for one.
- **No colourful dashboard palette.** Status colours are the only non-brand hues, and they exist to be read, not to decorate.
