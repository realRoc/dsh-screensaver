# dsh-screensaver-theme-subspace · Subspace Jump

A three.js theme for [dsh-screensaver](../../README.md). Three suns orbit in normal space; as soon as one of your
Claude Code, Codex or DeepSeek Harness sessions starts running, the camera locks onto a portal and jumps into a
subspace tunnel, with each live session listed on the left (name, current step, running / waiting / done / stopped).
When everything is finished it leaves subspace and returns to the three suns.

```bash
dsh plugin --profile web add "github:realRoc/dsh-screensaver#path:/themes/subspace"
```

Then `/screensaver subspace`, or set `theme: subspace` in the dsh-screensaver config.

- Uses about 30 fps and a lower resolution on battery and on secondary displays.
- After 30 s without input (pure mode) the session list, banners and targeting box fade out.
- Open `index.html#demo` in a browser to watch a scripted demo; press D for the demo panel.

## Develop

```bash
npm install
npm run build      # rebuilds index.html from src/ and assets/ (commit index.html)
npm run demo
```

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
