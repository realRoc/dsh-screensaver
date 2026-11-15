// 包目录和数据目录。不碰 Electron：dsh 插件那边（lib/）和测试也用。
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 这个包的根目录（package.json 在的地方） */
export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 数据目录：合盖不睡的记号、编好的 Touch ID 小程序、用户自己放的主题 */
export function dataDir(env = process.env) {
  if (env.DSH_SCREENSAVER_HOME?.trim()) return env.DSH_SCREENSAVER_HOME.trim()
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins-data', 'dsh-screensaver')
}
