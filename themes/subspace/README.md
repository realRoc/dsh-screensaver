# dsh-screensaver-theme-subspace · Subspace Jump

A three.js theme for [dsh-screensaver](../../README.md). Three suns orbit in normal space; as soon as one of your
Claude Code, Codex or DeepSeek Harness sessions starts running, the camera locks onto a portal and jumps into a
subspace tunnel, with each live session listed on the left (name, current step, running / waiting / done / stopped).
When everything is finished it leaves subspace and returns to the three suns.

「亚空间跃迁」：三颗恒星在常规宇宙里绕转；只要有 Claude Code、Codex 或 DeepSeek Harness 会话开始运行，镜头就锁定入口、跃迁进亚空间隧道，
左侧列出每个会话的名称、当前步骤和状态（运行中 / 等你确认 / 已完成 / 已中断）；全部结束后脱离亚空间，回到三星系统。
本主题是视觉作品，采用 CC BY-NC-SA 4.0，禁止商用。

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

CC BY-NC-SA 4.0 (no commercial use). See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE-ASSETS.md](../../LICENSE-ASSETS.md).
