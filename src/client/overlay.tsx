/**
 * 划词菜单 + 悬浮窗（注册进 shell.overlay 的那一个 React 组件）。
 *
 * 交互：
 * - 页面里选中文字（拖选 / 双击 / 键盘扩选）→ 以选区右下角为锚点，在锚点
 *   第四象限（右下）弹出菜单，两项：「DeepSeek Harness 解释」「…翻译」。
 * - 同一份选区只弹一次：菜单以任何方式收起（Esc / 点别处 / 滚轮 / 点了菜单项）之后，
 *   页面里那份旧选区不会让菜单再弹出来——只有重新划词（选区变了）才会再弹。
 * - 点击菜单项 → 打开悬浮窗（默认屏幕右下角，可拖动、可八向缩放，可收起为
 *   悬浮球，可关闭），窗内流式渲染 Harness agent 的回答。
 * - 回答用官方 Markdown 原语渲染（与 DSH 对话里的排版一致）。
 */
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { detectLocale, startRun, stopRun } from './api'
import { ToolIcon } from './icons'
import { MAX_CONTEXT_LENGTH, MAX_SELECTION_LENGTH, type SelectionAction } from '../shared/protocol.js'

/** 客户端上下文里本插件用到的面。 */
export interface ClientContext {
  get?: (name: string) => any
}

/**
 * 官方 UI 原语（模块表回答；缺席时全部走内置兜底）。
 * 组件类型放宽成 unknown：官方组件可能是 memo/forwardRef 包装过的对象，
 * 不能假设 `typeof === 'function'`（实测 MarkdownText 就是这种情况）。
 */
interface PrimitivesModule {
  MarkdownText?: unknown
  IconSparkle16?: unknown
  IconGlobeOutline14?: unknown
  IconCopyOutline16?: unknown
  IconCloseOutline16?: unknown
  IconChevronDownOutline14?: unknown
  IconStopFill16?: unknown
  writeClipboard?: (text: string) => void | Promise<void>
}

/** 是否是 React 能渲染的组件（函数组件 / memo / forwardRef / class）。 */
function isComponent(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { $$typeof?: unknown; render?: unknown }
    return typeof candidate.$$typeof === 'symbol' || typeof candidate.render === 'function'
  }
  return false
}

/** 载入官方原语；模块表缺席时返回空对象而不是抛错。 */
function loadPrimitives(): PrimitivesModule {
  try {
    if (typeof require !== 'function') return {}
    return (require('@deepseek-ai/dsh-client-ui-primitives') ?? {}) as PrimitivesModule
  } catch {
    return {}
  }
}

const primitives = loadPrimitives()

