# dsh-screensaver

**macOS 上给 AI 编程代理用的屏保：人走开，代理接着跑。**
长得像系统锁屏，摸一下 Touch ID 就解开。屏保开着时电脑不睡、屏幕不黑，还可以合盖不睡。
主题可以显示本机 **Claude Code**、**OpenAI Codex**、**DeepSeek Harness** 会话：哪个在跑、哪个等你确认、哪个跑完了。

它是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件，不装 dsh 也能用 `npx` 单独跑。

[English](README.md) · [给 AI 看的 llms.txt](llms.txt) · [主题接口](docs/themes.md)

![亚空间跃迁主题：跃迁中列出 Claude Code、Codex、DeepSeek Harness 会话](docs/images/subspace-zh.jpg)

| 时钟（自带） | 亚空间跃迁（单独的主题包） |
| --- | --- |
| ![时钟主题：照着 macOS 锁屏，日期时间、电池、Wi-Fi、「使用触控 ID 或输入密码」](docs/images/basic-zh.jpg) | three.js 跃迁隧道（上图）：有代理在跑就进亚空间，左边列出每个会话，用各家自己的图标标出来。 |

## 跟系统锁屏、系统屏保、壁纸有什么不一样

一句话：**系统锁屏和屏保是给「电脑上什么都不该跑」的时候用的；dsh-screensaver 是给「代理得接着跑，只是屏幕要盖上」的时候用的。**

