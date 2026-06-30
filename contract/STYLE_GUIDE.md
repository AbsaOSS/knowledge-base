# Style Guide

All doc apps in the marketplace must produce pages that are visually consistent with the
the knowledge-base design system. This guide defines the required visual standards.

---

## Color palette

Use only the canonical brand palette. Do **not** introduce custom brand colors.

| Token | Hex | Usage |
|---|---|---|
| `--color-kb-500` | `#af144b` | Primary brand, links, active states, focus rings |
| `--color-kb-600` | `#93103f` | Hover state for primary elements |
| `--color-kb-400` | `#d4547a` | Accents, secondary highlights |
| `--color-kb-100` | `#f0d0da` | Subtle tint backgrounds (light mode) |
| `--color-kb-50`  | `#f8eaee` | Very light tint |
| `--color-kb-25`  | `#fdf8f9` | Page background (light mode) |
| `--color-kb-950` | `#1b0e12` | Heading text (light mode) |

Do **not** use raw hex values for brand colors in your styles — always reference the tokens.

---

## Typography

| Role | Font | Token |
|---|---|---|
| Body / UI | Inter, Noto Sans | `--font-sans` |
| Code / mono | SF Mono, Fira Code | `--font-mono` |

Ensure Inter is loaded from Google Fonts or bundled:

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

---

## Spacing and radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `6px` | Buttons, code badges |
| `--radius-md` | `12px` | Cards, inputs |
| `--radius-lg` | `16px` | Panels, modals |
| `--radius-xl` | `20px` | Large feature cards |

---

## Dark mode

Dark mode is **class-based**: add `class="dark"` to `<html>` (default in standalone builds).  
The marketplace propagates the user's theme preference to all embedded apps.

Required dark-mode variable overrides (copy from `src/input.css`):

```css
.dark {
  --bg-page:      #0a0d14;
  --bg-card:      #111827;
  --bg-strong:    #1f2937;
  --bg-subtle:    #1a2236;
  --border:       #1f2937;
  --text-heading: #ffffff;
  --text-body:    #d1d5db;
  --text-muted:   #9ca3af;
}
```

---

## Sidebar

- Fixed left sidebar, **64px wide** (`w-64`)
- Background: `var(--bg-card)`
- Border right: `1px solid var(--border)`
- `id="sidebar"` required for marketplace chrome injection
- In **headless** mode: `top: 0` (marketplace chrome handles the offset)
- In **standalone** mode: `top: 56px` (offset by site header)

---

## Content area

- Left margin: `ml-64` (desktop), full-width on mobile
- Max prose width: `max-w-3xl` inside content
- Use `@tailwindcss/typography` prose classes for markdown-rendered content

---

## Component patterns

### Links
```css
color: var(--color-kb-500);
text-decoration: none;
/* hover */
text-decoration: underline;
color: var(--color-kb-600);
```

### Code blocks
```css
background: #0f172a;
border: 1px solid var(--border);
border-radius: var(--radius-md);
```

### Inline code
```css
background: var(--bg-strong);
border: 1px solid var(--border);
border-radius: 4px;
padding: 1px 5px;
font-size: 0.85em;
```

### Tables
```css
border: 1px solid var(--border);
border-radius: var(--radius-md);
/* thead */
background: var(--bg-strong);
/* tr:hover */
background: var(--bg-strong);
```

### Blockquotes
```css
border-left: 4px solid var(--color-kb-500);
background: var(--bg-subtle);
border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
padding: 0.75rem 1rem;
```

---

## Accessibility

- All interactive elements must have accessible names (`aria-label` or visible text)
- Focus rings must use `--color-kb-500` with sufficient contrast
- Images must have `alt` attributes
- Sidebar navigation must use `<nav>` with `aria-label="Documentation"`

---

## Checklist

- [ ] Only brand color tokens used (no raw hex brand colors)
- [ ] Inter font loaded
- [ ] Both light and dark CSS variable sets defined
- [ ] `id="sidebar"` present on the left navigation
- [ ] `id="content"` or `<main>` wraps the prose area
- [ ] No inline styles that override design tokens with hardcoded values
