---
name: dsh-screensaver-theme
description: Build, port or review a theme (animated wallpaper) for dsh-screensaver, the macOS screen saver that keeps AI coding agents running. Covers the rules every theme follows whatever its art style - an idle scene and a running scene with transitions driven by live agent sessions, the session monitor, the top-right status bar and clock, Touch ID feedback, 30 s auto-hide (pure mode), secondary displays and battery, the #demo page, packaging, and the README GIFs. Use when creating a new dsh-screensaver theme, turning a three.js / canvas / CSS scene into one, or checking a theme before a PR.
---

# dsh-screensaver themes

A theme is a folder with `index.html` and `saver.json` that the screen saver shows in a sandboxed iframe while the user
is away. The **art style is free**: scenes, palette, fonts, how the session list or the clock looks. What is fixed is
**where things are, what they mean and when they show**, so every theme feels like the same product. The API source of
truth is [docs/themes.md](../../docs/themes.md); the shell is `app/shell/`. Reference themes:

- `themes/subspace` (Subspace Jump): three suns → warp tunnel. Lets the shell draw the status bar and hint.
- `themes/magic-tower` (Arcane Study): a knight reading in a moonlit study → climbing the tower. Draws its own status bar
  and Touch ID hint (`"hud": true`).

Read the one closest to your idea before you start; copy its `scripts/build.mjs`, demo panel and session code.

**Series with their own art direction.** A theme that belongs to the *Pixel Magic* series (today: `themes/magic-tower`)
must also follow [docs/pixel-magic/BIBLE.md](../../docs/pixel-magic/BIBLE.md): visual hierarchy, composition, light,
palette, pixel grid, effects and animation rules, plus the style check. That bible applies to this series only; other
themes keep a free art style.

## The rules

### 1. Two scenes, driven by sessions

- **Idle scene**: no session is `running` or `waiting`. Calm, slow, fine to watch for hours.
- **Running scene**: at least one session is `running` or `waiting`. Visibly more energetic: the "agents are working" look.
- **Enter** when sessions are live and the idle scene has lasted at least 1.5 s.
  **Leave** when nothing has been live for `GRACE` = 15 s (3 s in `#demo`) and the running scene has lasted at least 3 s.
- Transitions are continuous camera or scene moves of about 4-9 s (a portal, a dive, a jump), never a cut or a fade
  through black or white. If the state flips mid-transition, queue the opposite transition; don't snap.
- Use the same state names in code and in `window.__<theme>.state` (for example `idle / enter / run / leave`).

```
idle ──sessions live, idle ≥ 1.5 s──▶ enter ──▶ run ──nothing live for GRACE, run ≥ 3 s──▶ leave ──▶ idle
```

### 2. Session monitor (left)

- Position: left middle, `left: 3.4vw; top: 50%; translate: 0 -50%; width: min(400-420px, 34vw)`.
- List the sessions of **this run**: everything live, plus anything that ended after the current enter began. Keep
  ended rows (dimmed) until you are back in idle; hide the whole panel when nothing is listed and 18 s after returning
  to idle.
- Each row: the product icon (`claude`, `codex`, `dsh`: use the official icons shipped in the reference themes; they
  are trademarks used only to say which product a session belongs to), the session name (one line, truncate the end),
  the current step `progress` (one line), the status, and the elapsed time `mm:ss` (`endedAt ?? now` − `startedAt`).
- The four statuses always mean the same thing and must look different from each other. The labels can speak in
  your theme's voice (Arcane Study says 术式流转 / 静候谕令 / 秘卷既成 / 术式中断) as long as each still reads as
  its meaning; the plain labels are:

  | status | zh | en | meaning |
  | --- | --- | --- | --- |
  | `running` | 运行中 | Running | working |
  | `waiting` | 等你确认 | Needs you | blocked on the user, make it stand out |
  | `done` | 已完成 | Done | finished this turn |
  | `aborted` | 已中断 | Stopped | stopped or failed |

- Header: what the scene is doing (entering / in the running scene / leaving / back in idle) and `n running` or
  `wrapping up`. Footer: `Done n · Stopped n` and how long this run has lasted.
- `progress` comes from fixed templates in `app/agents.js` (`读取 x` / `Read x`, `本轮完成` / `Turn finished`, …). A
  theme may reword the known templates in its own voice; keep file names and commands as they are.
- Re-render at most 4 times a second. Validate every field (`id` string, `kind` one of the three, `status` one of the
  four, `startedAt` number) and treat names and steps as text, never HTML.

### 3. Top-right status bar and clock

- Default: the shell draws battery, Wi-Fi and the date and time like the macOS menu bar. Leave the top-right 40 px clear.
- `"hud": true` in `saver.json`: you draw them, in your style, **in the same place**: `top: 6px; right: 14px;
  height: 24px`, items in this order: battery %, battery, Wi-Fi, (extras), date, time.
  - Date and time in the menu-bar format, computed by you and updated on the minute:
    zh `11月15日 周日 下午6:10`, en `Sun Nov 15 6:10 PM`.
  - Battery from `desk:status`: percent, red-ish at ≤ 20 % when unplugged, a charging mark when plugged; hide it when
    `battery` is null. Wi-Fi: 3 bars at ≥ −60 dBm, 2 at ≥ −70, else 1; all dim when not connected; a slash when off;
    hide when `wifi` is null.
  - Show your status bar and hint only after the first `desk:hint` arrives. An older shell never sends it and keeps
    drawing its own, so drawing yours anyway would show two clocks.

### 4. Touch ID and the hint (`"hud": true` only)

