/**
 * dsh-selection-tools 系统级伴生进程（Node + koffi + GDI+）。
 *
 * 1. **全局划词**：轮询鼠标左右中键与光标位置识别"拖选/双击选词"，手势落下就弹菜单——
 *    **划词时一次都不碰剪贴板**；选中的文字留到用户点菜单项时才解析（UI Automation 优先，
 *    读不到才注入一次 Ctrl+C 读剪贴板兜底）。
 * 2. **两个原生浮层窗口**（都在本进程内，GDI+ 自绘，不依赖浏览器、不额外起进程）：
 *    - 划词菜单：出现在选区右下角，**有显示时限**（默认 3.6s）、任意键点到别处即消失；
 *    - 回答窗口（面板）：**只有手动关闭才会消失**，新划词不会动它；没有悬浮球、没有最小化。
 * 3. **读选区与上下文**：手势落下就用 UI Automation 一次读完"选中的文字 + 它所在的段落"
 *    （worker 线程 + 超时，全程不碰剪贴板）；点菜单项时连同上下文一起交给 agent——像知乎
 *    划词解释那样带语境，读不到就安静降级成"只有选区"、再读不到才退到剪贴板兜底。
 * 4. **跑 agent**：直接调用 DSH 插件的 /run 路由（SSE），把流式文本画到回答窗口上。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContextReader } from './context.mjs'
import { createGestureDetector, createLatestQueue } from './gesture.mjs'
import { menuDecision, pickSelection, unknownFallback } from './policy.mjs'
import { captureSelection, clampSelection } from './selection.mjs'
import { createGdi } from './native/gdi.mjs'
import { captureScreenRect } from './native/capture.mjs'
import { createNativeWindow, hitTestCode } from './native/window.mjs'
import { createSpeaker } from './native/speech.mjs'
import { MODES, menuRowAt, paintMenu, paintPanel, panelHit, panelHitZone } from './native/ui.mjs'
import { createWin32, monitorScaleForPoint, primaryWorkArea, workAreaForPoint } from './win32.mjs'

const DSH_ORIGIN = process.env.DSH_SELECTION_DSH_ORIGIN ?? 'http://127.0.0.1:3080'
const KOFFI_HINT = process.env.DSH_SELECTION_KOFFI_HINT ?? ''
const POLL_MS = Number(process.env.DSH_SELECTION_POLL_MS ?? 40)
const HOOK_ENABLED = process.env.DSH_SELECTION_HOOK !== '0'
const MAX_TEXT = Number(process.env.DSH_SELECTION_MAX_TEXT ?? 12000)
const LOCALE = process.env.DSH_SELECTION_LOCALE === 'en' ? 'en' : 'zh'
/** 划词菜单的显示时限（毫秒）。 */
const MENU_TIMEOUT_MS = Number(process.env.DSH_SELECTION_MENU_TIMEOUT_MS ?? 3600)
/** 单次上下文读取的时间预算（毫秒）：超时就丢掉 worker，按"没有上下文"处理。 */
const CONTEXT_TIMEOUT_MS = Number(process.env.DSH_SELECTION_CONTEXT_TIMEOUT_MS ?? 1800)
/**
 * UI Automation 开关（`DSH_SELECTION_CONTEXT=0` 可关掉）。
 *
 * 注意它现在管两件事：读"选区所在的段落"与**读选区本身**。关掉之后菜单不再过滤手势
 * （一律弹），选区文字只能走剪贴板兜底——等于退回老行为，只在 UIA 明显捣乱时才用。
 */
const CONTEXT_ENABLED = process.env.DSH_SELECTION_CONTEXT !== '0'
/**
 * 取词时是否校验"这次剪贴板写入来自前台窗口"（`DSH_SELECTION_CLIPBOARD_OWNER=0` 可关掉）。
 * 关掉就退回老行为：只要剪贴板序号变了就当作取词成功——遇到取不到词的个别应用才需要关。
 */
const OWNER_CHECK = process.env.DSH_SELECTION_CLIPBOARD_OWNER !== '0'

