// 把 three.js + src/ 打成一段 ES module，精灵表和图标转成 data: 地址，一起塞进 index.html（提交进 git：从 GitHub 装主题时不用编译）。
// 屏保主题跑在沙盒 iframe 里（没有网络），只能用内联脚本。
//   node scripts/build.mjs           打一次
//   node scripts/build.mjs --watch   改 src/*.js 自动重打（改 src/index.html 模板要重新跑）
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
  format: 'esm',
  minify: process.env.MINIFY !== '0',   // MINIFY=0 for readable stack traces while debugging
  target: 'chrome130',
  loader: { '.png': 'dataurl', '.glb': 'binary', '.bin': 'binary', '.gz': 'binary' },
  write: false,
  logLevel: 'info',
  plugins: [{ name: 'inline-html', setup: (b) => b.onEnd((r) => { if (!r.errors.length) write(r.outputFiles[0].text) }) }],
}
if (process.argv.includes('--watch')) await (await esbuild.context(opts)).watch()
else await esbuild.build(opts)
