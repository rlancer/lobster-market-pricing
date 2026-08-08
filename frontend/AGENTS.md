# AGENTS

Project-specific guidance for AI coding agents.

<!-- ASTRYX:START -->
Astryx v0.2.0 · 154 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   154 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->

## Workflow: branch protection

`main` is branch-protected — no direct pushes. Single-owner project, so no code
review is required, but every change still goes through a PR:

1. Create a feature branch: `git checkout -b feat/<slug>`.
2. Commit your work there and push: `git push -u origin feat/<slug>`.
3. Open a PR against `main` (`gh pr create --base main`), confirm the required
   checks pass, then merge when ready (`gh pr merge <n> --merge`) and assume the
   change is live.

Do not amend or force-push after the PR is opened.

## Always report the dev link with a PR

Every PR (and every non-`main` branch push) auto-deploys to the **Cloudflare
Pages dev project** `robs-options-slop-dev` via the `Deploy → dev` job in
`.github/workflows/deploy.yml`. When you open a PR, also give the dev URL.

The URL is the branch name with any `/` replaced by `-`:

- `https://<branch-slug>.robs-options-slop-dev.pages.dev/`

Example: branch `feat/free-openrouter-models` →
`https://feat-free-openrouter-models.robs-options-slop-dev.pages.dev/`

Confirm it went live: the `Deploy → dev` GitHub Action must succeed, and the URL
should return HTTP 200. The next push to the branch redeploys the same URL.

