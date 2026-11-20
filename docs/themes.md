# Theme API

Building a theme with a coding agent? Give it [skills/dsh-screensaver-theme](../skills/dsh-screensaver-theme/SKILL.md):
the layout, timing and behaviour rules every theme follows, on top of the API below.

The theme API (this document, the shell and the message formats) is MIT: build your own theme on it and license it
however you like. The themes shipped in this repo are CC BY-NC-SA 4.0 (see [LICENSE-ASSETS.md](../LICENSE-ASSETS.md)).

A theme is a folder:

```
my-theme/
  index.html    # the whole theme; runs in a sandboxed iframe (allow-scripts only, no network)
  saver.json    # { "id": "my-theme", "name": { "en": "My Theme", "zh": "我的主题" }, "sessions": true, "hud": true }
```

- `id`: lowercase letters, digits and `-`. Defaults to the folder name (or the package name without
  `dsh-screensaver-theme-`).
- `name`: a string, or `{ "en": ..., "zh": ... }` picked by the system language.
- `sessions`: `true` to receive local agent sessions. Only themes that ask get session names and progress.
- `hud`: `true` to draw the top-right status bar and the bottom hint yourself, in your theme's style. The shell hides its
  own and sends you what they would show (`desk:status`, `desk:hint`, `desk:touch` below). Keep them where the shell
  puts them: status bar at the top right like the menu bar (`top: 6px; right: 14px; height: 24px`), hint centred
  `7vh` above the bottom edge. The system Touch ID icon still appears above the hint when the sensor is touched
  (centre about `7vh + 52px` from the bottom); draw around it, not over it. The time and date you compute yourself.

The theme only draws. The shell around it owns the keyboard, mouse, Touch ID, the bottom hint and the top-right status
bar (battery, Wi-Fi, date and time), unless the theme sets `"hud": true`. Keep `index.html` self-contained: the sandbox has an opaque origin, so inline your
scripts, styles and images (data: URLs). `themes/subspace/scripts/build.mjs` shows one way to bundle with esbuild;
`themes/magic-tower` uses `"hud": true`.

## Query string

`index.html?lang=zh|en`: the system language, so you can localize text.

## Messages from the shell

Listen with `addEventListener('message', ...)` and check `event.source === parent`.

```js
// Sent after you post { type: 'desk:ready' } to parent, and whenever something changes (themes with "sessions": true).
{
  type: 'desk:sessions',
  primary: true,      // false on secondary displays: draw the background only
  lowPower: false,    // on battery: lower the frame rate / resolution
  sessions: [
    {
      id: 'dsh:session-…',
      kind: 'claude' | 'codex' | 'dsh',
      name: 'Fix flaky test',
      status: 'running' | 'waiting' | 'done' | 'aborted',
      progress: 'bash npm test',   // one short line, already localized
      startedAt: 1793286283011,    // ms
      endedAt: 1793286999000,      // ms, when done / aborted
    },
  ],
}

// Pure mode: 30 s without input. Hide your overlays (text, lists) and keep only the animation.
{ type: 'desk:pure', on: true | false }

// Only on the primary display, and only to themes with "hud": true. A desk:hint means the shell has handed you the
// status bar and the hint, so show yours once it arrives (an older shell never sends it and draws its own).
// The hint line, already localized: 'Touch ID or Enter Password', 'Verifying…', 'Still locked: …', 'Incorrect password. Try again'.
{ type: 'desk:hint', text: 'Touch ID or Enter Password', state: 'idle' | 'verifying' | 'failed' }
// Battery and Wi-Fi, every 20 s. null when the Mac has none or it could not be read.
{ type: 'desk:status', battery: { percent: 82, plugged: false } | null, wifi: { on: true, connected: true, rssi: -52 } | null }
// The Touch ID sensor was touched. 'match': recognized (the screen saver closes about half a second later);
// 'miss': not recognized, the user can try again; '': an older Touch ID helper that can't tell.
{ type: 'desk:touch', result: 'match' | 'miss' | '' }
```

Post `{ type: 'desk:ready' }` to `parent` once your script is running to get the current session list.

## Ship it

- Local: copy the folder to `~/.dsh/plugins-data/dsh-screensaver/themes/<id>/`.
- Package: add `"dsh-screensaver": { "theme": "." }` to `package.json` (the value is the folder inside the package) and
  install it into the same dsh profile as dsh-screensaver. Name it `dsh-screensaver-theme-<id>` so people can find it.
- Folder list: `DSH_SCREENSAVER_THEMES=/path/a:/path/b` (each path is a theme or a folder of themes).

When ids collide, the built-in theme wins, then packages, then `DSH_SCREENSAVER_THEMES`, then the data folder.
