# dsh-screensaver-theme-subspace · Subspace Jump

A three.js theme for [dsh-screensaver](https://github.com/realRoc/dsh-screensaver). Three suns orbit in normal space; as soon as one of your
Claude Code, Codex or DeepSeek Harness sessions starts running, the camera locks onto a portal and jumps into a
subspace tunnel, with each live session listed on the left (name, current step, running / waiting / done / stopped).
When everything is finished it leaves subspace and returns to the three suns.

Inside subspace the tunnel drifts between three art styles, switching every minute or so:

- **Nebula storm**: cloud walls that tear open onto a thunderstorm sky with lightning.
- **Surge vortex**: flying down the throat of a tornado made of ocean waves. The walls are twisted ropes of water
  that widen and narrow, and pillars cross the vent at an angle, flaring into the walls so they split it into
  separate channels (ray-marched signed distance field, rendered at reduced resolution).
- **Gaussian splats**: the walls are tens of thousands of flat elliptical Gaussians. Every so often a fire front burns
  them down to their glowing outlines and then to drifting embers, and a cyan wave puts them back together. The idea
  comes from [willeastcott/splat-walk](https://github.com/willeastcott/splat-walk)'s "burn to Gaussians"; this is
  a separate three.js implementation (no code or scan data from that project).

A new style does not fade in over the whole screen. It starts far down the tunnel, the boundary is eaten away
along the pattern with a glowing edge (the splats burn into outlines and embers there), and the camera flies
through it into the new style while the palette shifts.

「亚空间跃迁」：三颗恒星在常规宇宙里绕转；只要有 Claude Code、Codex 或 DeepSeek Harness 会话开始运行，镜头就锁定入口、跃迁进亚空间隧道，
左侧列出每个会话的名称、当前步骤和状态（运行中 / 等你确认 / 已完成 / 已中断）；全部结束后脱离亚空间，回到三星系统。
亚空间里有三种画风，一分钟左右换一种：星云雷暴；浪涌龙卷（在海浪卷成的龙卷风口里穿行，斜穿风口的柱子两头和洞壁长在一起，把风口分成几股）；
高斯粒子（壁由几万个高斯椭圆拼成，隔一阵被火线烧成轮廓和余烬、再被青色的波复原，玩法受 splat-walk 启发，代码是自己写的）。
换画风不是整屏淡入淡出：新画风从隧道前方远处长出来，交界被花纹啃出一圈亮边，镜头飞过交界就到了新画风里。
本主题是视觉作品，采用 CC BY-NC-SA 4.0，禁止商用。

```bash
dsh plugin --profile web add dsh-screensaver-theme-subspace
```

Then `/screensaver subspace`, or set `theme: subspace` in the dsh-screensaver config.

- Uses about 30 fps and a lower resolution on battery and on secondary displays.
- After 30 s without input (pure mode) the session list, banners and targeting box fade out.
- Open `index.html#demo` in a browser to watch a scripted demo; press D for the demo panel (it can also switch
  styles and ignite the splats). `index.html#demo,style=vortex` (or `nebula`, `splat`) stays in one style.

## Develop

```bash
npm install
npm run build      # rebuilds index.html from src/ and assets/ (commit index.html)
npm run demo
```

CC BY-NC-SA 4.0 (no commercial use). See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE-ASSETS.md](https://github.com/realRoc/dsh-screensaver/blob/main/LICENSE-ASSETS.md).