/** 环境变量读成非负数（读不出/非法就用默认值）。 */
function envNumber(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * 手势落下后给 UIA 的决策窗口（毫秒）。
 *
 * 菜单不再等取词：老实现要先注入 Ctrl+C 读剪贴板，读到了才弹菜单——读不到就等于
 * **菜单呼不出来**（DSH 桌面端的 WebView2 窗口里注入的 Ctrl+C 拿不到剪贴板，个别
 * 外部应用也偶发同样的问题）。现在手势一落地就开始 UIA 预读，最多等这么久拿一个
 * "这一点上有没有选中文字"的结论：读到了按它办，超时/读不到就照弹（点菜单项时还有
 * 剪贴板兜底）。设成 0 = 手势一到就弹，不做任何过滤。
 */
const MENU_DECIDE_MS = envNumber(process.env.DSH_SELECTION_MENU_DECIDE_MS, 280)
/**
 * 菜单弹出时 UIA 预读的重试次数。
 *
 * Chromium（含 DSH 桌面端自己的 WebView2 窗口）是**被 UIA 问到才打开无障碍树**的：冷
 * 启动那一下连 TextPattern 都没有（实测：本轮第一次划词 3 次尝试全空，之后再问就正常）。
 * 预读在决策窗口超时之后仍会继续跑，所以这些重试主要是在替**点菜单项时**把树焐热。
 */
const MENU_PROBE_RETRIES = envNumber(process.env.DSH_SELECTION_MENU_PROBE_RETRIES, 3)
/**
 * 鼠标**按下**时要不要拍一张"手势之前的选区"快照（`0` 关掉）。
 *
 * 它是"这次手势到底有没有选出新东西"的唯一判据：办公套件里拖动一个**已经选中**的元素
 * （WPS/Office 的 PPT 形状、Excel 单元格）时，UIA 从头到尾都报着"这个对象被选中"——
 * 只有比较"按下时"和"松开时"读到的选区，才能把"移动元素"和"选文字"分开（见
 * policy.mjs 的 menuDecision）。代价是每次按下多一次 UIA 读取（在 worker 线程里，不挡
 * 主进程）；真遇到某个应用在按下时被 UIA 问得很贵，可以把它关掉。
 */
const PRESS_PROBE = process.env.DSH_SELECTION_PRESS_PROBE !== '0'
/**
 * 等"按下快照"的上限（毫秒）。
 *
 * 快照在按下那一刻就发出去了，正常早就回来了（这一步不花时间）；只有"按下到松开特别快"
 * 的拖拽才会真等——给它一小段时间，免得这种手势直接掉进"没拍到"那一档。再久就不值了：
 * 划词菜单是手感的一部分，不能为了一条兜底判据把它拖慢。
 */
const PRESS_WAIT_MS = envNumber(process.env.DSH_SELECTION_PRESS_WAIT_MS, 120)
/**
 * UIA 说不出话时，要不要用**剪贴板**核实一次"这次手势到底选没选中文字"（`0` 关掉）。
 *
 * 办公套件（WPS 的 Qt 版最典型）整个窗口树里都没有文档的 TextPattern——UIA 对"有没有选中
 * 文字"完全无话可说。核实办法是注入一次 Ctrl+C：真选中文字就会复制出文字；拖动一个形状/
 * 窗口则什么文字都复制不出来。代价是会短暂接管剪贴板（selection.mjs 那几条安全规则照旧：
 * 终端跳过、用户正在 Ctrl+C 就不注入、只认前台窗口自己写的那次、用完把原内容放回去）。
 *
 * 关掉之后退回老行为：拖选照弹、双击不弹（见 policy.mjs 的 unknownFallback）。
 */
const CONFIRM_BY_CLIPBOARD = process.env.DSH_SELECTION_CONFIRM !== '0'
/**
 * 点菜单项时补读 UIA 的重试次数。
 * 那时无障碍树通常已经热了，给 1 次机会挡的是"刚巧还在冷启动"；再多就只是拖延
 * 剪贴板兜底（那才是真的读不到时的出路）。
 */
const CLICK_PROBE_RETRIES = envNumber(process.env.DSH_SELECTION_CLICK_PROBE_RETRIES, 1)
/**
 * 选区文字从哪来：
 * - `auto`（默认）：UIA 优先，读不到才注入一次 Ctrl+C 读剪贴板；
 * - `uia`：只用 UIA，读不到就报错（绝不碰剪贴板）；
 * - `clipboard`：直接用剪贴板（老行为；某个应用 UIA 读得不准时的逃生舱）。
 */
const TEXT_SOURCE = ['auto', 'uia', 'clipboard'].includes(process.env.DSH_SELECTION_TEXT_SOURCE)
  ? process.env.DSH_SELECTION_TEXT_SOURCE
  : 'auto'
const GAP = 8
const VK_LBUTTON = 0x01
const VK_RBUTTON = 0x02
const VK_MBUTTON = 0x04
const VK_ESCAPE = 0x1b

const api = createWin32([KOFFI_HINT])
const gdi = api === null ? null : createGdi(api.koffi)

/** 回答窗口的业务状态（也是绘制输入）。 */
const ui = {
  mode: 'panel',
  dark: true,
  hover: -1,
  hoverButton: null,
  action: 'explain',
  source: '',
  context: '',
  answer: '',
  status: 'idle',
  error: '',
  copyFeedback: '',
  speaking: false,
  scroll: 0,
  contentHeight: 0,
  viewHeight: 0,
  stopBox: null,
}

/**
 * 划词菜单状态。
 *
 * `selection` 是**这个菜单是为哪次选区弹的**：点菜单项时一律用它，不用当时的
 * `state.selection`——用户点下去的那一刻可能刚好又有一次划词完成了，用后者会让
 * "回答窗口里的输入内容"跟"用户看着菜单点的那段文字"对不上。
 */
const menu = { visible: false, rect: null, scale: 1, anchor: null, hover: -1, timer: null, dark: true, selection: null }
/** 回答窗口状态（`size` 是用户手动改过的大小，物理像素）。 */
const panel = { mode: 'hidden', rect: null, scale: 1, position: null, size: null }

const state = {
  selection: null,
  lastGesture: null,
  lastCapture: null,
  lastMenuDismiss: null,
  /** 最近一次菜单收起时，菜单绑的是哪段文字（用来识别"手势没碰到、文字也没变"的旧选区）。 */
  lastMenuSelection: '',
  /** 最近几次"弹不弹"的结论（偶发"划不出来"时看这个：/status 的 recentDecisions）。 */
  recentDecisions: [],
  /** 最近一次 UIA 探针（读到了什么）。 */
  lastProbe: null,
  /** 最近一次"按下那一刻"的选区快照摘要（判断"这次手势有没有选出新东西"要用它）。 */
  lastPressProbe: null,
  /** 最近一次"用剪贴板核实有没有选中文字"的报告（UIA 判不了时才走这一步）。 */
  lastConfirm: null,
  /** 最近一次"弹不弹菜单"的结论与理由（呼不出来时看这里）。 */
  lastMenuDecision: null,
  /** 最近一次"点菜单项之后用了哪个来源的文字"。 */
  lastResolve: null,
  run: null,
  startedAt: Date.now(),
  errors: [],
}

/** 手势串行队列（startHook 里建；/status 汇报它的状态）。 */
let gestureQueue = null

/**
 * **按下那一刻**读到的选区（"这次手势之前，按住的地方本来就选着什么"）。
 *
 * 为什么必须在这一刻拍：拖完再读到的已经是被这次手势改过的选区了，两者一比才知道这次
 * 手势到底有没有选出新东西——办公套件里拖动一个已选中的元素（PPT 形状、Excel 单元格）时，
 * 松开那一刻探针照样读到"这个对象被选中"，跟真的拖选文字一模一样（见 policy.mjs 的
 * menuDecision 第一条判据）。双击第二下不重拍：双击要的是**这一串点击开始之前**的选区。
 *
 * `{ at, x, y, pending, result }`；`result` 是探针结果（`undefined` = 还没回来，
 * `null` = 读不到），/status 的 `pressProbe` 会把它摘出来给人看。
 */
let pressSnapshot = null

/**
 * 有没有一次手势正在等探针结论（`handleGesture` 的决策窗口）。
 *
 * 读取器同一时刻只保留最新的一次请求：决策在途时再拍按下快照，会把**这次决策的探针**
 * 顶掉（结果变成"读不到"→ 拖选照弹），菜单就可能在"随手一拖"时冒出来。所以决策期间不
 * 拍快照——那一档本来就按"没拍到"处理（少一条判据，回到改动前的行为），代价可忽略。
 */
let deciding = false

/**
 * 拍一张"按下那一刻"的选区快照（`DSH_SELECTION_PRESS_PROBE=0` 可关掉）。
 *
 * 一次读取，不重试：它只是给决策多一条判据，拍晚了/读不到都不影响原来的判定（那时按
 * null 传下去，等于回到改动前的行为）。
 *
 * @param press - 手势按下事件（`{ x, y, time, second }`，见 gesture.mjs）。
 */
/**
 * 用户还没手动拖过回答窗时，首次弹窗默认放在选区旁边。
 *
 * 优先右下方；空间不够就换上方、左侧或右上方，尽量不遮挡选中文字。
 *
 * @param {object} opts
 * @param {object} opts.workArea - 当前显示器工作区矩形。
 * @param {object|null} opts.selection - 选区锚点 `{x,y}`（松开时的坐标，物理像素）。
 * @param {number} opts.width - 回答窗宽度。
 * @param {number} opts.height - 回答窗高度。
 * @param {number} opts.gap - 与选区留多少像素空隙。
 * @returns {object} 默认位置 `{x,y}`。
 */
function placePanelBySelection({ workArea, selection, width, height, gap }) {
  if (selection === null || selection === undefined) {
    return { x: workArea.right - width - 20, y: workArea.bottom - height - 20 }
  }
  const sx = selection.x
  const sy = selection.y
  // 候选位置：右下、右上、左下、左上
  const candidates = [
    { x: sx + gap, y: sy + gap },         // 右下
    { x: sx + gap, y: sy - height - gap }, // 右上
    { x: sx - width - gap, y: sy + gap },  // 左下
    { x: sx - width - gap, y: sy - height - gap }, // 左上
  ]
  // 找能完整放进工作区、且最靠左上角的候选（视觉上自然跟随阅读流）
  const fits = candidates.filter((p) =>
    p.x >= workArea.left &&
    p.x + width <= workArea.right &&
    p.y >= workArea.top &&
    p.y + height <= workArea.bottom
  )
  if (fits.length > 0) return fits[0]
  // 全放不下：贴到右下角的兜底位置
  return { x: workArea.right - width - 20, y: workArea.bottom - height - 20 }
}

function startPressProbe(press) {
  if (contextReader === null || !PRESS_PROBE) {
    pressSnapshot = null
    return
  }
  // 双击的第二下**永远不重拍**：要的是"这一串点击开始之前"的选区——第二下按下时选中的
  // 词已经出来了，拿它当"拖之前"会把双击选词整个判成"没改动选区"（于是双击再也弹不出来）。
  if (press.second === true) return
  // 决策在途时不拍：这一拍会把这次决策的探针顶掉（见 deciding 的说明）。这一下也就没有
  // 快照了——顺手清掉旧的，免得拿上一次的形状/文字去判这一次手势。
  if (deciding) {
    pressSnapshot = null
    return
  }
  const snapshot = {
    at: Date.now(),
    x: press.x,
    y: press.y,
    /** 探针结果：`undefined` = 还没回来。 */
    result: undefined,
    pending: null,
    /**
     * 读数**到手那一刻**指针离按下点有多远（像素；`null` = 量不到）。
     *
     * 为什么要在这一刻量：按下快照是异步读的，探针发出去不等于读到的是那一刻的状态。
     * 浏览器里 UIA 首查常要 100ms 以上，一次 80px 的拖选只要 150ms——读数回来时用户早拖完
     * 了，于是"按下那一刻"读到的是**这次手势自己选出来的文字**，跟松开时一模一样，被判成
     * unchanged-selection，菜单再也不出来（见 policy.mjs 的 PRESS_SETTLE_SLOP）。
     * 指针还没动 → 读数再慢也代表按下时的状态；指针已经跑出去 → 这张快照作废。
     */
    driftPx: null,
  }
  snapshot.pending = contextReader.probe({ x: press.x, y: press.y }, { retries: 0 })
  pressSnapshot = snapshot
  void snapshot.pending
    .then((result) => {
      snapshot.driftPx = driftFrom(snapshot)
      snapshot.result = result ?? null
      state.lastPressProbe = summarizePress(snapshot)
    })
    .catch((error) => {
      snapshot.driftPx = driftFrom(snapshot)
      snapshot.result = null
      state.lastPressProbe = summarizePress(snapshot)
      reportError('press-probe', error)
    })
}

/** 指针现在离按下点有多远（像素）；量不到返回 null（当作"没量到"，仍按可信处理）。 */
function driftFrom(snapshot) {
  if (api === null || typeof api.GetCursorPos !== 'function') return null
  const point = {}
  try {
    if (!api.GetCursorPos(point)) return null
  } catch {
    return null
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  return Math.round(Math.hypot(point.x - snapshot.x, point.y - snapshot.y))
}

/** 按下快照的摘要（/status 与 recentDecisions 用；只截一小段选区文字）。 */
function summarizePress(snapshot) {
  if (snapshot === null || snapshot === undefined) return null
  const result = snapshot.result
  const selection = typeof result?.selection === 'string' ? result.selection : ''
  return {
    at: snapshot.at,
    state: result === undefined ? 'reading' : result === null ? 'none' : 'ready',
    source: typeof result?.source === 'string' ? result.source : '',
    selectionLength: selection.length,
    /** 读数到手那一刻指针离按下点多远（像素）：太远说明这张快照拍晚了（见 driftFrom）。 */
    driftPx: Number.isFinite(snapshot.driftPx) ? snapshot.driftPx : null,
    /** 选区矩形数组（只传前 6 个，够判断"动没动"就行；null = 没读到）。 */
    rects: Array.isArray(result?.rects) ? result.rects.slice(0, 6) : null,
    /** 缩略（跟 lastMenuSelection 一样只留一小段，够看出"拖的是什么"就行）。 */
    selection: selection.slice(0, 120),
  }
}

/** 上下文读取器（worker 线程；钩子关掉或显式禁用时不建）。 */
const contextReader = api !== null && gdi !== null && CONTEXT_ENABLED
  ? createContextReader({ koffiHint: KOFFI_HINT, timeoutMs: CONTEXT_TIMEOUT_MS })
  : null

function reportError(scope, error) {
  const message = error instanceof Error ? error.message : String(error)
  state.errors.push({ scope, message, time: Date.now() })
  if (state.errors.length > 20) state.errors.shift()
}

let themeCache = { value: true, at: 0 }
function systemDark() {
  if (Date.now() - themeCache.at < 60_000) return themeCache.value
  let dark = true
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8', windowsHide: true })
    const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout ?? '')
    if (match !== null) dark = Number.parseInt(match[1], 16) === 0
  } catch {
    /* 读不到就按深色 */
  }
  themeCache = { value: dark, at: Date.now() }
  return dark
}

