/**
 * dsh-select-assist —— 浏览器半边入口。
 *
 * 两处注册：
 * - \`shell.overlay\`：页内划词菜单 + 回答窗口（系统级伴生进程在跑时它让位）；
 * - \`settings.section\`：设置页里的「划词工具」一页（语言、规则、模型）。
 */
import { createElement } from 'react'

import { detectLocale } from './api'
import { Overlay } from './overlay'
import { SettingsSection } from './settings'
import { ensureStyles } from './styles'

/** 客户端 Cordis 上下文里本插件用到的面（避免依赖官方类型包）。 */
interface ClientContext {
  get?: (name: string) => any
  effect?: (callback: () => unknown, label?: string) => unknown
}

/** 槽位注册表的最小面。 */
interface SlotsService {
  inject: (key: string, callback: () => unknown) => void
  register: (options: Record<string, unknown>, component: unknown) => unknown
}

/** 硬依赖：槽位注册表。其余服务一律经 ctx.get 可选读取。 */
export const inject = ['slots']

/**
 * 挂载浏览器半边。
 * @param ctx - 客户端 Cordis 上下文。
 */
export function apply(ctx: ClientContext): void {
  ensureStyles()
  const slots = ctx.get?.('slots') as SlotsService | undefined
  if (slots === undefined) return
  slots.inject('shell.overlay', () =>
    slots.register(
      {
        name: 'shell.overlay',
        // 自己的 cell id：与官方条目并列，不替换任何现有条目。
        id: 'dsh-select-assist',
        order: 60,
      },
      () => createElement(Overlay, { ctx }),
    ),
  )
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'dsh-select-assist',
        order: 40,
        label: () => (detectLocale() === 'zh' ? '划词工具' : 'Selection tools'),
      },
      () => createElement(SettingsSection, { ctx }),
    ),
  )
}
