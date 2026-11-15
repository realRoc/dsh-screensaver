# dsh-screensaver

**A lock-screen-style screen saver for macOS that keeps your AI coding agents running while you step away.**
Touch the Touch ID sensor to unlock. While it is up, the Mac does not sleep, the display stays on, and (optionally)
closing the lid does not put the Mac to sleep. Themes can show your live **Claude Code**, **OpenAI Codex** and
**DeepSeek Harness** sessions: which ones are running, waiting for your approval, done or stopped.

It is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin, and it also runs on its own
with `npx`.

[中文说明](README.zh-CN.md) · [For AI agents: llms.txt](llms.txt) · [Theme API](docs/themes.md)

| Clock (built in) | Subspace Jump (separate theme package) |
| --- | --- |
| A macOS-style lock screen: date and time, battery, Wi-Fi, "Touch ID or Enter Password". | A three.js warp tunnel: when agents are running it jumps into subspace and lists each session. |

## Why not the macOS screen saver, the lock screen, or a wallpaper?

Short answer: **the system lock screen and screen saver are built for when nothing should be running.
dsh-screensaver is built for when your agents should keep running and you just want the screen covered.**

| | macOS lock screen (⌃⌘Q) | macOS screen saver | Wallpaper / live wallpaper | `caffeinate` / Amphetamine | **dsh-screensaver** |
| --- | --- | --- | --- | --- | --- |
| Covers the screen from passers-by | Yes (real system lock) | Yes, until a key is pressed (lock only if "require password") | No | No | **Yes** (a cover, not a security boundary) |
| CLI agents in a terminal (Claude Code, Codex CLI, dsh) keep running | Yes | Yes | Yes | Yes | **Yes** |
| Computer-use agents and extension-driven browsers keep running | No, they stop ([openai/codex#58545](https://github.com/openai/codex/issues/58545), [openai/codex#43869](https://github.com/openai/codex/issues/43869)) | Not tested | Yes | Yes | **Browser-extension agents keep running**; anything that must click the screen is covered |
| Covered browser windows keep full speed | No, the system treats them as hidden | Not tested | n/a | n/a | **Yes**: the cover is a tiny bit translucent, so the system still treats windows as visible |
| Prevents display sleep and system idle sleep | No: the display soon goes dark, and whether the Mac then sleeps depends on other apps ([anthropics/claude-code#81832](https://github.com/anthropics/claude-code/issues/81832)) | No | No | Yes | **Yes, while it is up** |
| Stays awake with the **lid closed** | No | No | No | No (sleep assertions cannot stop lid sleep) | **Optional** (`pmset disablesleep` with a one-time admin authorization, auto-restored) |
| Unlock | Touch ID or password | Key press (+ password) | n/a | n/a | **Just touch Touch ID**, or press any key / click for Touch ID or the login password |
| Shows what your agents are doing | No | No | No | No | **Yes** (themes that opt in: names, current step, running / waiting / done / stopped) |

**Which one should I use?** If you only run CLI agents and need real security (a café, an office), use ⌃⌘Q; you can still
turn on lid-closed awake with `/screensaver lid on` first. If you run computer-use or browser agents, or you just step
away at home and want the screen covered while everything keeps working, use dsh-screensaver.

> dsh-screensaver is **not a security boundary**: holding the power button still works, and it does not replace the
> macOS login. It keeps people walking by from reading your screen or typing into your agents.

## Install

### As a DeepSeek Harness plugin

```bash
dsh plugin --profile web add github:realRoc/dsh-screensaver
```

Use `desktop` instead of `web` for the desktop app profile, then restart dsh. The first start downloads the Electron
runtime (about 100 MB, once) and compiles the Touch ID helper if the Xcode Command Line Tools are installed.

Themes are separate packages. Install only the ones you want:

```bash
dsh plugin --profile web add "github:realRoc/dsh-screensaver#path:/themes/subspace"
```

### Without dsh

```bash
npx github:realRoc/dsh-screensaver --now            # cover the screen now, exit after you unlock
npx github:realRoc/dsh-screensaver                  # stay in the background, press ⌃⌥⌘L to start
npx github:realRoc/dsh-screensaver --now subspace   # with a theme (when it is installed or in DSH_SCREENSAVER_THEMES)
```

Requirements: macOS 12 or later, Node.js 22 or later. Touch-to-unlock needs a Mac with Touch ID (or a Magic Keyboard with
Touch ID) and the Xcode Command Line Tools (`xcode-select --install`); without them the system Touch ID / password dialog
is used instead.

## Use

- **Start:** ⌃⌥⌘L (Control+Option+Command+L), `/screensaver` in dsh, or ask your agent ("I'm stepping away, cover the
  screen"); it calls the `screensaver` tool. You can also start it automatically after N idle minutes.
- **Unlock:** touch the Touch ID sensor. Pressing any key or clicking opens the system dialog (Touch ID or login password).
- **Pure mode:** after 30 seconds without input, the hint, the status bar and the session list fade out and only the
  animation is left. Moving the mouse, pressing a key or touching Touch ID brings them back.

| Command | What it does |
| --- | --- |
| `/screensaver` | Start with the default theme |
| `/screensaver <theme>` | Start with a theme, e.g. `/screensaver subspace` |
| `/screensaver themes` | List installed themes |
| `/screensaver lid` | Show lid-closed awake status |
| `/screensaver lid authorize` | Allow lid-closed awake (asks for an admin password once; installs a sudoers rule that only allows `pmset -a disablesleep 0/1`) |
| `/screensaver lid on` / `off` | Turn lid-closed awake on or off by hand |
| `/screensaver lid revoke` | Remove the sudoers rule |

### Configuration

Add an entry to your profile's `~/.dsh/profiles/<profile>/cordis.patch.yml` (it replaces the whole config block):

```yaml
- id: dsh-screensaver
  config:
    theme: subspace      # default theme id
    idleMinutes: 10      # start after 10 idle minutes; 0 = never (default)
    lidAwake: true       # also keep the Mac awake with the lid closed while the screen saver is up
    shortcut: Control+Alt+Command+L   # Electron accelerator; '' disables the shortcut
```

Standalone, pass the same fields as JSON: `DSH_SCREENSAVER_CONFIG='{"theme":"subspace"}' npx github:realRoc/dsh-screensaver`.

## Themes

| Theme | id | Install | Shows agent sessions |
| --- | --- | --- | --- |
| Clock | `basic` | built in | No |
| Subspace Jump | `subspace` | `github:realRoc/dsh-screensaver#path:/themes/subspace` | Yes |

More themes are on the way. A theme is a folder with an `index.html` (runs in a sandboxed iframe, draws only) and a
`saver.json`. Put your own in `~/.dsh/plugins-data/dsh-screensaver/themes/<id>/`, or publish it as an npm package with
`"dsh-screensaver": { "theme": "." }` in its `package.json`. See [docs/themes.md](docs/themes.md).

## Which agent sessions are detected

Only themes that set `"sessions": true` receive sessions, and only while the screen saver is up. Everything is read from
local files every 2 seconds; nothing is sent anywhere.

| Agent | Where it reads | Running / waiting |
| --- | --- | --- |
| Claude Code | `~/.claude/sessions/<pid>.json`, `~/.claude/projects/**.jsonl` | process alive and status busy; waiting when status asks for permission or input |
| OpenAI Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/session_index.jsonl` | `task_started` without `task_complete` / `turn_aborted` |
| DeepSeek Harness | `$DSH_HOME/sessions/*/*/session.v4.jsonl.zstd` + `session.lock` | a dsh process holds the session lock and the last `turn/start` has no `turn/end`; waiting on an open `approval/asked` or `ask_user_question` |

The theme shows each product's own icon (the Claude mark, the Codex app icon and the DeepSeek Harness whale) to label
sessions. They are trademarks of their owners and are used only to identify those products.

## How it works

- A small always-on-top window covers each display; the primary one runs in kiosk mode (hides the Dock and menu bar,
  blocks ⌘Tab and Force Quit).
- `desk-unlock`, a Swift helper (`native/unlock/main.swift`), embeds the system Touch ID view (`LAAuthenticationView`) in
  an invisible window above the screen saver, so touching the sensor unlocks with no dialog. It also reads battery and
  Wi-Fi for the status bar (IOKit, CoreWLAN; no location permission, the network name is not read).
- While up: `powerSaveBlocker('prevent-display-sleep')`. With `lidAwake`: `pmset -a disablesleep 1`, restored when the
  screen saver closes, when the process dies (a detached watchdog), at the next start if it was left on, and when the
  battery drops to 20%.

## FAQ

**Will my Claude Code / Codex / DeepSeek Harness session keep running while the screen saver is on?**
Yes. Terminal agents are not affected at all, the Mac does not idle-sleep, and the display does not turn off.

**Does it work when I close the MacBook lid?**
Only with lid-closed awake: run `/screensaver lid authorize` once, then set `lidAwake: true` or use `/screensaver lid on`.
Keep the Mac plugged in; it turns itself off at 20% battery.

**Is it a replacement for the macOS lock screen?**
No. It is a cover for when you step away at home or in the office and want your agents to keep working. For real
security use ⌃⌘Q.

**Do I need DeepSeek Harness?**
No. `npx github:realRoc/dsh-screensaver` runs it standalone. dsh adds the `/screensaver` command, the agent tool and
config.

**Does it work on Windows or Linux?**
Not yet; it is macOS-only for now.

**Does it send data anywhere?**
No. It reads local session files and system status, and it makes no network requests (apart from the one-time
Electron download on first run).

## Develop

```bash
git clone https://github.com/realRoc/dsh-screensaver && cd dsh-screensaver
npm install
npm test                       # vitest
npm run now                    # try it
npm run build:themes           # rebuild themes/subspace/index.html after editing themes/subspace/src
DSH_SCREENSAVER_DEBUG=1 npm run now   # log page console messages
```

## License

MIT. Third-party notices: [themes/subspace/THIRD_PARTY_NOTICES.md](themes/subspace/THIRD_PARTY_NOTICES.md).

<!-- Keywords: screen saver for AI coding agents, keep Claude Code running when away, keep Codex running, prevent Mac sleep
while an agent runs, macOS lock screen alternative, Touch ID screen saver, keep Mac awake with lid closed, caffeinate
alternative, Amphetamine alternative, AFK screen for developers, DeepSeek Harness plugin, dsh plugin, agent session
monitor, Claude Code status screen, Codex status screen, 屏保, 锁屏, 防休眠, 合盖不睡 -->