// ---------------------------------------------------------------- 回答窗口（面板 / 悬浮球）

const mainWindow = api !== null && gdi !== null && gdi.startup()
  ? createNativeWindow({
      api,
      gdi,
      className: 'DshSelMainWnd',
      title: 'DSH 划词助手',
      // 缩放下限（DIP）：再小布局就没法看了
      minSize: { width: 260, height: 200 },
      initialState: ui,
      onPaint(painter, width, height, data, scale) {
        paintPanel(painter, width, height, data, scale)
      },
      onHitTest(x, y, data) {
        return hitZone(x, y, data)
      },
      onHover(x, y, data) {
        const scale = mainWindow.scale()
        if (x < 0) {
          const changed = data.hover !== -1 || data.hoverButton !== null
          data.hover = -1
          data.hoverButton = null
          return changed
        }
        const button = y / scale < 44 ? panelHit(x / scale, y / scale, data, currentPanelSize().width) : null
        const next = button === 'body' ? null : button
        if (next !== data.hoverButton) {
          data.hoverButton = next
          return true
        }
        return false
      },
      onMouseDown() {
        // 拖动交给标题栏（HTCAPTION），客户区一律按点击处理
        return 'click'
      },
      onDragEnd(x, y) {
        panel.position = { x, y }
      },
      onResized(width, height) {
        // 创建期（窗口是 10×10 的占位尺寸）与隐藏期都会收到 WM_SIZE，不能当作用户改过大小
        // ——踩过：把创建期的 10×10 记成"用户尺寸"，回答窗口直接以 10×10 打开。
        if (panel.mode === 'hidden') return
        const scale = mainWindow.scale()
        if (width < 200 * scale || height < 150 * scale) return
        // 用户手动改过大小：记住它（下次打开仍用这个尺寸），并同步对外汇报的矩形
        // —— 否则命中判断与 /capture 会按旧尺寸错位。
        panel.size = { width, height }
        if (panel.rect !== null) panel.rect = { ...panel.rect, width, height }
      },
      onMoved(x, y) {
        // 原生拖动（标题栏）之后同步位置，避免下一次重绘把窗口拉回去。
        // 窗口隐藏时不记：创建期与隐藏期都会收到 WM_MOVE（例如 -32000 的初始位置）。
        if (panel.mode === 'hidden') return
        panel.position = { x, y }
        // 同时修正对外汇报的矩形：否则 /capture 之类会按旧坐标抓错区域
        if (panel.rect !== null) panel.rect = { ...panel.rect, x, y }
      },
      onClick(x, y, data) {
        try {
          return clickMain(x / mainWindow.scale(), y / mainWindow.scale(), data)
        } catch (error) {
          reportError('click', error)
          return false
        }
      },
      onRightClick() {
        // 只有标题栏的关闭按钮会关掉窗口（悬浮球已移除，右键不再有特殊含义）
        return false
      },
      onWheel(delta, data) {
        if (data.mode !== 'panel') return false
        const maxScroll = Math.max(0, data.contentHeight - data.viewHeight)
        const next = Math.min(maxScroll, Math.max(0, data.scroll - Math.sign(delta) * 60))
        if (next === data.scroll) return false
        data.scroll = next
        return true
      },
      onDpiChanged() {
        if (panel.mode !== 'hidden') applyMainMode(panel.mode)
      },
      onError(error) {
        reportError('main-window', error)
      },
    })
  : null

/**
 * 回答窗口的实际尺寸（DIP）+ 缩放。
 *
 * 尺寸一律取**窗口当前的实际尺寸**：用户可以把窗口拖大拖小，命中区要是还按
 * 设计尺寸算，四边四角的缩放手柄都会跑偏（踩过：改完大小后右下角手柄偏出窗口）。
 */
function currentPanelSize() {
  const scale = mainWindow === null ? 1 : mainWindow.scale()
  const size = mainWindow === null ? { width: MODES.panel.width * scale, height: MODES.panel.height * scale } : mainWindow.size()
  return { scale, width: Math.max(1, size.width) / scale, height: Math.max(1, size.height) / scale }
}

/**
 * 回答窗口的命中区（物理 → 语义）。
 *
 * 区在 ui.mjs 的 panelHitZone 里（纯函数、可单测）：**四边 + 四角，八个方向都能
 * 用鼠标拖着改大小**。优先级是 标题栏按钮 / 页脚「停止」 > 缩放手柄 > 标题栏拖动 >
 * 客户区——上边最外面 6 DIP 是缩放手柄，再往下才轮到 HTCAPTION 拖动，两者不打架。
 */
function hitZone(x, y, data) {
  const { scale, width, height } = currentPanelSize()
  return panelHitZone(x / scale, y / scale, data, width, height)
}

/** 回答窗口标题栏上的点击（复制 / 关闭 / 停止）。 */
function clickMain(cssX, cssY, data) {
  const hit = panelHit(cssX, cssY, data, currentPanelSize().width)
  if (hit === 'copy') {
    void copyAnswer()
    return true
  }
  if (hit === 'speak') {
    toggleSpeak()
    return true
  }
  if (hit === 'close') {
    hideMain()
    return true
  }
  if (hit === 'stop') {
    void stopRun()
    return true
  }
  return true
}

/** 页脚回执的定时器。 */
let copyFeedbackTimer = null
/** 朗读器（第一次点朗读才建 COM 对象）。 */
let speaker = null
/** 朗读状态轮询定时器。 */
let speakingTimer = null

/** 懒建朗读器。 */
function ensureSpeaker() {
  if (speaker !== null) return speaker
  try {
    speaker = createSpeaker(api.koffi)
  } catch (error) {
    reportError('speech', error)
    speaker = null
  }
  return speaker
}

/** 刷新朗读状态（读完自动把按钮复原）。 */
function watchSpeaking() {
  if (speakingTimer !== null) return
  speakingTimer = setInterval(() => {
    if (speaker === null) return
    const speaking = speaker.isSpeaking()
    if (speaking === ui.speaking) return
    ui.speaking = speaking
    if (!speaking && speakingTimer !== null) {
      clearInterval(speakingTimer)
      speakingTimer = null
    }
    refreshMain()
  }, 400)
  speakingTimer.unref?.()
}

/** 朗读选中的原文（再点一次 = 停下）。 */
function toggleSpeak() {
  const instance = ensureSpeaker()
  if (instance === null || !instance.available()) {
    setCopyFeedback('朗读不可用')
    return
  }
  if (ui.speaking) {
    instance.stop()
    ui.speaking = false
    refreshMain()
    return
  }
  const text = ui.source
  if (text === '') return
  const started = instance.speak(text)
  ui.speaking = started
  refreshMain()
  if (started) watchSpeaking()
}

/** 停止朗读（换内容 / 关窗口时用）。 */
function stopSpeaking() {
  if (speaker === null) return
  speaker.stop()
  ui.speaking = false
  if (speakingTimer !== null) {
    clearInterval(speakingTimer)
    speakingTimer = null
  }
}

/** 回答窗口是否可用。 */
function mainReady() {
  return mainWindow !== null && mainWindow.isAlive()
}

/** 把回答状态推给窗口并重绘。 */
function refreshMain() {
  if (!mainReady()) return
  mainWindow.setState({
    mode: ui.mode,
    dark: ui.dark,
    hover: ui.hover,
    hoverButton: ui.hoverButton,
    action: ui.action,
    source: ui.source,
    answer: ui.answer,
    context: ui.context,
    speaking: ui.speaking,
    status: ui.status,
    error: ui.error,
    copyFeedback: ui.copyFeedback,
    scroll: ui.scroll,
    contentHeight: ui.contentHeight,
    viewHeight: ui.viewHeight,
    stopBox: ui.stopBox,
  })
}

