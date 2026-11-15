# Visual assets license / 视觉素材授权

**Code is MIT. Visual assets are CC BY-NC-SA 4.0: no commercial use.**
**代码是 MIT；视觉素材是 CC BY-NC-SA 4.0，禁止商用。**

## What is a visual asset here / 哪些算视觉素材

| Path | What | License |
| --- | --- | --- |
| `themes/**` (every theme: `basic` Clock, `subspace` Subspace Jump, and future themes in this repo) | The theme's visual design and everything that draws it: HTML, CSS, scenes, shaders, animation, generated `index.html` | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `docs/images/**` | Screenshots | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| Everything else: `app/`, `lib/`, `bin/`, `native/`, `test/`, docs text | The screen saver engine, dsh plugin, Touch ID helper, session detection, theme API | [MIT](LICENSE) |

| 路径 | 内容 | 授权 |
| --- | --- | --- |
| `themes/**`（本仓库所有主题：基础版「时钟」、「亚空间跃迁」，以及以后加进来的） | 主题的视觉设计和画出它的一切：HTML、CSS、场景、着色器、动画、打包出来的 `index.html` | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans) |
| `docs/images/**` | 截图 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans) |
| 其余：`app/`、`lib/`、`bin/`、`native/`、`test/`、文档文字 | 屏保引擎、dsh 插件、Touch ID 小程序、会话识别、主题接口 | [MIT](LICENSE) |

## You may / 你可以

- Use, modify and share the themes in personal, open-source and other **non-commercial** projects, with attribution
  (`realRoc/dsh-screensaver`), and share adaptations under CC BY-NC-SA 4.0.
- **Not** use them commercially: no selling, no bundling into paid products or services, no use in ads. For commercial
  use, ask the author first (open an issue).
- Build your own themes on the MIT theme API and license them however you like.

- 在个人、开源等**非商业**项目里使用、修改、再分发这些主题，须署名（`realRoc/dsh-screensaver`），改编后的作品须以 CC BY-NC-SA 4.0 发布；
- **不能商用**：不能卖、不能放进收费的产品或服务、不能用在广告里。商用请先联系作者（开 issue）；
- 用 MIT 的主题接口自己做主题，授权你自己定。

## Third-party content inside themes / 主题里的第三方内容

These keep their own terms and are not covered by the CC license above:

- **three.js** (bundled in `themes/subspace/index.html`): MIT, © three.js authors.
- **DeepSeek Harness whale** (`themes/subspace/assets/dsh.svg`): MIT, © 2026 DeepSeek (`@deepseek-ai/dsh-web-frontend`).
- **Claude mark** (`assets/claude.png`) and **Codex app icon** (`assets/codex.png`): trademarks of Anthropic and OpenAI.
  The DeepSeek whale is also a DeepSeek trademark. They are used only to identify which product a session belongs to.
  This project is not affiliated with or endorsed by these companies.

以上第三方内容按各自的条款，不在上面的 CC 授权范围内：three.js 是 MIT；DeepSeek Harness 鲸鱼图标是 MIT（© 2026 DeepSeek）；
Claude、Codex 图标和 DeepSeek 鲸鱼是各自公司的商标，只用来标出会话属于哪个产品，本项目与这些公司没有关联。