/** Markdown 渲染的界面文案（官方原语用它给代码块加复制按钮）。 */
function markdownLabels(locale: 'zh' | 'en'): unknown {
  return locale === 'zh'
    ? { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
    : { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }
}

/** 界面文案。 */
const COPY = {
  zh: {
    explain: '解释',
    translate: '翻译',
    summarize: '总结',
    panelExplain: '解释',
    panelTranslate: '翻译',
    panelSummarize: '总结',
    expand: '展开原文',
    collapse: '收起原文',
    running: '生成中…',
    done: '完成',
    failed: '失败',
    copy: '复制',
    copied: '已复制',
    close: '关闭',
    stop: '停止',
    empty: '（没有文本输出）',
  },
  en: {
    explain: 'Explain',
    translate: 'Translate',
    summarize: 'Summarize',
    panelExplain: 'Explain',
    panelTranslate: 'Translate',
    panelSummarize: 'Summarize',
    expand: 'Show full source',
    collapse: 'Collapse source',
    running: 'Working…',
    done: 'Done',
    failed: 'Failed',
    copy: 'Copy',
    copied: 'Copied',
    close: 'Close',
    stop: 'Stop',
    empty: '(no text output)',
  },
} as const

interface MenuState {
  /** 锚点：选区右下角（视口坐标）。 */
  anchorX: number
  anchorY: number
  text: string
  /** 选区所在的块级文本（页内路径的"上下文"，与系统级 UIA 段落对齐；没有则空串）。 */
  context: string
}

interface PanelState {
  x: number
  y: number
  w: number
  h: number
  action: SelectionAction
  source: string
  status: 'running' | 'done' | 'error'
  text: string
  error: string
  sessionId?: string
}

interface Layout {
  panel: Omit<PanelState, 'action' | 'source' | 'status' | 'text' | 'error' | 'sessionId'>
}

const PANEL_W = 400
const PANEL_H = 480
const PANEL_MIN_W = 280
const PANEL_MIN_H = 180
const MARGIN = 20
const MENU_W = 192
const MENU_H = 168
const LAYOUT_KEY = 'dsh.selection-tools.layout'

const viewport = () => ({
  w: typeof window === 'undefined' ? 1280 : window.innerWidth,
  h: typeof window === 'undefined' ? 800 : window.innerHeight,
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** 默认几何：悬浮窗停在屏幕右下角（悬浮球已移除）。 */
function defaultLayout(): Layout {
  const { w, h } = viewport()
  return {
    panel: {
      x: Math.max(MARGIN, w - PANEL_W - MARGIN),
      y: Math.max(MARGIN, h - PANEL_H - MARGIN),
      w: PANEL_W,
      h: PANEL_H,
    },
  }
}

/** 把几何夹回视口内（窗口缩放后仍然可见）。 */
function clampLayout(layout: Layout): Layout {
  const { w, h } = viewport()
  const panelW = clamp(layout.panel.w, PANEL_MIN_W, Math.max(PANEL_MIN_W, w - MARGIN * 2))
  const panelH = clamp(layout.panel.h, PANEL_MIN_H, Math.max(PANEL_MIN_H, h - MARGIN * 2))
  return {
    panel: {
      w: panelW,
      h: panelH,
      x: clamp(layout.panel.x, 0, w - panelW),
      y: clamp(layout.panel.y, 0, h - panelH),
    },
  }
}

function loadLayout(): Layout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY)
    if (raw === null) return defaultLayout()
    const parsed = JSON.parse(raw) as Partial<Layout>
    const fallback = defaultLayout()
    return clampLayout({
      panel: { ...fallback.panel, ...(parsed.panel ?? {}) },
    })
  } catch {
    return defaultLayout()
  }
}

function saveLayout(layout: Layout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    /* 隐私模式等场景下持久化失败不影响使用 */
  }
}

/**
 * 选区签名：判断"这是不是已经弹过菜单的那一份选区"。
 *
 * 为什么需要它：菜单收起之后，页面的选区**还在**。用户随后在任何地方按下鼠标再松开
 * （mouseup 事件照样进来、选区也没变），旧实现会拿这份旧选区再弹一次菜单——表现就是
 * "选中一次之后，到哪里拖菜单都会冒出来"。所以菜单只认**新的**选区：同一份选区弹过一次
 * 就不再弹，直到选区变了（用户重新划词）。
 *
 * 签名取"起点/终点在 DOM 里的位置 + 文本"，因此同一处同样的文字算同一份选区。
 */
function selectionSignature(range: Range, text: string): string {
  const pathOf = (node: Node, offset: number): string => {
    const parts: number[] = []
    let current: Node | null = node
    while (current !== null && current.parentNode !== null) {
      parts.push(Array.prototype.indexOf.call(current.parentNode.childNodes, current))
      current = current.parentNode
    }
    return parts.reverse().join('.') + ':' + offset
  }
  const snippet = text.slice(0, 120)
  return pathOf(range.startContainer, range.startOffset) + '-' + pathOf(range.endContainer, range.endOffset) + '|' + text.length + '|' + snippet
}

/** 选区矩形：优先整段选区的包围盒（即「文字右下角」），退化时取最后一行的矩形。 */
function selectionRect(range: Range): { right: number; bottom: number } | null {
  const box = range.getBoundingClientRect()
  if (box.width > 0 || box.height > 0) return { right: box.right, bottom: box.bottom }
  const rects = range.getClientRects()
  const last = rects.length > 0 ? rects[rects.length - 1] : undefined
  return last === undefined ? null : { right: last.right, bottom: last.bottom }
}

/** 输入类元素：在这些地方划词不弹菜单（避免和编辑器/输入框打架）。 */
function isEditableTarget(node: Node | null): boolean {
  let element = node instanceof Element ? node : node?.parentElement ?? null
  while (element !== null) {
    const tag = element.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
    if ((element as HTMLElement).isContentEditable) return true
    element = element.parentElement
  }
  return false
}