/**
 * 显示回答窗口并定位（只有"面板"一种形态：悬浮球与最小化都已移除）。
 * 原生分层窗口没有边框，尺寸即内容尺寸。
 */
function applyMainMode(mode) {
  if (!mainReady()) return null
  if (mode === 'hidden') {
    hideMain()
    return null
  }
  ui.dark = systemDark()
  const css = MODES[mode]
  const anchor = state.selection !== null ? { x: state.selection.x, y: state.selection.y } : null
  const work = anchor !== null ? workAreaForPoint(api, anchor.x, anchor.y) : primaryWorkArea(api)
  const scale = anchor !== null
    ? monitorScaleForPoint(api, anchor.x, anchor.y)
    : monitorScaleForPoint(api, (work.left + work.right) / 2, (work.top + work.bottom) / 2)
  // 用户手动改过大小就沿用他的尺寸（否则用设计尺寸），再夹回工作区。
  const preferred = panel.size ?? { width: css.width * scale, height: css.height * scale }
  const width = Math.min(Math.round(preferred.width), Math.max(240, work.right - work.left))
  const height = Math.min(Math.round(preferred.height), Math.max(180, work.bottom - work.top))
  const base = panel.position ?? placePanelBySelection({
    workArea: work,
    selection: anchor,
    width,
    height,
    gap: 12,
  })
  const x = Math.min(Math.max(base.x, work.left), Math.max(work.left, work.right - width))
  const y = Math.min(Math.max(base.y, work.top), Math.max(work.top, work.bottom - height))

  ui.mode = mode
  panel.mode = mode
  panel.scale = scale
  panel.rect = { x, y, width, height }
  panel.position = { x, y }
  if (mode === 'panel') ui.scroll = 0
  refreshMain()
  mainWindow.show(x, y, width, height)
  return { x, y, width, height, scale, mode }
}

/** 关闭回答窗口（只有手动关闭会走到这里）。 */
function hideMain() {
  stopSpeaking()
  if (!mainReady()) return
  mainWindow.hide()
  panel.mode = 'hidden'
  ui.mode = 'hidden'
}

// ---------------------------------------------------------------- 划词菜单窗口

const menuUi = { dark: true, hover: -1 }

const menuWindow = api !== null && gdi !== null
  ? createNativeWindow({
      api,
      gdi,
      className: 'DshSelMenuWnd',
      title: 'DSH 划词助手菜单',
      initialState: menuUi,
      onPaint(painter, width, height, data, scale) {
        paintMenu(painter, width, height, data, scale)
      },
      onHitTest() {
        // 菜单整块都要能点：返回 client（返回 caption 收不到 WM_LBUTTONDOWN）
        return 'client'
      },
      onHover(x, y, data) {
        const scale = menuWindow.scale()
        if (x < 0) {
          const changed = data.hover !== -1
          data.hover = -1
          return changed
        }
        const row = menuRowAt(x / scale, y / scale)
        if (row !== data.hover) {
          data.hover = row
          return true
        }
        return false
      },
      onClick(x, y, data) {
        const scale = menuWindow.scale()
        const row = menuRowAt(x / scale, y / scale)
        void data
        if (row >= 0) runMenuAction(menuActionOf(row))
        return true
      },
      onError(error) {
        reportError('menu-window', error)
      },
    })
  : null

// 两个窗口都在这里创建（不可见），之后按需 show / hide
if (mainWindow !== null) {
  mainWindow.create()
  mainWindow.hide()
}
if (menuWindow !== null) {
  menuWindow.create()
  menuWindow.hide()
}

function menuReady() {
  return menuWindow !== null && menuWindow.isAlive()
}

/**
 * 把一次 UIA 探针结果写进这次选区：**选区文字**写 `selection.text`，
 * **选区所在的段落**写 `selection.context`。空结果保持原样（安静降级）。
 *
 * @param source - 这一步叫什么（uia-prefetch / uia-fresh）：只用于诊断——回答是不是
 *   "UIA 读到的"、还是退到了剪贴板，看 `lastResolve.source` 就知道。
 */
function applyProbe(selection, result, source) {
  if (result === null || result === undefined) return
  if (typeof result.selection === 'string' && result.selection.trim() !== '') {
    if (typeof selection.text !== 'string' || selection.text.trim() === '') selection.textSource = source
    selection.text = result.selection
  }
  if (typeof result.text === 'string' && result.text !== '') {
    selection.context = result.text
    selection.contextUnit = result.unit
    selection.contextState = 'ready'
  } else if (selection.contextState === 'reading') {
    selection.contextState = 'none'
  }
}

/**
 * 手势落下时的 UIA 预读：**不注入按键、不碰剪贴板**。
 *
 * 一次调用同时拿到"选中的是哪段文字"与"它所在的段落"——后者是给 agent 的上下文，
 * 前者是菜单项点下去之后真正要处理的东西。读不到就保持空串（安静降级）。
 *
 * @param selection - 这次划词的锚点对象。
 * @returns 在途的 promise（点菜单项时还要等它）。
 */
function startProbe(selection) {
  selection.contextState = 'reading'
  if (contextReader === null) {
    selection.contextState = 'disabled'
    state.lastProbe = { state: 'disabled', at: Date.now() }
    return Promise.resolve(null)
  }
  const pending = contextReader.probe(
    { x: selection.x, y: selection.y },
    { retries: MENU_PROBE_RETRIES, press: selection.press },
  )
  selection.pending = pending
  void pending
    .then((result) => {
      applyProbe(selection, result, 'uia-prefetch')
      if (result === null) {
        state.lastProbe = { state: 'none', at: Date.now(), stats: contextReader.stats() }
        return
      }
      state.lastProbe = {
        state: 'ready',
        selectionLength: typeof result.selection === 'string' ? result.selection.length : 0,
        contextLength: typeof result.text === 'string' ? result.text.length : 0,
        unit: result.unit,
        className: result.className,
        /** 这条 TextPattern 是从"点上的元素"还是"焦点元素"读到的。 */
        source: result.source,
        /** 这次手势（按下点/松开点）碰到这段选区了吗（false = 落在别处，多半是上次留下的）。 */
        atGesture: result.atGesture ?? null,
        candidates: result.candidates,
        at: Date.now(),
        stats: contextReader.stats(),
      }
    })
    .catch((error) => {
      selection.contextState = 'error'
      reportError('probe', error)
    })
  return pending
}

