# HeroUI — Design Style Reference

```yaml
# How this file was made. Sources are first-party; nothing here is
# read from a rendered page. Full breakdown at source_page below.
method: restated-from-official-docs
confidence: high
verified_at: 2026-09-03
source_page: https://www.designsystems.one/design-systems/nextui
sources:
  - https://heroui.com/
  - https://www.heroui.com/docs/customization/colors
  - https://github.com/heroui-inc/heroui
  - https://www.figma.com/community/file/1546526812159103429/heroui-figma-kit-v3
```

> **Unofficial, community-authored reference.** Compiled by [designsystems.one](https://www.designsystems.one). Not affiliated with, endorsed by, or sponsored by HeroUI. "HeroUI" and related marks belong to their respective owners. This document describes publicly observable style attributes in original words — it contains no copied documentation, logos, icon artwork, or original token files. Always defer to the official source for canonical, current values.

**System:** HeroUI
**Owner:** HeroUI
**Official documentation:** <https://heroui.com/>
**Visual character:** Glossy launch-page energy: vivid gradient-friendly hues, big 12-14px corner radii, and motion-forward components built on Tailwind.

---

## Summary

Beautiful, fast and modern React UI library (formerly NextUI).

_Editorial confidence: high. Values are drawn from well-documented public token references. Field-level evidence: 0/72 claims source-linked, 0/72 dated. Confidence is not verification; validate canonical values before implementation._

[Inspect every field and its evidence](https://www.designsystems.one/api/style-spec?system=nextui)

## Color tokens

| Color | Value | CSS variable | Role |
| --- | --- | --- | --- |
| Primary / Blue | `#b08968` | `--heroui-primary` | Primary actions |
| Secondary / Purple | `#7828c8` | `--heroui-secondary` | Secondary accent |
| Foreground | `#11181c` | `--heroui-foreground` | Primary text |
| Background | `#ffffff` | `--heroui-background` | Page background |
| Content2 | `#f4f4f5` | `--heroui-content2` | Subtle surface |
| Default 300 Border | `#d4d4d8` | `--heroui-default-300` | Borders |
| Success | `#17c964` | `--heroui-success` | Success |
| Warning | `#f5a524` | `--heroui-warning` | Warnings |
| Danger | `#f31260` | `--heroui-danger` | Errors |

## Typography

- **Body:** Inter — weights 400, 500, 600, 700 — `Inter, ui-sans-serif, system-ui, sans-serif`

## Type scale

| Step | Size | Line height |
| --- | --- | --- |
| text-large | `18px` | `28px` |
| text-medium | `16px` | `24px` |
| text-small | `14px` | `20px` |
| text-tiny | `12px` | `16px` |

## Spacing

Base unit: `4px (Tailwind scale)`

Scale: `4px` · `8px` · `12px` · `16px` · `24px` · `32px`

## Corner radius

| Name | Value |
| --- | --- |
| small | `8px` |
| medium | `12px` |
| large | `14px` |
| full | `9999px` |

## Elevation / shadows

| Name | Value |
| --- | --- |
| medium | `0 4px 12px 0 rgba(0,0,0,0.08)` |

## Motion

| Name | Value |
| --- | --- |
| default | `250ms ease` |

## Quick start (CSS)

```css
/* HeroUI — illustrative tokens, restated as CSS custom properties.
   Unofficial reference by designsystems.one; values are indicative, not
   canonical. Native dp/sp values are omitted, never silently converted.
   Official reference: https://heroui.com/
   Field evidence: https://www.designsystems.one/api/style-spec?system=nextui */

:root {
  /* Color */
  --heroui-primary: #b08968; /* Primary actions */
  --heroui-secondary: #7828c8; /* Secondary accent */
  --heroui-foreground: #11181c; /* Primary text */
  --heroui-background: #ffffff; /* Page background */
  --heroui-content2: #f4f4f5; /* Subtle surface */
  --heroui-default-300: #d4d4d8; /* Borders */
  --heroui-success: #17c964; /* Success */
  --heroui-warning: #f5a524; /* Warnings */
  --heroui-danger: #f31260; /* Errors */

  /* Typography */
  --font-body: Inter, ui-sans-serif, system-ui, sans-serif;

  /* Type scale */
  --text-text-large: 18px; /* line-height 28px */
  --text-text-medium: 16px; /* line-height 24px */
  --text-text-small: 14px; /* line-height 20px */
  --text-text-tiny: 12px; /* line-height 16px */

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;

  /* Radius */
  --radius-small: 8px;
  --radius-medium: 12px;
  --radius-large: 14px;
  --radius-full: 9999px;

  /* Elevation */
  --shadow-medium: 0 4px 12px 0 rgba(0,0,0,0.08);

  /* Motion */
  --motion-default: 250ms ease;
}
```

## Engineering profile

- **Ships for:** React, Tailwind
- **Token pipeline:** Custom
- **Source model:** Open source

## Apply this style with an AI tool

Paste this into your AI coding assistant as a direction, then iterate:

> Design in the spirit of HeroUI by HeroUI — Beautiful, fast and modern React UI library (formerly NextUI). Character: Glossy launch-page energy: vivid gradient-friendly hues, big 12-14px corner radii, and motion-forward components built on Tailwind. Use a primary colour near #b08968, the typeface "Inter" (or a close equivalent), corner radius around 8px, a spacing rhythm on a 4px (Tailwind scale) base. Match the intent, not the pixels; adapt it to my product rather than cloning it.

## Official reference

- [HeroUI documentation](https://heroui.com/)

---

_Generated by [designsystems.one](https://www.designsystems.one/design-systems/nextui) — a catalogue of public design systems. Style facts are reported for reference and education; adapt them to your own product. Report issues or takedown requests via the site._
