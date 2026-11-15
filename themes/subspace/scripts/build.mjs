// 把 three.js + src/main.js 打成一段，图标转成 data: 地址，一起塞进 index.html（提交进 git：从 GitHub 装主题时不用编译）。
// 屏保主题跑在沙盒 iframe 里，只能用内联脚本。
//   node scripts/build.mjs           打一次
//   node scripts/build.mjs --watch   改 main.js 自动重打（改 src/index.html 模板要重新跑）
import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml' }
const icon = (f) => `data:${MIME[extname(f)]};base64,${readFileSync(join(ROOT, 'assets', f)).toString('base64')}`

function write(js) {
  const html = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8')
    .replaceAll('__ICON_CLAUDE__', icon('claude.png'))
    .replaceAll('__ICON_CODEX__', icon('codex.png'))
    .replaceAll('__ICON_DSH__', icon('dsh.svg'))
    .replace('/*__SCRIPT__*/', () => js.replace(/<\/script/gi, '<\\/script'))
  writeFileSync(join(ROOT, 'index.html'), html)
  console.log(`index.html ${(html.length / 1024).toFixed(0)} KB`)
}

const opts = {
  entryPoints: [join(ROOT, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'chrome130',
  write: false,
  logLevel: 'info',
  plugins: [{ name: 'inline-html', setup: (b) => b.onEnd((r) => !r.errors.length && write(r.outputFiles[0].text)) }],
}
if (process.argv.includes('--watch')) await (await esbuild.context(opts)).watch()
else await esbuild.build(opts)