/** 等一个 promise 最多 ms 毫秒；超时返回字符串 'timeout'（定时器不留痕）。 */
async function waitFor(promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 手势落下后等一个"弹不弹"的结论。
 *
 * **两级预算**：先在 budgetMs 内等探针（正常的探针 10–30ms 就回来了，这一级几乎用不满）；
 * 超时说明它只是**慢**（跨进程 provider、无障碍树刚被焐热、系统一时繁忙），不是没有答案
 * ——探针本身还在跑，所以再宽限一段（budgetMs 的三倍，上限 1s）等它的结论。只有宽限期
 * 也用完才按"未知"处理：拖选保留剪贴板兜底；双击没有选区证据就不弹。
 *
 * 为什么要有宽限期：跳过去直接照弹的话，用户"在别处随便一拖"刚好撞上一次慢探针，
 * 菜单又会冒出来——那正是"选中一次之后菜单甩不掉"的另一条来路。宽限期的代价只是
 * 结论晚几十毫秒（探针一回来就出菜单），而不是"菜单变慢"。
 *
 * @param previous - 上一次菜单收起时绑的那段文字（见 policy.mjs 的 menuDecision）。
 * @param pressSnapshot - "按下那一刻"那张快照（`{ at, x, y, pending, result, driftPx }`，见
 *   startPressProbe）；没拍/关掉了传 null。它只用来回答"这次手势有没有选出新东西"，
 *   其中的 `driftPx`（读数到手时指针离按下点多远）用来剔掉"拍晚了"的快照——浏览器里
 *   UIA 首查慢，拖完才回来的读数会把这次手势自己选出来的文字当成"按下就已经选着"。
 * @returns `{ open, reason }`（见 policy.mjs 的 menuDecision）。
 */
async function decideMenu(pending, budgetMs, previous, kind, pressSnapshot = null) {
  // `MENU_DECIDE_MS=0` 是"手势一到就弹、不做任何过滤"的逃生舱：连剪贴板核实都不要走。
  if (budgetMs <= 0) return unknownFallback(kind)
  if (contextReader === null) return menuDecision(null, previous, { kind })
  // 按下快照通常早就回来了（它在按下那一刻就发出去了），这一步几乎不花时间；只给
  // PRESS_WAIT_MS 这么多宽限——超时就当没拍到（少一条判据，不拦这次划词）。
  const pressPending = pressSnapshot?.pending ?? null
  const pressResult = pressPending === null || pressPending === undefined
    ? null
    : await waitFor(pressPending, Math.min(budgetMs, PRESS_WAIT_MS))
  const pressProbe = pressResult === 'timeout' || pressResult === null || pressResult === undefined
    ? null
    : { ...pressResult, driftPx: snapshotDrift(pressSnapshot) }
  const first = await waitFor(pending, budgetMs)
  if (first !== 'timeout') return menuDecision(first, previous, { kind, pressProbe })
  const grace = Math.min(1000, budgetMs * 3)
  const second = await waitFor(pending, grace)
  // 宽限期也用完：还是读不到 → open 为 null（交给剪贴板核实，见 confirmByClipboard）。
  if (second === 'timeout') return menuDecision(null, previous, { kind, reason: 'timeout' })
  return menuDecision(second, previous, { kind, pressProbe })
}

/** 快照上量到的"读数到手时指针离按下点多远"（没量到给 null，policy 那边按可信处理）。 */
function snapshotDrift(pressSnapshot) {
  const drift = Number(pressSnapshot?.driftPx)
  return Number.isFinite(drift) ? drift : null
}

/**
 * UIA 判不了（`open: null`）时，用**剪贴板**核实一次"这次手势到底有没有选中文字"。
 *
 * 为什么只能靠剪贴板：办公套件（WPS 的 Qt 版最典型）整个窗口树里都没有文档的 TextPattern
 * ——实测 WPS PPT 的 UIA 树 376 个节点里只有两个功能区长条是文本控件，UIA 对"选没选中
 * 文字"无话可说。而 Ctrl+C 是**真的会说话**的：真选中文字就会复制出文字；拖动一个形状/
 * 窗口则什么都复制不出来（这正是"选中元素并拖动也弹菜单"的判别点）。
 *
 * 代价与边界都交给 selection.mjs 那几条规则（终端跳过、用户正在按 Ctrl+C 就不注入、只认
 * 前台窗口自己写的那次、用完把用户原来的文字放回去）；拿不准就**不表态**，由调用方退回
 * 老行为（见 policy.mjs 的 unknownFallback）。
 *
 * 核实成功时顺手把文字记进这次选区：点菜单项时就不用再复制一遍了。
 *
 * @param selection - 这次划词的锚点对象（核实成功会写入 `text` / `textSource`）。
 * @returns `{ state, reason, length }`；state 是 `text`（复制出文字了）/ `none`（没有文字，
 *   这次手势没在选文字）/ `skipped`（跑不起来：终端、用户正在 Ctrl+C、或显式关掉了核实）。
 */
async function confirmByClipboard(selection) {
  if (!CONFIRM_BY_CLIPBOARD) return { state: 'skipped', reason: 'disabled', length: 0 }
  const captured = await captureSelection(api, {
    checkOwner: OWNER_CHECK,
    // 这次注入是我们自己发的：没复制出文字（典型：把形状/窗口复制走了）时把用户原来的
    // 文字放回去，免得他们的剪贴板被我们弄丢（见 selection.mjs 的 restoreWhenEmpty）。
    restoreWhenEmpty: true,
    textOnly: true,
    onReport: (report) => {
      state.lastConfirm = report
    },
  })
  const report = state.lastConfirm
  const reason = typeof report?.reason === 'string' ? report.reason : 'timeout'
  if (captured !== null && captured.trim() !== '') {
    const text = clampSelection(captured, MAX_TEXT)
    selection.text = text
    selection.textSource = 'clipboard-confirm'
    return { state: 'text', reason: 'ok', length: text.length, formats: report?.formats ?? [] }
  }
  if (reason === 'terminal' || reason === 'user-copy') return { state: 'skipped', reason, length: 0 }
  return { state: 'none', reason, length: 0, formats: report?.formats ?? [], editor: report?.editor ?? null }
}

/**
 * 显示划词菜单（带时限）。
 *
 * 只记「这次划在哪、到时候要处理哪段文字」：回答窗口的内容归它自己，绝不在弹菜单时被
 * 改写（踩过：这里顺手把 ui.source/answer/status 重置了，于是新划词后只要窗口重绘一次，
 * 就变成「显示新选中的文字 + 没有文本输出 + 就绪」。现在只有点解释/翻译才换内容）。
 *
 * @param selection - 这次划词的锚点对象；它的 text 可能还是空的（UIA 预读正在跑，点菜单
 *   项时才会等它）。
 */
function showMenu(selection) {
  if (!menuReady()) return null
  const x = selection.x
  const y = selection.y
  state.selection = selection
  menu.selection = selection
  menu.dark = systemDark()
  const css = MODES.menu
  const work = workAreaForPoint(api, x, y)
  const scale = monitorScaleForPoint(api, x, y)
  const width = Math.round(css.width * scale)
  const height = Math.round(css.height * scale)
  const px = Math.min(Math.max(x + GAP, work.left), Math.max(work.left, work.right - width))
  const py = Math.min(Math.max(y + GAP, work.top), Math.max(work.top, work.bottom - height))
  menu.visible = true
  menu.rect = { x: px, y: py, width, height }
  menu.scale = scale
  menu.anchor = { x, y }
  menu.hover = -1
  menuWindow.setState({ dark: menu.dark, hover: -1 })
  menuWindow.show(px, py, width, height)
  if (menu.timer !== null) clearTimeout(menu.timer)
  menu.timer = setTimeout(() => {
    hideMenu('timeout')
  }, MENU_TIMEOUT_MS)
  menu.timer.unref?.()
  return menu.rect
}

/** 收起划词菜单（不影响回答窗口）。 */
function hideMenu(reason) {
  if (menu.timer !== null) {
    clearTimeout(menu.timer)
    menu.timer = null
  }
  if (menu.visible) {
    state.lastMenuDismiss = { reason, at: Date.now() }
    // 这个菜单绑的是哪段文字：菜单收起后，"手势没碰到 + 文字没变"的那次探针就是它。
    state.lastMenuSelection = typeof menu.selection?.text === 'string' ? menu.selection.text : ''
    menu.visible = false
    if (menuReady()) menuWindow.hide()
  }
  menu.rect = null
  menu.hover = -1
  menu.selection = null
}

// ---------------------------------------------------------------- 跑一轮 agent

/** 复制回答到剪贴板，并在页脚给一个看得见的回执。 */
async function copyAnswer() {
  if (ui.answer === '') {
    setCopyFeedback('没有可复制的内容')
    return
  }
  let copied = false
  try {
    const { writeClipboardText } = await import('./win32.mjs')
    copied = writeClipboardText(api, ui.answer) !== false
  } catch (error) {
    reportError('copy', error)
  }
  setCopyFeedback(copied ? '已复制' : '复制失败')
}

/** 页脚回执（1.6s 后自动消失）。 */
function setCopyFeedback(text) {
  ui.copyFeedback = text
  refreshMain()
  if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = setTimeout(() => {
    copyFeedbackTimer = null
    ui.copyFeedback = ''
    refreshMain()
  }, text === '已复制' ? 1600 : 2400)
  copyFeedbackTimer.unref?.()
}

async function stopRun() {
  const sessionId = state.run?.sessionId
  state.run?.abort?.()
  state.run = null
  ui.status = 'done'
  refreshMain()
  if (sessionId === undefined) return
  try {
    await fetch(DSH_ORIGIN + '/api/dsh-selection-tools/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch (error) {
    reportError('stop', error)
  }
}

/**
 * 把回答窗口切到某一轮的初始状态并显示。
 *
 * 只有点菜单项才会走到这里——新划词一律不动回答窗口里的内容
 * （踩过：弹菜单时顺手重置 ui.source/answer，于是"新划词后点一下窗口"就变成"显示新选中的
 * 文字 + 没有文本输出 + 就绪"）。
 *
 * @param action - 解释 / 翻译。
 * @param selection - 这次要处理哪段选区（菜单上绑的那一次）。
 * @param status - `reading`（正在读选区）/ `running` / `error`。
 * @param error - status 为 error 时的错误文案。
 */
function openPanel(action, selection, status, error = '') {
  state.run?.abort?.()
  state.run = null
  ui.action = action
  ui.source = selection === null || typeof selection.text !== 'string' ? '' : selection.text
  ui.answer = ''
  ui.error = error
  ui.copyFeedback = ''
  ui.context = selection === null || typeof selection.context !== 'string' ? '' : selection.context
  ui.status = status
  stopSpeaking()
  ui.scroll = 0
  // 第一次打开时落在屏幕右下角；之后沿用用户拖到的位置
  if (panel.mode === 'hidden') panel.position = null
  applyMainMode('panel')
  refreshMain()
}

/**
 * 解析"这次要处理的是哪段文字"。
 *
 * 优先级（`DSH_SELECTION_TEXT_SOURCE` 可整体改成只用某一种）：
 * 1. `selection.text` 已经有的（例如 `/simulate` 预置的文本）；
 * 2. 菜单弹出时就开始的 UIA 预读结果；
 * 3. 现补读一次 UIA（无障碍树这会儿已经热了，通常几毫秒就回来）；
 * 4. **剪贴板兜底**——注入一次 Ctrl+C 再读剪贴板。
 *
 * 第 4 条是全插件唯一会碰用户剪贴板的地方，而且只在用户**点了菜单按钮之后**、前三条
 * 都拿不到文字时才会走到：划词本身一次都不碰剪贴板。
 *
 * @param selection - 这次划词的锚点对象。
 * @returns `{ text, source }`（source 只用于诊断）：一个来源都拿不到时返回 null。
 */
async function resolveSelection(selection) {
  if (typeof selection.text === 'string' && selection.text.trim() !== '') {
    // 已经有了（/simulate 预置，或预读早于点击完成并写好了）：直接用。
    return { text: selection.text, source: selection.textSource === '' ? 'preset' : selection.textSource }
  }
  const attempts = []
  if (TEXT_SOURCE !== 'clipboard') {
    const prefetched = selection.pending === null || selection.pending === undefined ? null : await selection.pending
    applyProbe(selection, prefetched, 'uia-prefetch')
    attempts.push({ source: 'uia-prefetch', text: prefetched === null ? '' : prefetched.selection })
    if (prefetched === null && contextReader !== null) {
      const fresh = await contextReader.probe({ x: selection.x, y: selection.y }, { retries: CLICK_PROBE_RETRIES })
      applyProbe(selection, fresh, 'uia-fresh')
      attempts.push({ source: 'uia-fresh', text: fresh === null ? '' : fresh.selection })
    }
  }
  const picked = pickSelection(attempts)
  if (picked !== null) return picked
  if (TEXT_SOURCE === 'uia') return null
  // 兜底：注入一次 Ctrl+C 读剪贴板（只在点了菜单按钮之后走这里）。
  const captured = await captureSelection(api, {
    checkOwner: OWNER_CHECK,
    onReport: (report) => {
      state.lastCapture = report
    },
  })
  const fallback = pickSelection([{ source: 'clipboard', text: captured === null ? '' : clampSelection(captured, MAX_TEXT) }])
  return fallback
}

/**
 * 点菜单项之后：解析选区 → 跑一轮。
 *
 * @param action - 解释 / 翻译。
 * @param selection - 菜单上绑的那次选区。
 * @param isCurrent - 这次点击还是最新的吗（用户有没有紧接着又点了一次）。
 */
async function beginFromMenu(action, selection, isCurrent) {
  if (selection === null || selection === undefined) return
  state.selection = selection
  // 先给反馈：解析最长要走一次剪贴板兜底，不能让用户"点了没反应"。
  openPanel(action, selection, 'reading')
  let resolved = null
  try {
    resolved = await resolveSelection(selection)
  } catch (error) {
    reportError('resolve', error)
    resolved = null
  }
  state.lastResolve = {
    ok: resolved !== null,
    source: resolved === null ? '' : resolved.source,
    length: resolved === null ? 0 : resolved.text.length,
    at: Date.now(),
  }
  if (!isCurrent()) return
  if (resolved === null) {
    openPanel(action, selection, 'error', '未能读取选中的文字，请重新划词后再试')
    return
  }
  selection.text = resolved.text
  startRun(action, selection)
}

/** 点菜单项之后的串行队列（latest-wins）：解析选区 + 开跑。 */
let menuRunQueue = null

/**
 * 点菜单项（原生窗口的点击与 `/click` 验收端点共用）。
 *
 * 必须先取出"这个菜单绑的那次选区"再收菜单——`hideMenu` 会把 `menu.selection` 清掉。
 */
function runMenuAction(action) {
  const selection = menu.selection
  hideMenu('item-click')
  if (selection === null) return
  // 朗读是"立等可取"的快速动作：不走 LLM 队列、不开主窗，直接读选中的文字。
  // 等待 UIA/剪贴板回填文本（划词时 text 可能还是空的）。
  if (action === 'speak') {
    void speakSelection(selection)
    return
  }
  if (menuRunQueue === null) {
    menuRunQueue = createLatestQueue({
      run: (job, seq) => beginFromMenu(job.action, job.selection, () => menuRunQueue.isLatest(seq)),
      onError: (error) => reportError('menu-run', error),
    })
  }
  menuRunQueue.submit({ action, selection })
}

/**
 * 朗读选中的文字：等到 UIA/剪贴板把文本回填到 selection.text 后再触发 SAPI。
 * 若 1.5 秒内还没回填，就用现成的内容尝试一次；再不行就放弃。
 */
async function speakSelection(selection) {
  const text = await waitForSelectionText(selection, 1500)
  if (text === '') {
    setCopyFeedback('未能读取选中文本')
    return
  }
  // 复用现有朗读器：直接喂文本，不再需要走 ui.source。
  const instance = ensureSpeaker()
  if (instance === null || !instance.available()) {
    setCopyFeedback('朗读不可用')
    return
  }
  if (ui.speaking) {
    instance.stop()
    ui.speaking = false
    refreshMain()
    return
  }
  const started = instance.speak(text)
  ui.speaking = started
  refreshMain()
  if (started) watchSpeaking()
}

/** 等到 selection.text 变成非空字符串（或超时）。 */
function waitForSelectionText(selection, timeoutMs) {
  return new Promise((resolve) => {
    const current = typeof selection.text === 'string' ? selection.text.trim() : ''
    if (current !== '') {
      resolve(current)
      return
    }
    const start = Date.now()
    const timer = setInterval(() => {
      const text = typeof selection.text === 'string' ? selection.text.trim() : ''
      if (text !== '') {
        clearInterval(timer)
        resolve(text)
        return
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer)
        resolve('')
      }
    }, 80)
    timer.unref?.()
  })
}

/**
 * 菜单行号 → 动作。菜单从上到下是：解释、总结、翻译。
 * @param row - `menuRowAt` 给出的行号（0/1/2）。
 */
function menuActionOf(row) {
  if (row === 1) return 'summarize'
  if (row === 2) return 'translate'
  if (row === 3) return 'speak'
  return 'explain'
}

/**
 * 发起一轮解释/总结/翻译，流式画到回答窗口。
 * @param action - 解释 / 总结 / 翻译。
 * @param selection - 这一次要处理哪段选区（含已解析好的 text 与 context）。
 */
function startRun(action, selection = state.selection) {
  if (selection === null || typeof selection.text !== 'string' || selection.text.trim() === '') return
  // 只有点菜单项才换内容：这里把"这次要处理什么"写进回答窗口
  // （别处一律不动 ui.source —— 新划词只更新 state.selection，不会改窗口）
  openPanel(action, selection, 'running')

  const controller = new AbortController()
  state.run = { abort: () => controller.abort(), sessionId: undefined }
  const text = selection.text
  const context = typeof selection.context === 'string' ? selection.context : ''
  void (async () => {
    try {
      const response = await fetch(DSH_ORIGIN + '/api/dsh-selection-tools/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, text, context, locale: LOCALE }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pending = ''
      let lastPaint = Date.now()
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const payload = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('')
          if (payload !== '') {
            const event = JSON.parse(payload)
            if (event.type === 'delta') pending += event.text
            else if (event.type === 'session') {
              if (state.run !== null) state.run.sessionId = event.sessionId
            } else if (event.type === 'done') {
              pending = ''
              ui.answer = event.text !== '' ? event.text : ui.answer
              ui.status = 'done'
            } else if (event.type === 'error') {
              ui.status = 'error'
              ui.error = event.message
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
        const now = Date.now()
        if (pending !== '' && now - lastPaint > 80) {
          ui.answer += pending
          pending = ''
          lastPaint = now
          refreshMain()
        }
      }
      if (pending !== '') {
        ui.answer += pending
        refreshMain()
      }
    } catch (error) {
      if (controller.signal.aborted) return
      ui.status = 'error'
      ui.error = error instanceof Error ? error.message : String(error)
      refreshMain()
    } finally {
      if (state.run !== null && state.run.sessionId === undefined) state.run = null
      refreshMain()
    }
  })()
}

// ---------------------------------------------------------------- 划词

/**
 * 点是否落在某个窗口矩形内。
 *
 * 注意：这里的矩形是 `{ x, y, width, height }`（窗口几何用的就是这套字段），
 * 而 gesture.mjs 的 pointInRect 读的是 `{ left, right, top, bottom }`。
 * 两者混用会让"点在窗口内"恒为 false——表现为按任何键都立刻收起菜单（菜单"点了就消失"
 * 且点不动），踩过一次。
 */
function inRect(point, rect) {
  if (rect === null || rect === undefined) return false
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

/**
 * 处理一次手势：**立刻**决定要不要弹菜单——不取词、不碰剪贴板。
 *
 * 老实现是"先注入 Ctrl+C 读剪贴板，读到了才弹菜单"，于是取词失败就等于菜单呼不出来
 * （DSH 桌面端的 WebView2 窗口里注入的 Ctrl+C 拿不到剪贴板；个别外部应用也偶发同样的问题）。
 * 现在手势一落地就开始 UIA 预读，最多等 MENU_DECIDE_MS 拿一个"这一点上有没有选中文字"的
 * 结论——菜单弹出的条件里再也没有"能不能取到词"这一项。真正的选中文案留到用户**点菜单项**
 * 时才解析（UIA 优先，读不到才注入一次 Ctrl+C 读剪贴板）。
 *
 * @param gesture - 手势（含落点）。
 * @param isCurrent - 这次手势是不是最新的（等待期间用户有没有又划一次）。
 */
async function handleGesture(gesture, isCurrent) {
  state.lastGesture = { ...gesture, at: Date.now() }
  if (inRect(gesture, menu.rect) || inRect(gesture, panel.rect)) return
  const selection = {
    text: '',
    /** 这段文字是从哪一步读到的（uia-prefetch / uia-fresh / clipboard / preset）。 */
    textSource: '',
    x: gesture.x,
    y: gesture.y,
    /**
     * 手势**按下**的地方。判断"读到的选区是不是这次手势选出来的"要用它：
     * 菜单收起之后旧选区还留在应用里，光凭落点分不出"这次真选了"和"上次留下的"。
     */
    press: {
      x: Number.isFinite(gesture.downX) ? gesture.downX : gesture.x,
      y: Number.isFinite(gesture.downY) ? gesture.downY : gesture.y,
    },
    at: Date.now(),
    kind: gesture.kind,
    context: '',
    contextUnit: '',
    contextState: 'idle',
    /** 在途的 UIA 预读（点菜单项时还要等它）。 */
    pending: null,
  }
  const pending = startProbe(selection)
  deciding = true
  let decision
  let confirm = null
  try {
    decision = await decideMenu(pending, MENU_DECIDE_MS, state.lastMenuSelection, gesture.kind, gesture.press ?? null)
    if (decision.open === null) {
      // UIA 说不出话（WPS/Office 的 Qt 版这类不暴露文档文本的应用）：用剪贴板核实一次
      // "到底有没有选中文字"——真选中了会复制出文字，拖动形状/窗口则什么都复制不出来。
      confirm = await confirmByClipboard(selection)
      if (confirm.state === 'text') decision = { open: true, reason: 'clipboard' }
      else if (confirm.state === 'none') decision = { open: false, reason: 'unconfirmed' }
      else decision = unknownFallback(gesture.kind)
    }
  } finally {
    deciding = false
  }
  state.lastMenuDecision = { open: decision.open, reason: decision.reason, kind: gesture.kind, at: Date.now() }
  state.recentDecisions.push({
    at: state.lastMenuDecision.at,
    kind: gesture.kind,
    distance: Math.round(gesture.distance ?? 0),
    open: decision.open,
    reason: decision.reason,
    /** 探针当时读到了什么（null = 这次是"宽限期也用完"的兜底）。 */
    probe: state.lastProbe === null
      ? null
      : { at: state.lastProbe.at, state: state.lastProbe.state, source: state.lastProbe.source, atGesture: state.lastProbe.atGesture ?? null, selectionLength: state.lastProbe.selectionLength ?? 0, className: state.lastProbe.className ?? '' },
    /** 按下那一刻读到的是什么（判"这次手势有没有选出新东西"的对照面）。 */
    pressProbe: summarizePress(gesture.press ?? null),
    /** UIA 判不了时的剪贴板核实结果（null = 这次 UIA 直接给出了结论，没走核实）。 */
    confirm,
    point: { x: gesture.x, y: gesture.y },
    press: { x: gesture.downX, y: gesture.downY },
  })
  if (state.recentDecisions.length > 20) state.recentDecisions.shift()
  if (!isCurrent()) {
    // 等待期间用户又划了一次：这次的结果过期了，绝不能拿它弹菜单。
    state.lastMenuDecision.superseded = true
    return
  }
  if (!decision.open) return
  // 只弹菜单：回答窗口不受影响（只有点解释/翻译才换里面的内容）
  showMenu(selection)
}

/** 鼠标轮询：手势检测 + 任意键点到别处收起菜单 + Esc 收起菜单。 */
function startHook() {
  // 手势要串行、且只有最新那次作数：一次手势要等 UIA 的"有没有选中文字"结论（最多
  // MENU_DECIDE_MS），这期间用户完全可能又划一次——拿过期的那次去弹菜单，菜单绑的就不是
  // 用户看着选的那段文字。见 gesture.mjs 的 createLatestQueue。
  gestureQueue = createLatestQueue({
    run: (gesture, seq) => handleGesture(gesture, () => gestureQueue.isLatest(seq)),
    onError: (error) => reportError('gesture', error),
  })
  const detector = createGestureDetector({
    // 按下的那一刻拍一张"手势之前的选区"：只有它能把"拖动一个已选中的元素"和"拖选文字"
    // 分开（见 startPressProbe 与 policy.mjs 的 menuDecision）。
    onPress: (press) => startPressProbe(press),
    onGesture: (gesture) => {
      // 快照跟着手势一起进队列：等待期间用户又按了一下的话，这次手势要用的仍是**它自己
      // 按下时**拍的那张，而不是更新鲜的那张。
      gestureQueue.submit({ ...gesture, press: pressSnapshot })
    },
  })
  const buttons = { left: false, right: false, middle: false }
  let escapePressed = false
  const point = {}
  setInterval(() => {
    try {
      if (!api.GetCursorPos(point)) return
      const left = (Number(api.GetAsyncKeyState(VK_LBUTTON)) & 0x8000) !== 0
      const right = (Number(api.GetAsyncKeyState(VK_RBUTTON)) & 0x8000) !== 0
      const middle = (Number(api.GetAsyncKeyState(VK_MBUTTON)) & 0x8000) !== 0
      detector.push({ down: left, x: point.x, y: point.y, time: Date.now() })

      // 任意按键在别处按下 → 菜单收起（点在菜单自己身上不算）
      const anyDown = (left && !buttons.left) || (right && !buttons.right) || (middle && !buttons.middle)
      if (anyDown && menu.visible && !inRect(point, menu.rect)) hideMenu('outside-click')
      buttons.left = left
      buttons.right = right
      buttons.middle = middle

      const escapeDown = (Number(api.GetAsyncKeyState(VK_ESCAPE)) & 0x8000) !== 0
      if (escapeDown && !escapePressed && menu.visible) hideMenu('escape')
      escapePressed = escapeDown
    } catch (error) {
      reportError('poll', error)
    }
  }, POLL_MS).unref?.()
}

// ---------------------------------------------------------------- HTTP（状态 / 验收）

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

function respondJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/status') {
    respondJson(res, 200, {
      ok: true,
      hookEnabled: HOOK_ENABLED,
      menuTimeoutMs: MENU_TIMEOUT_MS,
      /** 手势落下后给 UIA 的决策窗口（毫秒）。 */
      menuDecideMs: MENU_DECIDE_MS,
      /** 选区文字的来源策略：auto / uia / clipboard。 */
      textSource: TEXT_SOURCE,
      menu: { visible: menu.visible, rect: menu.rect, scale: menu.scale, hover: menu.hover },
      panel: { mode: panel.mode, rect: panel.rect, position: panel.position, scale: panel.scale },
      ui: {
        status: ui.status,
        answerLength: ui.answer.length,
        sourceLength: ui.source.length,
        speaking: ui.speaking,
        copyFeedback: ui.copyFeedback,
        scroll: ui.scroll,
        contentHeight: Math.round(ui.contentHeight),
        viewHeight: Math.round(ui.viewHeight),
      },
      lastGesture: state.lastGesture,
      /** 最近一次 UIA 探针读到了什么（菜单呼不出来时先看这里）。 */
      lastProbe: state.lastProbe,
      /** 最近一次"按下那一刻"的选区快照（"这次手势有没有选出新东西"的对照面）。 */
      pressProbe: state.lastPressProbe,
      /** 最近一次"用剪贴板核实有没有选中文字"的报告（UIA 判不了时才走这一步）。 */
      lastConfirm: state.lastConfirm,
      /** 最近一次"弹不弹菜单"的结论与理由。 */
      lastMenuDecision: state.lastMenuDecision,
      /** 最近一次点菜单项之后，用的是哪个来源的文字。 */
      lastResolve: state.lastResolve,
      /** 最近 20 次"弹不弹"的结论（偶发"划不出来"时按时间顺查看每次的理由）。 */
      recentDecisions: state.recentDecisions,
      /** 上一次菜单收起时绑的那段文字（判断"旧选区"要用它比对）。 */
      lastMenuSelection: { length: state.lastMenuSelection.length, text: state.lastMenuSelection.slice(0, 120) },
      /** 最近一次剪贴板兜底取词（只在点菜单项后 UIA 读不到时才有）。 */
      lastCapture: state.lastCapture,
      gestures: gestureQueue === null ? null : gestureQueue.stats(),
      lastMenuDismiss: state.lastMenuDismiss ?? null,
      context: {
        enabled: contextReader !== null,
        /** 这次划词的选区/段落是怎么读到的：reading / ready / none / disabled / error。 */
        state: state.selection === null ? 'idle' : (state.selection.contextState ?? 'idle'),
        unit: state.selection === null ? '' : (state.selection.contextUnit ?? ''),
        /** 这次划词的选中文案长度（UIA 读到、或点菜单项后解析出来的）。 */
        selectionLength: state.selection === null ? 0 : String(state.selection.text ?? '').length,
        length: ui.context.length,
        stats: contextReader === null ? null : contextReader.stats(),
      },
      errors: state.errors.slice(-5),
      dshOrigin: DSH_ORIGIN,
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/simulate') {
    void (async () => {
      try {
        const body = await readJson(req)
        const text = clampSelection(String(body.text ?? '选中文本'), MAX_TEXT)
        const work = primaryWorkArea(api)
        const x = typeof body.x === 'number' ? body.x : work.right - 400
        const y = typeof body.y === 'number' ? body.y : 300
        // 造一个"已经读到选区"的划词锚点（跳过手势与 UIA 探针），供验收脚本走完整链路：
        // 弹菜单 → /click 点菜单项 → 直接拿这里的 text 跑一轮。
        const selection = {
          text,
          textSource: 'preset',
          x,
          y,
          at: Date.now(),
          kind: 'simulate',
          context: typeof body.context === 'string' ? body.context : '',
          contextUnit: '',
          contextState: typeof body.context === 'string' && body.context !== '' ? 'ready' : 'idle',
          pending: null,
        }
        const rect = showMenu(selection)
        respondJson(res, 200, { ok: true, menu: rect })
      } catch (error) {
        reportError('simulate', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  // 验收/排障：在某个屏幕坐标上直接跑一次 UIA 探针，看看"菜单为什么不弹"。
  if (req.method === 'POST' && url.pathname === '/probe') {
    void (async () => {
      try {
        const body = await readJson(req)
        if (contextReader === null) {
          respondJson(res, 200, { ok: false, message: 'context reader disabled' })
          return
        }
        const point = { x: Number(body.x ?? 0), y: Number(body.y ?? 0) }
        const retries = Number.isFinite(body.retries) ? Number(body.retries) : undefined
        // press 可以显式给：验收时用"元素看点 A、手势按在 B"复现"旧选区"那一路
        // （不给就按 point 算，跟真实手势里探针点即落点的老行为一致）。
        const press = typeof body.press === 'object' && body.press !== null
          ? { x: Number(body.press.x ?? point.x), y: Number(body.press.y ?? point.y) }
          : point
        const result = await contextReader.probe(point, { retries, press })
        // 按下那一刻读到的是什么：`pressSelection` 显式给（不带就是"没拍到"那一档），
        // 用来复现"拖动一个已选中的元素"（unchanged-selection）与"真的拖选了文字"这两路。
        // `pressDriftPx` 对应真实时序里"读数到手那一刻指针离按下点多远"，用来复现"拍晚了"
        // 那条（浏览器里 UIA 首查慢，读数回来时已经拖完）。
        const drift = Number(body.pressDriftPx)
        const pressProbe = typeof body.pressSelection === 'string'
          ? { selection: body.pressSelection, ...(Number.isFinite(drift) ? { driftPx: drift } : {}) }
          : null
        const provisional = menuDecision(result, '', { kind: typeof body.kind === 'string' ? body.kind : '', pressProbe })
        // `confirm: true` → UIA 判不了时**真的**跑一次剪贴板核实（会注入 Ctrl+C，仅排障用）；
        // 不传的话 open 为 null 只是"待核实"，不会碰剪贴板。
        const confirm = body.confirm === true && provisional.open === null ? await confirmByClipboard({}) : null
        const decision = confirm === null
          ? provisional
          : confirm.state === 'text'
            ? { open: true, reason: 'clipboard' }
            : confirm.state === 'none'
              ? { open: false, reason: 'unconfirmed' }
              : unknownFallback(typeof body.kind === 'string' ? body.kind : '')
        respondJson(res, 200, {
          ok: true,
          decision,
          selection: result === null ? '' : result.selection,
          context: result === null ? '' : result.text,
          source: result === null ? '' : result.source,
          atGesture: result === null ? null : (result.atGesture ?? null),
          /** 选区矩形（诊断用：看"为什么没弹"时对照着手势落点）。 */
          rects: result === null ? null : (result.rects ?? null),
          className: result === null ? '' : result.className,
          pressProbe,
          confirm,
          stats: contextReader.stats(),
        })
      } catch (error) {
        reportError('probe', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/window') {
    void (async () => {
      try {
        const body = await readJson(req)
        const op = String(body.op ?? '')
        if (op === 'mode') {
          const mode = ['panel', 'hidden'].includes(body.mode) ? body.mode : 'panel'
          const geometry = mode === 'hidden' ? (hideMain(), null) : applyMainMode(mode)
          respondJson(res, 200, { ok: true, geometry, mode: panel.mode })
          return
        }
        if (op === 'hide-menu') {
          hideMenu('api')
          respondJson(res, 200, { ok: true, menu: menu.visible })
          return
        }
        respondJson(res, 400, { ok: false, message: 'unknown op "' + op + '"' })
      } catch (error) {
        reportError('window', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/click') {
    void (async () => {
      try {
        const body = await readJson(req)
        const target = String(body.target ?? (menu.visible ? 'menu' : 'main'))
        const cssX = Number(body.x ?? 0)
        const cssY = Number(body.y ?? 0)
        if (target === 'menu') {
          const row = menuRowAt(cssX, cssY)
          if (row >= 0) runMenuAction(menuActionOf(row))
          respondJson(res, 200, { ok: true, target, row })
          return
        }
        const scale = mainWindow.scale()
        const handled = clickMain(cssX, cssY, ui)
        void scale
        respondJson(res, 200, { ok: true, target, handled })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/wheel') {
    void (async () => {
      try {
        const body = await readJson(req)
        const delta = Number(body.delta ?? -120)
        const maxScroll = Math.max(0, ui.contentHeight - ui.viewHeight)
        ui.scroll = Math.min(maxScroll, Math.max(0, ui.scroll - Math.sign(delta) * 60))
        refreshMain()
        respondJson(res, 200, { ok: true, scroll: ui.scroll, maxScroll, rect: panel.rect })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/hittest') {
    void (async () => {
      try {
        const body = await readJson(req)
        const target = String(body.target ?? 'main')
        const cssX = Number(body.x ?? 0)
        const cssY = Number(body.y ?? 0)
        const zone = target === 'menu' ? 'client' : hitZone(cssX * mainWindow.scale(), cssY * mainWindow.scale(), ui)
        // code 是真正回给 Windows 的 WM_NCHITTEST 返回值（10=左 11=右 12=上 15=下，
        // 13/14/16/17 是四个对角）：验收时看这个，别只看语义名字。
        respondJson(res, 200, { ok: true, target, zone, code: hitTestCode(zone) })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/context') {
    void (async () => {
      try {
        const body = await readJson(req)
        if (contextReader === null) {
          respondJson(res, 200, { ok: false, message: 'context reader disabled' })
          return
        }
        const point = { x: Number(body.x ?? 0), y: Number(body.y ?? 0) }
        if (body.diagnose === true) {
          respondJson(res, 200, { ok: true, diagnose: await contextReader.diagnose(point) })
          return
        }
        const expected = typeof body.expected === 'string' ? body.expected : undefined
        respondJson(res, 200, { ok: true, context: await contextReader.read(point, expected), stats: contextReader.stats() })
      } catch (error) {
        reportError('context', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/capture') {
    void (async () => {
      try {
        const body = await readJson(req)
        const file = String(body.file ?? join(tmpdir(), 'dsh-selection-overlay.bmp'))
        const target = String(body.target ?? (panel.mode !== 'hidden' ? 'main' : 'menu'))
        const rect = target === 'menu' ? menu.rect : panel.rect
        if (rect === null) {
          respondJson(res, 400, { ok: false, message: 'window hidden' })
          return
        }
        const shot = captureScreenRect(api, gdi, rect.x, rect.y, rect.width, rect.height, file)
        respondJson(res, 200, { ok: true, ...shot })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  respondJson(res, 404, { ok: false, message: 'not found' })
})

server.listen(Number(process.env.DSH_SELECTION_PORT ?? 0), '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write('dsh-selection-tools companion (native) listening on http://127.0.0.1:' + port + ' (hook=' + (HOOK_ENABLED ? 'on' : 'off') + ')\n')
  if (api === null || gdi === null) {
    reportError('init', new Error('koffi / GDI+ 不可用：系统级划词已禁用'))
    return
  }
  if (HOOK_ENABLED) startHook()
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.on('uncaughtException', (error) => reportError('uncaught', error))
process.on('unhandledRejection', (error) => reportError('unhandled', error))
