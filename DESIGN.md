# Material 3 — Design Style Reference

```yaml
# How this file was made. Sources are first-party; nothing here is
# read from a rendered page. Full breakdown at source_page below.
method: restated-from-official-tokens-package
confidence: high
verified_at: 2026-09-03
source_page: https://www.designsystems.one/design-systems/material-design
sources:
  - https://m3.material.io/
  - https://m3.material.io/styles/color/the-color-system/tokens
  - https://m3.material.io/styles/typography/type-scale-tokens
  - https://github.com/material-components/material-web
  - https://www.figma.com/community/file/1035203688168086460/material-3-design-kit
```

> **Unofficial, community-authored reference.** Compiled by [designsystems.one](https://www.designsystems.one). Not affiliated with, endorsed by, or sponsored by Google. "Material 3" and related marks belong to their respective owners. This document describes publicly observable style attributes in original words — it contains no copied documentation, logos, icon artwork, or original token files. Always defer to the official source for canonical, current values.

**System:** Material 3
**Owner:** Google
**Official documentation:** <https://m3.material.io/>
**Visual character:** Expressive tonal color built from dynamic palettes, generous shape scale, and confident motion.

---

## Summary

The design language that rewrote itself for tokens and theming.

_Editorial confidence: high. Values are drawn from well-documented public token references. Field-level evidence: 0/106 claims source-linked, 0/106 dated. Confidence is not verification; validate canonical values before implementation._

[Inspect every field and its evidence](https://www.designsystems.one/api/style-spec?system=material-design)

## Color tokens

| Color | Value | CSS variable | Role |
| --- | --- | --- | --- |
| Primary (baseline) | `#3f6b52` | `--md-sys-color-primary` | Key actions, FABs, active states (baseline static scheme) |
| On Primary | `#ffffff` | `--md-sys-color-on-primary` | Text and icons on primary |
| Primary Container | `#c8e6c9` | `--md-sys-color-primary-container` | Tonal fill for prominent components (light) |
| Secondary | `#625b71` | `--md-sys-color-secondary` | Less prominent components, filter chips |
| Tertiary | `#7d5260` | `--md-sys-color-tertiary` | Contrasting accents |
| Error | `#b3261e` | `--md-sys-color-error` | Error and destructive states |
| Surface (baseline light) | `#fffbfe` | `--md-sys-color-surface` | Baseline light surface and background |
| On Surface | `#1c1b1f` | `--md-sys-color-on-surface` | Primary text and icons |
| Surface Variant | `#e7e0ec` | `--md-sys-color-surface-variant` | Lower-emphasis surfaces |
| Outline | `#79747e` | `--md-sys-color-outline` | Borders, dividers, outlined components |
| md.sys.color.primary | `Dynamic` | `--md-sys-color-primary` | Brand action (theme-derived via dynamic color) |

## Typography

- **Display:** Roboto — weights 400, 500 — `Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Body:** Roboto — weights 400, 500, 700 — `Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Mono:** Roboto Mono — weights 400, 500 — `'Roboto Mono', monospace`

## Type scale

| Step | Size | Line height |
| --- | --- | --- |
| display-large | `57sp` | `64sp` |
| headline-large | `32sp` | `40sp` |
| title-large | `22sp` | `28sp` |
| body-large | `16sp` | `24sp` |
| body-medium | `14sp` | `20sp` |
| label-large | `14sp` | `20sp` |

## Spacing

Base unit: `4dp`

Scale: `4dp` · `8dp` · `12dp` · `16dp` · `24dp` · `32dp`

## Corner radius

| Name | Value |
| --- | --- |
| extra-small | `4dp` |
| small | `8dp` |
| medium | `12dp` |
| large | `16dp` |
| extra-large | `28dp` |
| full | `9999px` |

## Elevation / shadows

| Name | Value |
| --- | --- |
| elevation-1 | `0 1px 2px rgba(0,0,0,0.3), 0 1px 3px 1px rgba(0,0,0,0.15)` |
| elevation-2 | `0 1px 2px rgba(0,0,0,0.3), 0 2px 6px 2px rgba(0,0,0,0.15)` |
| elevation-3 | `0 1px 3px rgba(0,0,0,0.3), 0 4px 8px 3px rgba(0,0,0,0.15)` |

## Motion

| Name | Value |
| --- | --- |
| duration-short2 | `100ms` |
| duration-medium2 | `300ms` |
| easing-standard | `cubic-bezier(0.2, 0, 0, 1)` |

## Quick start (CSS)

```css
/* Material 3 — illustrative tokens, restated as CSS custom properties.
   Unofficial reference by designsystems.one; values are indicative, not
   canonical. Native dp/sp values are omitted, never silently converted.
   Official reference: https://m3.material.io/
   Field evidence: https://www.designsystems.one/api/style-spec?system=material-design */

:root {
  /* Color */
  --md-sys-color-primary: #3f6b52; /* Key actions, FABs, active states (baseline static scheme) */
  --md-sys-color-on-primary: #ffffff; /* Text and icons on primary */
  --md-sys-color-primary-container: #c8e6c9; /* Tonal fill for prominent components (light) */
  --md-sys-color-secondary: #625b71; /* Less prominent components, filter chips */
  --md-sys-color-tertiary: #7d5260; /* Contrasting accents */
  --md-sys-color-error: #b3261e; /* Error and destructive states */
  --md-sys-color-surface: #fffbfe; /* Baseline light surface and background */
  --md-sys-color-on-surface: #1c1b1f; /* Primary text and icons */
  --md-sys-color-surface-variant: #e7e0ec; /* Lower-emphasis surfaces */
  --md-sys-color-outline: #79747e; /* Borders, dividers, outlined components */

  /* Typography */
  --font-display: Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-body: Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: 'Roboto Mono', monospace;

  /* Type scale */
  /* Omitted --text-display-large: 57sp uses native units; choose a web value explicitly. */
  /* Omitted --text-headline-large: 32sp uses native units; choose a web value explicitly. */
  /* Omitted --text-title-large: 22sp uses native units; choose a web value explicitly. */
  /* Omitted --text-body-large: 16sp uses native units; choose a web value explicitly. */
  /* Omitted --text-body-medium: 14sp uses native units; choose a web value explicitly. */
  /* Omitted --text-label-large: 14sp uses native units; choose a web value explicitly. */

  /* Spacing */
  /* Omitted --space-1: 4dp uses native units; choose a web value explicitly. */
  /* Omitted --space-2: 8dp uses native units; choose a web value explicitly. */
  /* Omitted --space-3: 12dp uses native units; choose a web value explicitly. */
  /* Omitted --space-4: 16dp uses native units; choose a web value explicitly. */
  /* Omitted --space-5: 24dp uses native units; choose a web value explicitly. */
  /* Omitted --space-6: 32dp uses native units; choose a web value explicitly. */

  /* Radius */
  /* Omitted --radius-extra-small: 4dp uses native units; choose a web value explicitly. */
  /* Omitted --radius-small: 8dp uses native units; choose a web value explicitly. */
  /* Omitted --radius-medium: 12dp uses native units; choose a web value explicitly. */
  /* Omitted --radius-large: 16dp uses native units; choose a web value explicitly. */
  /* Omitted --radius-extra-large: 28dp uses native units; choose a web value explicitly. */
  --radius-full: 9999px;

  /* Elevation */
  --shadow-elevation-1: 0 1px 2px rgba(0,0,0,0.3), 0 1px 3px 1px rgba(0,0,0,0.15);
  --shadow-elevation-2: 0 1px 2px rgba(0,0,0,0.3), 0 2px 6px 2px rgba(0,0,0,0.15);
  --shadow-elevation-3: 0 1px 3px rgba(0,0,0,0.3), 0 4px 8px 3px rgba(0,0,0,0.15);

  /* Motion */
  --motion-duration-short2: 100ms;
  --motion-duration-medium2: 300ms;
  --motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
}
```

## Origin

Google introduced Material in 2014. Material 3 (announced 2021, matured through 2022–2024) is a full reset around dynamic color, expressive theming, and a token-first architecture. Web implementation lifecycles differ from the design specification; check each package before adopting it.

## Governance

Google design and engineering teams own the canonical specification. Component implementations exist for Android, iOS, Flutter, and Web (MDC, Material Web). Cadence is fast and Google-product-driven.

## Known for

- Dynamic color — extracting a palette from user wallpaper or brand seed and generating accessible tonal scales automatically.
- Token-first architecture: design decisions live as tokens, components reference them.
- Expressive type, motion, and shape systems that scale from product to brand.

## Underrated

- Material's accessibility documentation is more thorough than most teams realize.
- The HCT (hue, chroma, tone) color space behind dynamic color is open and adaptable to non-Material systems.

## Watch out for

- Material's visual language is strong enough that adopting it without retheming makes your product look like a Google product.
- Material Web reports maintenance mode pending new maintainers in its official README. Assess its roadmap separately from Material 3 and from community implementations.

## Components worth studying

- **App bar (top)** — Composable header with scroll-aware elevation behavior.
- **Filled / outlined / text fields** — Three input styles each with clear use guidance.
- **Cards** — Three card variants (elevated, filled, outlined) that map to information hierarchy.

## When to choose Material 3

Pick Material 3 if you're shipping Android, building a Flutter app, or want a reference for token-first system design. For pure web product work outside the Google ecosystem, Material is more useful as a reference than as an off-the-shelf component library.

## Apply this style with an AI tool

Paste this into your AI coding assistant as a direction, then iterate:

> Design in the spirit of Material 3 by Google — The design language that rewrote itself for tokens and theming. Character: Expressive tonal color built from dynamic palettes, generous shape scale, and confident motion. Use a primary colour near #3f6b52, the typeface "Roboto" (or a close equivalent), corner radius around 4dp, a spacing rhythm on a 4dp base. Lean into what it's known for: Dynamic color — extracting a palette from user wallpaper or brand seed and generating accessible tonal scales automatically. Match the intent, not the pixels; adapt it to my product rather than cloning it.

## Official references

- [Material 3 docs](https://m3.material.io/)
- [Material Web](https://github.com/material-components/material-web)
- [Material Theme Builder](https://material-foundation.github.io/material-theme-builder/)

---

_Generated by [designsystems.one](https://www.designsystems.one/design-systems/material-design) — a catalogue of public design systems. Style facts are reported for reference and education; adapt them to your own product. Report issues or takedown requests via the site._
