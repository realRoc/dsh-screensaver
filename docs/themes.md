# Theme API

A theme is a folder:

```
my-theme/
  index.html    # the whole theme; runs in a sandboxed iframe (allow-scripts only, no network)
  saver.json    # { "id": "my-theme", "name": { "en": "My Theme", "zh": "我的主题" }, "sessions": true }
```

- `id`: lowercase letters, digits and `-`. Defaults to the folder name (or the package name without
  `dsh-screensaver-theme-`).
- `name`: a string, or `{ "en": ..., "zh": ... }` picked by the system language.
- `sessions`: `true` to receive local agent sessions. Only themes that ask get session names and progress.

The theme only draws. The shell around it owns the keyboard, mouse, Touch ID, the bottom hint and the top-right status
bar (battery, Wi-Fi, date and time). Keep `index.html` self-contained: the sandbox has an opaque origin, so inline your
scripts, styles and images (data: URLs). `themes/subspace/scripts/build.mjs` shows one way to bundle with esbuild.

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
```

Post `{ type: 'desk:ready' }` to `parent` once your script is running to get the current session list.

## Ship it

- Local: copy the folder to `~/.dsh/plugins-data/dsh-screensaver/themes/<id>/`.
- Package: add `"dsh-screensaver": { "theme": "." }` to `package.json` (the value is the folder inside the package) and
  install it into the same dsh profile as dsh-screensaver. Name it `dsh-screensaver-theme-<id>` so people can find it.
- Folder list: `DSH_SCREENSAVER_THEMES=/path/a:/path/b` (each path is a theme or a folder of themes).

When ids collide, the built-in theme wins, then packages, then `DSH_SCREENSAVER_THEMES`, then the data folder.
