# Plinth UI

The component set every screen is built from. See them all, in both modes, at `/design`.

```tsx
import { Button, Dialog, useToast } from "../components/ui/index.ts";
import { AppShell } from "../components/layout/AppShell.tsx";
import { PublicShell } from "../components/layout/PublicShell.tsx";
```

## Rules for every screen

1. **No hard-coded colors, sizes or durations.** Use the custom properties in
   `src/styles/tokens.css` (`var(--color-ink)`, `var(--space-4)`, `var(--text-sm)`,
   `var(--radius-md)`, `var(--duration-fast)` ...). No hex, rgb, px font sizes or ms in page CSS.
2. **Colors by role, not by look.** Text: `--color-ink`, `--color-ink-muted` (secondary),
   `--color-ink-faint` (placeholders and tertiary meta only). Backgrounds: `--color-wall` (page),
   `--color-surface`, `--color-surface-raised` (cards, inputs, menus), `--color-surface-sunk`
   (wells, code), `--color-plinth`. Links and accent text: `--color-accent-ink`. Text on the
   accent: `--color-on-accent`. Status: `--color-success|warning|danger` with their `-soft`
   backgrounds. These pairs are the ones checked for WCAG AA in both modes
   (`src/styles/contrast.ts`); if you need a new pair, add it there so the test covers it.
3. **One accent.** Verdigris (`--color-accent`) is for the primary action, focus rings and the
   active state. Not for decoration, headings or icons.
4. **Type.** Headings (`h1`-`h3`) and artifact titles use the display serif automatically or via
   `.type-title`, `.type-heading`. Interface text is Geist. Versions, ids and tokens use
   `.type-mono` or `<code>`. Sizes come from the scale: `--text-2xs` ... `--text-5xl`. Role classes:
   `.type-display`, `.type-title`, `.type-heading`, `.type-subhead`, `.type-lead`, `.type-body`,
   `.type-small`, `.type-caption`, `.type-mono`; helpers `.text-muted`, `.text-faint`,
   `.text-danger`, `.visually-hidden`.
5. **Icons.** Phosphor, regular weight only, `*Icon` names (`TrashIcon`, not `Trash`). Pass them
   as components (`icon={TrashIcon}`); sizes are `ICON_SIZE.sm|md|lg|xl` (16/20/24/32). Decorative
   icons get `aria-hidden="true"`.
6. **Words.** Sentence case. Buttons say what happens ("Revoke connection", never "OK"); the toast
   uses the same verb ("Connection revoked"). Visibility and roles use `VISIBILITY_META` and
   `ROLE_META` labels everywhere ("Specific people" for `allowlist`).
7. **Modes.** Never branch on the theme in code; tokens switch. `data-theme="light|dark"` on any
   element renders that subtree in that mode.
8. **Motion.** Use `--duration-*` and `--ease-*`; they drop to 0 under reduced motion.

## Shells

| Component | Use | Key props |
| --- | --- | --- |
| `AppShell` | Signed-in pages. Top bar (logo, Dashboard, Connections, theme toggle, user menu), skip link, `<main id="main">`, toaster. Reads the user only through `useSession()`. | `onSignOut?`, `userMenuItems?: MenuEntry[]`, `extraNav?: {label,to}[]`, `width?: "content" \| "full"` |
| `PublicShell` | Signed-out pages: sign-in, consent, viewer gates, legal, home. | `width?: "narrow" \| "reading" \| "content"`, `centered?`, `headerEnd?` |

Do not add your own `<main>`; the shells render it. Start the page with `PageHeader` (it renders
the `h1`).

## Components