/**
 * 页内划词的"上下文"：选区所在的块级元素文本。
 *
 * 与系统级取词（伴生进程用 UIA 读段落）对齐：解释/翻译时一起交给 agent，
 * 让回答落在语境里；块级元素抓不到或与选区等价时返回空串。
 */
function contextForRange(range: Range, selected: string): string {
  try {
    const node = range.commonAncestorContainer
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    if (element === null) return ''
    const block =
      element.closest('p, li, td, th, pre, blockquote, dd, dt, figcaption, article, section') ?? element
    const text = (block.textContent ?? '').replace(/\s+/gu, ' ').trim()
    const needle = selected.trim()
    if (text === '' || needle === '' || text === needle || !text.includes(needle)) return ''
    return text.slice(0, MAX_CONTEXT_LENGTH)
  } catch {
    return ''
  }
}

/** 内置图标兜底（官方原语缺席时使用）。 */
function fallbackIcon(path: string, size: number): ReactNode {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    createElement('path', { d: path }),
  )
}

const FALLBACK_PATHS = {
  sparkle: 'M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6z',
  globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2.6 8h10.8M8 2.2c1.6 1.6 2.4 3.6 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.2z',
  list: 'M6 4h8M6 8h8M6 12h5.5M3 4h.01M3 8h.01M3 12h.01',
  copy: 'M6 2.8h5.2a1 1 0 0 1 1 1V9M4.8 5.2h5.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
  close: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
  chevronDown: 'M4 6.4 8 10.2l4-3.8',
  stop: 'M5 5h6v6H5z',
} as const

function icon(name: keyof typeof FALLBACK_PATHS, size = 16): ReactNode {
  let official: unknown
  switch (name) {
    case 'sparkle':
      official = primitives.IconSparkle16
      break
    case 'globe':
      official = primitives.IconGlobeOutline14
      break
    case 'list':
      // 官方原语里没有清单图标，固定用自带的线性图标。
      break
    case 'copy':
      official = primitives.IconCopyOutline16
      break
    case 'close':
      official = primitives.IconCloseOutline16
      break
    case 'chevronDown':
      official = primitives.IconChevronDownOutline14
      break
    case 'stop':
      official = primitives.IconStopFill16
      break
  }
  if (isComponent(official)) return createElement(official as never, { size })
  return fallbackIcon(FALLBACK_PATHS[name], size)
}

/** 复制文本：优先官方剪贴板工具，其次 navigator.clipboard。 */
async function copyText(text: string): Promise<void> {
  if (typeof primitives.writeClipboard === 'function') {
    await primitives.writeClipboard(text)
    return
  }
  await navigator.clipboard.writeText(text)
}

/** 渲染 Markdown 回答：官方 MarkdownText 缺席时退化为纯文本。 */
function renderMarkdown(text: string, streaming: boolean, locale: 'zh' | 'en'): ReactNode {
  if (isComponent(primitives.MarkdownText)) {
    return createElement(primitives.MarkdownText as never, { text, streaming, labels: markdownLabels(locale) })
  }
  return createElement('pre', { className: 'dst-plain' }, text)
}

interface DragState {
  kind: 'move' | 'resize'
  edge: string
  pointerX: number
  pointerY: number
  x: number
  y: number
  w: number
  h: number
}

/** 文案字段名（两种语言共用）；值放宽成 string，避免字面量类型把两套文案排他。 */
type Copy = Record<keyof (typeof COPY)['zh'], string>

/** 面板标题：按动作取文案。 */
function actionTitle(action: SelectionAction, copy: Copy): string {
  if (action === 'translate') return copy.panelTranslate
  if (action === 'summarize') return copy.panelSummarize
  return copy.panelExplain
}

/** 面板标题旁的小图标：与菜单项保持一致。 */
function actionIcon(action: SelectionAction): 'sparkle' | 'globe' | 'list' {
  if (action === 'translate') return 'globe'
  if (action === 'summarize') return 'list'
  return 'sparkle'
}

/**
 * 划词菜单 + 悬浮窗。整个插件只有这一个 React 组件，注册进 shell.overlay。
 * @param props.ctx - 客户端 Cordis 上下文。
 */