- The hint line is centred `7vh` above the bottom edge. Keep `desk:hint.text` (already localized: it says how to
  unlock and why it failed); you may put a phrase in your theme's voice before it, or replace the `verifying` text.
  Style it by `state`: `idle`, `verifying`, `failed`.
- When the sensor is touched, macOS shows its own fingerprint icon for about 2.4 s, centred about `7vh + 52px` above the
  bottom. Draw around it (a ring, a glow, particles) but never over it or over the hint text.
- `desk:touch.result`: `match` → success feedback (the screen saver closes about 0.5 s later); `miss` → failure feedback
  and a "not recognized, try again" line for about 2.4 s; `''` (older helper) → neutral feedback.
- A `verifying` or `failed` hint (the user pressed a key) replaces touch feedback immediately; an `idle` hint waits
  until the touch feedback ends.

### 5. Pure mode: hide after 30 s

- The shell sends `{ type: 'desk:pure', on: true }` after 30 s without input and `on: false` on any mouse move, key or
  touch. On `true`, fade out **every overlay** (session list, banners, status bar, hint, Touch ID ring) over about
  1.2 s and keep only the animation. Use `opacity` with `!important` so per-frame inline styles can't override it.
- In `#demo` there is no shell: do the same yourself (30 s without mouse, key or touch → hide; any input → show), and
  turn it off with `#demo,nopure` for recordings.

### 6. Displays, battery, long runs

- `desk:sessions.primary === false` (secondary display): scene only, no text at all, ≤ 30 fps, pixel ratio about 0.75.
- `lowPower === true` (on battery): ≤ 30 fps, pixel ratio 1. Otherwise ≤ 60 fps, pixel ratio ≤ 1.25.
- It runs for hours: clamp `dt` (≤ 0.05 s), reuse geometry and materials, no growing arrays, no per-frame allocations
  in hot paths, and keep time-based shader inputs from losing float precision after many hours (wrap them or keep
  the multipliers small).

### 7. Sandbox and messages

- The iframe is `sandbox="allow-scripts"` with an opaque origin and no network: inline all scripts, styles, images and
  data (`data:` URLs), no `fetch`, no storage, no top-level `await` waiting on loads. Bundle with esbuild into the
  committed `index.html`; set a CSP like `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:`.
- Listen with `addEventListener('message', …)`, ignore anything whose `e.source !== parent`, and post
  `{ type: 'desk:ready' }` to `parent` as soon as your listener is up.
- Messages: `desk:sessions`, `desk:pure`, and for hud themes `desk:hint`, `desk:status`, `desk:touch`. Shapes are in
  [docs/themes.md](../../docs/themes.md).

### 8. Language and accessibility

- `?lang=zh|en` decides every string; set `document.documentElement.lang`. Give the canvas `role="img"` and an
  `aria-label` describing both scenes.
- Run CSS motion in the UI (spinning rings, pulses, slide-ins) only under `@media (prefers-reduced-motion:
  no-preference)`; keep colour and opacity changes. Nothing may flash more than three times a second.

### 9. Demo page

- `index.html#demo` in a plain browser plays a scripted run: sessions appear over a few seconds, one goes `waiting`
  and back, some finish, one is stopped, all finish, and it loops once back in idle.
- `D` toggles a `#dev` panel with buttons `data-a="claude" | "codex" | "dsh" | "done" | "abort" | "wait" | "all"`
  (hud themes add `touch:match`, `touch:miss`, `pure`). Any manual click stops the script.
- Expose `window.__<theme> = { state, step(sec) }`, where `step` advances without `requestAnimationFrame`, for
  screenshots and the recorder below.
- With no shell, a hud theme fakes one: an idle hint, a battery and Wi-Fi reading.

### 10. Package and README

- A theme in this repo ships inside the dsh-screensaver package. Folder `themes/<id>/` with `index.html` (built,
  committed), `saver.json` (`{ "id", "name": { "zh", "en" }, "sessions": true, "hud": true? }`), `README.md`,
  `LICENSE`, `THIRD_PARTY_NOTICES.md`, the source (`src/`, `assets/`, `scripts/build.mjs`) and a `"private": true`
  `package.json` for its build dependencies. List `index.html`, `saver.json`, `README.md`, `LICENSE` and
  `THIRD_PARTY_NOTICES.md` in the root `package.json` `files` (a test checks it) and add the build to the root
  `build:themes` script.
- A theme published on its own (outside this repo) is an npm package named `dsh-screensaver-theme-<id>` with
  `"dsh-screensaver": { "theme": "." }` in its `package.json`; see [docs/themes.md](../../docs/themes.md).
- Themes in this repo are CC BY-NC-SA 4.0 and must be original: no characters, art or music from existing games or
  films. Your own theme outside the repo can use any license.
- Add the theme to the tables in `README.md`, `README.zh-CN.md` and `llms.txt`, with two GIFs:
  - `docs/images/<id>-enter.gif`: 3 s idle → transition → 5 s running.
  - `docs/images/<id>-exit.gif`: 3 s running → transition → 5 s idle.
  Record them with [scripts/record-gif.mjs](scripts/record-gif.mjs) (480 px, 10 fps, about 4-6 MB each).

## Before you open a PR

- [ ] `#demo` runs a full loop idle → running → idle with no console errors, in zh and en.
- [ ] Inside the shell (`DSH_SCREENSAVER_THEMES=$PWD/themes/<id> npm run now -- <id>`): sessions show, pure mode hides
      every overlay after 30 s, a key press shows the hint, Touch ID match / miss give feedback (hud themes).
- [ ] Secondary display shows the scene only; on battery the frame rate drops.
- [ ] Nothing covers the top-right status bar area, the hint line or the fingerprint icon.
- [ ] `index.html` rebuilt and committed; README tables and both GIFs added; `npm test` passes.