| Component | Notes | Key props |
| --- | --- | --- |
| `Button` | Primary once per view; danger only for what cannot be undone. `loading` keeps focus and width. | `variant: primary\|secondary\|ghost\|danger`, `size: sm\|md\|lg`, `icon`, `iconEnd`, `loading`, `block` |
| `IconButton` | Icon-only; `label` is required (its accessible name). Wrap in `Tooltip`. | `icon`, `label`, `variant`, `size`, `loading` |
| `ButtonLink` | In-app navigation styled as a button (router `Link`). | `to`, `variant`, `size`, `icon` |
| `buttonClassName()` | Classes for other elements that must look like a button (external `<a>`). | `{variant,size,iconOnly,block}` |
| `Input`, `Textarea`, `Select` | Label always present (`hideLabel` keeps it for screen readers). `error` sets `aria-invalid` and is read with the field. | `label`, `hint`, `error`, `hideLabel`, `mono`; `Select` takes `options` or `<option>` children |
| `Field` | Wires label/hint/error to a custom control via a render prop. | `label`, `hint`, `error`, `children(controlProps)` |
| `Checkbox` | Part of a form saved later. | `label`, `hint`, `indeterminate`, native input props |
| `Switch` | Applies at once. Native checkbox with `role="switch"`. | `label`, `hint`, native input props |
| `SegmentedControl` | One of a few options, radio semantics. | `label`, `options`, `value`, `onChange`, `size` |
| `Dialog` | Modal: focus moves in and is trapped, Escape closes, focus returns to the opener, page behind is inert. | `open`, `onClose`, `title`, `description`, `footer`, `size: sm\|md\|lg`, `initialFocus`, `role` |
| `ConfirmDialog` | Yes/no with a named action. `danger` uses `alertdialog` and focuses Cancel. | `open`, `onClose`, `onConfirm`, `title`, `description`, `confirmLabel`, `danger`, `loading` |
| `Menu` | Menu button: arrows, Home/End, typeahead, Escape returns focus. Items are actions or links. | `label`, `items: MenuEntry[]`, `icon`, `iconOnly`, `variant`, `align`, `triggerContent`, `header` |
| `Tabs` | Roving tabindex, arrows select, Home/End. Only the selected panel renders. | `label`, `tabs: {id,label,content,icon?,meta?,disabled?}[]`, `value`/`defaultValue`, `onChange` |
| `useToast()` | `toast.success(title, description?)`, `toast.error(...)`, `toast.toast({title, description, tone, duration, action})`. Live regions (polite, assertive for errors). Auto-hides; hover/focus pauses. Needs a shell (it mounts `Toaster`). | `ToastOptions` |
| `Badge` | Short static label; never color alone. | `tone: neutral\|strong\|accent\|success\|warning\|danger`, `icon`, `mono`, `srPrefix` |
| `VisibilityBadge` | public / unlisted / password / allowlist. | `visibility` |
| `RoleBadge` | owner / editor / commenter / viewer. | `value` |
| `Tooltip` | Hover and keyboard focus, Escape hides, `aria-describedby` on the trigger (skipped when it only repeats an `IconButton` label). Text only. | `content`, `children` (one focusable element), `placement`, `delay` |
| `EmptyState` | Says what is empty and what to do. Default art is the empty plinth. | `title`, `description`, `action`, `art`, `headingLevel`, `size` |
| `Skeleton`, `SkeletonText` | Loading placeholders, `aria-hidden`. Put `aria-busy="true"` on the loading region. | `width`, `height`, `radius`; `lines` |
| `Spinner` | For actions in progress; pass `label` to announce it. | `size`, `label` |
| `Card` | Groups settings and lists. | `as`, `variant: raised\|flat\|sunk`, `padding: none\|sm\|md\|lg`, `interactive` |
| `Exhibit` | The signature surface for artifacts: the piece on a wider base, wall label below. | `children` (the piece), `label`, `aspect`, `as` |
| `Stack`, `Row` | Flex column / wrapping row with gaps from the spacing scale. | `gap: Space`, `align`, `justify`, `as`; `Row` also `wrap` |
| `Container` | Centered column with the page gutter (the shells already use one). | `width: content\|reading\|narrow\|full` |
| `PageHeader` | The page title (`h1`, display serif), description, actions. | `title`, `description`, `actions`, `before`, `meta`, `headingLevel` |
| `ThemeToggle`, `ThemeSwitch` | Flip Gallery/After hours; or choose Gallery/After hours/System. | none; `size` |
| `IconProvider`, `ICON_SIZE` | Default icon size and weight (the shells render the provider). | |

Theme helpers live in `src/lib/theme.ts`: `useTheme()`, `useThemePreference()`, `setTheme()`,
`setThemePreference("light" | "dark" | "system")`, `THEME_NAMES`. The storage key
(`plinth-theme`) must match `public/theme.js`, which applies the theme before first paint.