export function Overlay(props: { ctx: ClientContext }): ReactNode {
  const { ctx } = props
  const locale = useMemo(() => detectLocale(), [])
  const copy = COPY[locale]
  /** 系统级划词是否正在接管（接管时页内菜单让位，避免同一处弹两个菜单）。 */
  const systemWide = useRef(false)
  useEffect(() => {
    let cancelled = false
    const probe = () => {
      void fetch('/api/dsh-selection-tools/system/status')
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { companion?: { state?: string } } | null) => {
          if (!cancelled) systemWide.current = payload?.companion?.state === 'running'
        })
        .catch(() => {
          if (!cancelled) systemWide.current = false
        })
    }
    probe()
    const timer = window.setInterval(probe, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [binding, setBinding] = useState<Layout>(() =>
    typeof window === 'undefined' ? defaultLayout() : loadLayout(),
  )
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

  /** 已经为它弹过菜单的那份选区（签名）；菜单收起后不再为它重复弹。 */
  const servedSelection = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const runRef = useRef<{ abort: () => void; sessionId: () => string | undefined } | null>(null)
  const layoutRef = useRef<Layout>(binding)

  layoutRef.current = { panel: layoutRef.current.panel }

  /** 打开悬浮窗并立刻发起一轮。 */
  const openPanel = useCallback(
    (action: SelectionAction, text: string, context = '') => {
      setMenu(null)
      setCopied(false)
      setExpanded(false)
      runRef.current?.abort()
      const geometry = clampLayout(layoutRef.current)
      layoutRef.current = geometry
      setPanel({
        x: geometry.panel.x,
        y: geometry.panel.y,
        w: geometry.panel.w,
        h: geometry.panel.h,
        action,
        source: text,
        status: 'running',
        text: '',
        error: '',
      })
      runRef.current = startRun(action, text, ctx, context, {
        onSession: (sessionId) => setPanel((current) => (current === null ? current : { ...current, sessionId })),
        onDelta: (chunk) =>
          setPanel((current) => (current === null ? current : { ...current, text: current.text + chunk })),
        onDone: (final, sessionId) =>
          setPanel((current) =>
            current === null
              ? current
              : { ...current, status: 'done', sessionId, text: final === '' ? current.text : final },
          ),
        onError: (message) =>
          setPanel((current) => (current === null ? current : { ...current, status: 'error', error: message })),
      })
    },
    [ctx],
  )

  // ---- 划词检测：选中即弹菜单 ----
  useEffect(() => {
    const insideOwnUi = (node: Node | null): boolean =>
      node !== null && rootRef.current !== null && rootRef.current.contains(node)

    const dismiss = (event: Event) => {
      if (insideOwnUi(event.target as Node | null)) return
      setMenu(null)
    }

    const inspectSelection = (event: Event) => {
      const target = event.target as Node | null
      if (insideOwnUi(target) || isEditableTarget(target)) return
      // 系统级划词（全局取词 + 操作系统浮层）接管时，页内菜单不再重复弹出。
      if (systemWide.current) return
      window.setTimeout(() => {
        const selection = window.getSelection()
        if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
          setMenu(null)
          return
        }
        const text = selection.toString().trim()
        if (text === '') {
          setMenu(null)
          return
        }
        const range = selection.getRangeAt(0)
        if (insideOwnUi(range.commonAncestorContainer)) {
          setMenu(null)
          return
        }
        const rect = selectionRect(range)
        if (rect === null) {
          setMenu(null)
          return
        }
        const signature = selectionSignature(range, text)
        if (signature === servedSelection.current) {
          // 这一份选区已经为它弹过一次了（菜单收起后旧选区还留在页面上）：不再重复弹。
          setMenu(null)
          return
        }
        servedSelection.current = signature
        setMenu({
          anchorX: rect.right,
          anchorY: rect.bottom,
          text: text.slice(0, MAX_SELECTION_LENGTH),
          context: contextForRange(range, text),
        })
      }, 0)
    }

    /**
     * 选区一变（选了新的一段、或者被点掉）就作废"弹过"的记号，用户重新划词时还能弹。
     * 选区没变时什么都不做——正是靠这条，旧选区不会再触发第二次菜单。
     */
    const onSelectionChange = () => {
      if (servedSelection.current === null) return
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
        servedSelection.current = null
        return
      }
      const range = selection.getRangeAt(0)
      if (selectionSignature(range, selection.toString().trim()) !== servedSelection.current) {
        servedSelection.current = null
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    const onViewportChange = () => setMenu(null)

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('mouseup', inspectSelection, true)
    document.addEventListener('dblclick', inspectSelection, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('mouseup', inspectSelection, true)
      document.removeEventListener('dblclick', inspectSelection, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [])

  // ---- 几何持久化 ----
  const persistPanel = useCallback((next: PanelState) => {
    layoutRef.current = {
      panel: { x: next.x, y: next.y, w: next.w, h: next.h },
    }
    saveLayout(layoutRef.current)
  }, [])

  // ---- 拖动 / 缩放 ----
  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (panel === null || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      kind: 'move',
      edge: '',
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: panel.x,
      y: panel.y,
      w: panel.w,
      h: panel.h,
    }
  }

  const beginResize = (edge: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (panel === null || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      kind: 'resize',
      edge,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: panel.x,
      y: panel.y,
      w: panel.w,
      h: panel.h,
    }
  }

  const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    const dx = event.clientX - drag.pointerX
    const dy = event.clientY - drag.pointerY
    const box = viewport()
    if (drag.kind === 'move') {
      const x = clamp(drag.x + dx, 0, box.w - drag.w)
      const y = clamp(drag.y + dy, 0, box.h - drag.h)
      setPanel((current) => (current === null ? current : { ...current, x, y }))
      return
    }
    let { x, y, w, h } = drag
    if (drag.edge.includes('e')) w = clamp(drag.w + dx, PANEL_MIN_W, box.w - drag.x)
    if (drag.edge.includes('s')) h = clamp(drag.h + dy, PANEL_MIN_H, box.h - drag.y)
    if (drag.edge.includes('w')) {
      const nextW = clamp(drag.w - dx, PANEL_MIN_W, drag.x + drag.w)
      x = drag.x + (drag.w - nextW)
      w = nextW
    }
    if (drag.edge.includes('n')) {
      const nextH = clamp(drag.h - dy, PANEL_MIN_H, drag.y + drag.h)
      y = drag.y + (drag.h - nextH)
      h = nextH
    }
    setPanel((current) => (current === null ? current : { ...current, x, y, w, h }))
  }

  const onDragEnd = () => {
    if (dragRef.current === null) return
    dragRef.current = null
    setPanel((current) => {
      if (current !== null) persistPanel(current)
      return current
    })
  }

  // ---- 窗口尺寸变化：几何夹回视口 ----
  useEffect(() => {
    const onResize = () => {
      const next = clampLayout(layoutRef.current)
      layoutRef.current = next
      setBinding((current) => ({ ...current, panel: next.panel }))
      setPanel((current) =>
        current === null ? current : { ...current, x: next.panel.x, y: next.panel.y, w: next.panel.w, h: next.panel.h },
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const closePanel = () => {
    runRef.current?.abort()
    runRef.current = null
    setPanel(null)
  }

  const onCopy = () => {
    if (panel === null) return
    void copyText(panel.text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => undefined,
    )
  }

  const onStop = () => {
    void stopRun(panel?.sessionId)
    runRef.current?.abort()
    runRef.current = null
    setPanel((current) => (current === null ? current : { ...current, status: 'done' }))
  }

  // ---- 菜单 ----
  let menuNode: ReactNode = null
  if (menu !== null) {
    const box = viewport()
    // 锚点第四象限：文字右下角外侧 +8px；贴边时回翻，保证菜单整体可见。
    const x = clamp(menu.anchorX + 8, 8, box.w - MENU_W - 8)
    const y = clamp(menu.anchorY + 8, 8, box.h - MENU_H - 8)
    const item = (action: SelectionAction, label: string, iconName: 'sparkle' | 'globe' | 'list') =>
      createElement(
        'button',
        {
          type: 'button',
          className: 'dst-menu-item',
          role: 'menuitem',
          onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
          onClick: () => openPanel(action, menu.text, menu.context),
        },
        createElement('span', { className: 'dst-menu-item-icon' }, icon(iconName, 16)),
        createElement('span', { className: 'dst-menu-item-label' }, label),
        createElement('span', { className: 'dst-menu-arrow' }, createElement(ToolIcon, { name: 'arrow', size: 14 })),
      )
    menuNode = createElement(
      'div',
      { className: 'dst-menu', style: { left: x, top: y, width: MENU_W }, role: 'menu', 'aria-label': 'Selection tools' },
      createElement('div', { className: 'dst-menu-caption', role: 'presentation' }, 'DeepSeek Harness', createElement('span', { 'aria-hidden': true }, 'Esc')),
      item('explain', copy.explain, 'sparkle'),
      item('summarize', copy.summarize, 'list'),
      item('translate', copy.translate, 'globe'),
    )
  }

  // ---- 悬浮窗（只有这一种形态：悬浮球与最小化都已移除） ----
  const statusText =
    panel === null
      ? ''
      : panel.status === 'running'
        ? copy.running
        : panel.status === 'error'
          ? copy.failed
          : copy.done

  const headerButton = (options: {
    label: string
    iconName: Parameters<typeof icon>[0]
    disabled?: boolean
    onClick: () => void
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        className: 'dst-icon-btn',
        title: options.label,
        'aria-label': options.label,
        disabled: options.disabled === true,
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
        onClick: options.onClick,
      },
      icon(options.iconName, 16),
    )

  const panelNode: ReactNode =
    panel === null
      ? null
      : createElement(
          'section',
          {
            className: 'dst-panel',
            style: { left: panel.x, top: panel.y, width: panel.w, height: panel.h } as CSSProperties,
            role: 'dialog',
            'aria-label': actionTitle(panel.action, copy),
          },
          createElement(
            'header',
            {
              className: 'dst-panel-header',
              onPointerDown: beginMove,
              onPointerMove: onDragMove,
              onPointerUp: onDragEnd,
              onPointerCancel: onDragEnd,
            },
            createElement(
              'span',
              { className: 'dst-menu-item-icon' },
              icon(actionIcon(panel.action), 16),
            ),
            createElement(
              'span',
              { className: 'dst-panel-title' },
              actionTitle(panel.action, copy),
              createElement('span', { className: 'dst-panel-brand' }, 'Harness'),
            ),
            createElement(
              'span',
              { className: 'dst-panel-actions' },
              headerButton({
                label: copied ? copy.copied : copy.copy,
                iconName: 'copy',
                disabled: panel.text === '',
                onClick: onCopy,
              }),
              headerButton({ label: copy.close, iconName: 'close', onClick: closePanel }),
            ),
          ),
          createElement(
            'div',
            { className: 'dst-panel-body' },
            createElement(
              'div',
              { className: 'dst-source', 'data-expanded': expanded ? 'true' : 'false' },
              createElement('span', { className: 'dst-source-label' }, locale === 'zh' ? '原文' : 'SOURCE'),
              createElement('div', { className: 'dst-source-text' }, panel.source),
              (panel.source.length > 80 || panel.source.split('\n').length > 3)
                ? createElement(
                    'button',
                    { type: 'button', className: 'dst-source-toggle', onClick: () => setExpanded((value) => !value) },
                    expanded ? copy.collapse : copy.expand,
                  )
                : null,
            ),
            createElement(
              'div',
              { className: 'dst-answer' },
              panel.text === ''
                ? panel.status === 'running'
                  ? createElement('span', { className: 'dst-caret' })
                  : createElement('span', { className: 'dst-empty' }, copy.empty)
                : renderMarkdown(panel.text, panel.status === 'running', locale),
            ),
          ),
          createElement(
            'footer',
            { className: 'dst-panel-foot', role: 'status', 'aria-live': 'polite' },
            createElement('span', { className: 'dst-dot', 'data-state': panel.status }),
            createElement('span', { className: panel.status === 'error' ? 'dst-error' : '' }, statusText),
            panel.status === 'error' && panel.error !== ''
              ? createElement('span', { className: 'dst-error' }, panel.error)
              : null,
            createElement('span', { className: 'dst-foot-spacer' }),
            panel.status === 'running'
              ? createElement('button', { type: 'button', className: 'dst-link', onClick: onStop }, copy.stop)
              : null,
          ),
          ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) =>
            createElement('div', {
              key: edge,
              className: 'dst-resize dst-resize-' + edge,
              onPointerDown: beginResize(edge),
              onPointerMove: onDragMove,
              onPointerUp: onDragEnd,
              onPointerCancel: onDragEnd,
            }),
          ),
        )

  return createElement('div', { ref: rootRef, className: 'dst-root' }, menuNode, panelNode)
}
