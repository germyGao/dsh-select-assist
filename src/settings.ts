/**
 * 插件设置的宿主侧存取。
 *
 * 存哪儿：DSH home 下的 \`dsh-select-assist.json\`（\`DSH_HOME\` 优先，否则 \`~/.dsh\`）。
 * 为什么不走 \`ctx.settings\`：那是宿主设置文档的一层，写进去需要宿主挂载 settings provider
 * 与 schemastery schema；本插件要保持"零官方依赖、任何 profile 都能跑"，所以自带一个小
 * 文件 + 自带 HTTP 路由（浏览器半边用同源 fetch 读写）。
 *
 * 读写都很便宜（几百字节），所以每次跑一轮前现读，不做缓存——用户改完设置立刻生效。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_SETTINGS, normalizeSettings, type SelectionToolsSettings } from './shared/protocol.js'

/** 设置文件路径（\`DSH_HOME\` 优先）。 */
export function settingsFilePath(): string {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'dsh-select-assist.json')
}

/** 读设置（文件缺失/损坏都退回默认值，绝不让设置拖垮划词）。 */
export function loadSettings(): SelectionToolsSettings {
  try {
    const raw = readFileSync(settingsFilePath(), 'utf8')
    return normalizeSettings(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 写设置（先写临时文件再改名，避免半截文件）。 */
export function saveSettings(patch: unknown): SelectionToolsSettings {
  const current = loadSettings()
  const merged = normalizeSettings({ ...current, ...(typeof patch === 'object' && patch !== null ? patch : {}) })
  try {
    const file = settingsFilePath()
    mkdirSync(dirname(file), { recursive: true })
    const temporary = file + '.tmp'
    writeFileSync(temporary, JSON.stringify(merged, null, 2), 'utf8')
    renameSync(temporary, file)
  } catch {
    /* 写盘失败：本次仍返回新值（进程内可用），下次由用户重试 */
  }
  return merged
}