| | 系统锁屏（⌃⌘Q） | 系统屏保 | 壁纸 / 动态壁纸 | caffeinate / Amphetamine | **dsh-screensaver** |
| --- | --- | --- | --- | --- | --- |
| 挡住路过的人 | 能（真正的系统锁） | 碰一下就没了（开了「需要密码」才锁） | 不能 | 不能 | **能**（只是遮挡，不是安全边界） |
| 终端里的代理（Claude Code、Codex CLI、dsh） | 照常跑 | 照常跑 | 照常跑 | 照常跑 | **照常跑** |
| 操作电脑类的代理、扩展驱动的浏览器 | 会停（[openai/codex#58545](https://github.com/openai/codex/issues/58545)、[openai/codex#43869](https://github.com/openai/codex/issues/43869)） | 没测过 | 照常 | 照常 | **浏览器扩展这类照常跑**；要点屏幕的操作会被挡住 |
| 被盖住的浏览器窗口不降频 | 不行，系统当它不可见 | 没测过 | — | — | **行**：屏保留了一点点透明，系统仍当窗口可见 |
| 不黑屏、不空闲睡眠 | 不管：锁屏后很快黑屏，睡不睡看别的程序（[anthropics/claude-code#81832](https://github.com/anthropics/claude-code/issues/81832)） | 不管 | 不管 | 管 | **屏保开着时一直管** |
| **合盖**不睡 | 不行 | 不行 | 不行 | 不行（防睡断言管不了合盖） | **可选**（`pmset disablesleep`，授权一次，自动恢复） |
| 解锁 | Touch ID 或密码 | 按键（+ 密码） | — | — | **直接摸 Touch ID**，或按键 / 点一下弹系统验证框 |
| 看得到代理在干什么 | 不能 | 不能 | 不能 | 不能 | **能**（主题声明了要会话：名字、当前步骤、在跑 / 等确认 / 完成 / 中断） |

**怎么选：** 只跑终端里的代理、又在乎安全（咖啡馆、办公室），用 ⌃⌘Q，要合盖不睡先 `/screensaver lid on`；
跑操作电脑、浏览器类的代理，或者在家走开一下、只想把屏幕盖上，用 dsh-screensaver。

> dsh-screensaver **不是安全边界**：长按电源键之类的拦不住，也替代不了 macOS 登录。它挡的是路过的人看屏幕、碰键盘。

## 安装

```bash
dsh plugin --profile web add github:realRoc/dsh-screensaver
```

桌面应用把 `web` 换成 `desktop`，装完重启 dsh。第一次启动会下载 Electron（约 100 MB，只下一次），
装了 Xcode 命令行工具的话还会在本机编 Touch ID 小程序。

主题单独装，要哪个装哪个（比如只要基础版就不用装这个）：

```bash
dsh plugin --profile web add "github:realRoc/dsh-screensaver#path:/themes/subspace"
```

不装 dsh：

```bash
npx github:realRoc/dsh-screensaver --now            # 马上开屏保，解开后退出
npx github:realRoc/dsh-screensaver                  # 常驻后台，按 ⌃⌥⌘L 开
```

要求：macOS 12 及以上，Node.js 22 及以上。「直接摸就解开」要有 Touch ID（或带 Touch ID 的妙控键盘）和 Xcode 命令行工具
（`xcode-select --install`），没有就用系统的 Touch ID / 密码框。

## 用法

- **开：** ⌃⌥⌘L、dsh 里输 `/screensaver`，或者跟代理说「我走开一下，帮我把屏幕盖上」（它会调 `screensaver` 工具）；
  也可以配置空闲 N 分钟自动开。
- **解：** 摸 Touch ID；按任意键或点一下弹系统验证框（Touch ID 或登录密码）。
- **纯享：** 30 秒没人动，底部提示、右上角状态栏、会话播报都淡掉，只剩画面；动鼠标、按键、摸 Touch ID 再露出来。

| 命令 | 作用 |
| --- | --- |
| `/screensaver` | 用默认主题开 |
| `/screensaver <主题>` | 用某个主题开，比如 `/screensaver subspace` |
| `/screensaver themes` | 列出装了哪些主题 |
| `/screensaver lid` | 看合盖不睡的状态 |
| `/screensaver lid authorize` | 授权合盖不睡（输一次管理员密码，装一条只放行 `pmset -a disablesleep 0/1` 的 sudoers 规则） |
| `/screensaver lid on` / `off` | 手动开关合盖不睡 |
| `/screensaver lid revoke` | 删掉那条规则 |

配置写在 `~/.dsh/profiles/<profile>/cordis.patch.yml`（整段替换）：

```yaml
- id: dsh-screensaver
  config:
    theme: subspace      # 默认主题
    idleMinutes: 10      # 空闲 10 分钟自动开；0 不自动开（默认）
    lidAwake: true       # 开屏保时顺便合盖不睡
    shortcut: Control+Alt+Command+L   # Electron 快捷键写法；'' 不注册
```

## 主题

| 主题 | id | 安装 | 显示代理会话 |
| --- | --- | --- | --- |
| 时钟 | `basic` | 自带 | 否 |
| 亚空间跃迁 | `subspace` | `github:realRoc/dsh-screensaver#path:/themes/subspace` | 是 |

后面还会出更多主题。主题就是一个目录：`index.html`（在沙盒 iframe 里跑，只管画）+ `saver.json`。
自己做的放 `~/.dsh/plugins-data/dsh-screensaver/themes/<id>/`，或者发成 npm 包，`package.json` 里写
`"dsh-screensaver": { "theme": "." }`。接口见 [docs/themes.md](docs/themes.md)。

## 认得哪些代理会话

只有 `saver.json` 写了 `"sessions": true` 的主题、并且只在屏保开着时才读；每 2 秒读一次本机文件，不连网。

| 代理 | 读哪里 | 怎么算在跑 / 等你 |
| --- | --- | --- |
| Claude Code | `~/.claude/sessions/<pid>.json`、`~/.claude/projects/**.jsonl` | 进程活着、状态 busy；要权限、要输入时算等你 |
| OpenAI Codex | `~/.codex/sessions/年/月/日/rollout-*.jsonl` | 最后一个 `task_started` 之后没有 `task_complete` / `turn_aborted` |
| DeepSeek Harness | `$DSH_HOME/sessions/*/*/session.v4.jsonl.zstd` + `session.lock` | 有 dsh 进程锁着会话、最后一个 `turn/start` 没有 `turn/end`；有没回复的 `approval/asked`、没回答的 `ask_user_question` 算等你 |

主题用各家自己的图标标出会话（Claude 的星芒、Codex 的 App 图标、DeepSeek Harness 的鲸鱼），商标归各自所有，只用来标识产品。

## 许可

MIT。第三方声明见 [themes/subspace/THIRD_PARTY_NOTICES.md](themes/subspace/THIRD_PARTY_NOTICES.md)。
