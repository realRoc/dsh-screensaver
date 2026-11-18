# Arcane Study（魔法书斋）· dsh-screensaver theme

An HD-2D theme for [dsh-screensaver](https://github.com/realRoc/dsh-screensaver). While nothing is running, a knight
reads at a desk in a tower study, lit by a crystal full moon through a tall window. As soon as one of your Claude Code,
Codex or DeepSeek Harness sessions starts running, the camera dives into the open book, a rune portal opens, and the
knight climbs the spiral book stairs of the tower. When everything has finished (after a 15 s grace period) a book flies
up to the camera, opens, and you are back in the study.

The interface follows the same layout as the shell and the Subspace Jump theme, drawn in the tower's style:

- **Left, session ledger**: a moonlit glass page with gold corners. Each session has a rune ring around its product
  icon: blue and turning while it runs, amber and breathing when it needs you, a closed gold ring when done, a broken
  crimson ring when stopped. Running sessions have a thread of light under them; the current step fades in like fresh
  ink. The footer counts done / stopped sessions and how long this climb took.
- **Top right, status bar**: battery as a mana vial (crimson at 20% and below), Wi-Fi, tonight's real moon phase, and
  the date and time, where the menu bar would be.
- **Bottom centre, Touch ID**: a rune circle around the system fingerprint icon. Touching the sensor lights it gold when
  recognized and crimson with "The Seal Does Not Match. Touch Again" when not. The hint underneath reads "Enter the
  Moonlit Study · Touch ID or Enter Password", "Starlight Awakens…" while verifying, and "The Glintstone Fades · …"
  with the reason when unlocking fails.
- **Wording**: the interface speaks in the study's voice: "The Stars Keep Vigil" while agents run, "The Spell Unfolds",
  "Awaiting Your Command", "The Tome Is Complete" and "The Spell Is Broken" for the four statuses, "The Tomes Lie
  Still" when everything is done. Known step templates are reworded too ("Read x" → "Consulting the Archives · x");
  file names and commands stay as they are.

The theme sets `"hud": true` in `saver.json`, so the shell hands it the status bar and hint. With an older
dsh-screensaver the shell keeps drawing its own and the theme only shows the scene and the session ledger.

「魔法书斋」：没有任务在跑时，塔顶书房里骑士在月光下读书，长窗外一轮晶莹的满月；有 Claude Code、Codex 或 DeepSeek Harness 会话开始跑，
镜头扎进书页、穿过符文传送门进塔，骑士沿螺旋书阶上行；全部结束（宽限 15 秒）一本书飞到镜头前打开，回到书房。
左侧「此夜纪事」列出每个会话（法印环：蓝色转动是「术式流转」、琥珀色是「静候谕令」、金色闭环是「秘卷既成」、红色断环是「术式中断」，有任务在跑时标题是「群星未眠」），右上角是法力药瓶样式的电池、Wi-Fi、
今晚真实的月相和日期时间，中间下方是套在系统指纹图标外面的法阵：认出来亮金色，没认出来变红并提示「指印未合，再触一次」；底部提示是「月下入阁 · 使用触控 ID 或输入密码」，验证时「星辉渐明…」。
位置和外壳、亚空间主题一样。本主题是视觉作品，采用 CC BY-NC-SA 4.0，禁止商用。

Ships inside [dsh-screensaver](../../README.md); nothing else to install:

```bash
dsh plugin --profile web add dsh-screensaver
```

Then `/screensaver magic-tower`, or set `theme: magic-tower` in the dsh-screensaver config.

- Up to 60 fps on the main display; 30 fps and a lower resolution on battery and on secondary displays (scene only).
- After 30 s without input (pure mode) the ledger, status bar, hint and seal fade out, like every theme.
- Open `index.html#demo` in a browser to watch a scripted demo; press D for the demo panel (add sessions, finish them,
  simulate Touch ID). `index.html?lang=en#demo` for English. The demo hides the interface after 30 s without input
  too; `#demo,nopure` keeps it on (used to record the README GIFs).
- Built to the rules in [skills/dsh-screensaver-theme](../../skills/dsh-screensaver-theme/SKILL.md).

## Develop

```bash
npm install
npm run build      # rebuilds index.html from src/ and assets/ (commit index.html)
npm run demo
```

`src/scene.js` and `src/study.js` are the scene, `src/hud.js` the interface, `src/main.js` ties sessions to the scene.

CC BY-NC-SA 4.0 (no commercial use). See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE-ASSETS.md](https://github.com/realRoc/dsh-screensaver/blob/main/LICENSE-ASSETS.md).
