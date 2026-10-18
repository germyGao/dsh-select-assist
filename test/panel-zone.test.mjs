import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MODES, PANEL, PANEL_RESIZE, THEMES, menuRowAt, paintMenu, paintPanel, panelLayout, panelButtons, panelEdgeZone, panelHit, panelHitZone } from '../companion/native/ui.mjs'
import { hitTestCode } from '../companion/native/window.mjs'

/**
 * 回答窗口的缩放手柄：**四边 + 四角，八个方向都能用鼠标拖着改大小**。
 *
 * 命中区是纯函数（ui.mjs 的 panelEdgeZone / panelHitZone），所以这里能直接把
 * "某个 DIP 坐标会落到哪条边、回给 Windows 哪个 HT 代码"钉住——浮层是自绘的弹窗，
 * 没有系统边框帮忙，错了只能靠人肉拖窗口才发现（右下角曾经就是这么跑偏的）。
 */
const W = MODES.panel.width
const H = MODES.panel.height
/** 空闲面板：没有原文/上下文，也没有「停止」按钮。 */
const IDLE = { source: '', context: '', stopBox: null }

test('四条边都能缩放（上边过去留给拖动，现在也是缩放手柄）', () => {
  const edges = {
    'resize-left': [2, H / 2],
    'resize-right': [W - 2, H / 2],
    'resize-top': [W / 2, 2],
    'resize-bottom': [W / 2, H - 2],
  }
  for (const [zone, [x, y]] of Object.entries(edges)) {
    assert.equal(panelEdgeZone(x, y, W, H), zone)
    assert.equal(panelHitZone(x, y, IDLE, W, H), zone)
  }
})

test('四个角都是对角缩放手柄（上左/上右不再只是"左右边"）', () => {
  const corners = {
    'resize-topleft': [2, 2],
    'resize-topright': [W - 2, 2],
    'resize-bottomleft': [2, H - 2],
    'resize-bottomright': [W - 2, H - 2],
  }
  for (const [zone, [x, y]] of Object.entries(corners)) {
    assert.equal(panelEdgeZone(x, y, W, H), zone)
    assert.equal(panelHitZone(x, y, IDLE, W, H), zone)
  }
})

test('八个方向各自映射到不同的 HT 代码（真正回给 Windows 的那个）', () => {
  // 10=左 11=右 12=上 15=下；13/14/16/17 = 四个对角（HTLEFT / HTTOP …）
  const expected = {
    'resize-left': 10,
    'resize-right': 11,
    'resize-top': 12,
    'resize-topleft': 13,
    'resize-topright': 14,
    'resize-bottom': 15,
    'resize-bottomleft': 16,
    'resize-bottomright': 17,
  }
  const codes = new Set()
  for (const [zone, code] of Object.entries(expected)) {
    assert.equal(hitTestCode(zone), code, zone)
    // 退化成客户区（1）就等于"这块拉不动"
    assert.notEqual(code, hitTestCode('client'))
    codes.add(code)
  }
  assert.equal(codes.size, 8)
})

test('窗口中间既不是手柄也不是拖动区', () => {
  assert.equal(panelEdgeZone(W / 2, H / 2, W, H), null)
  assert.equal(panelHitZone(W / 2, H / 2, IDLE, W, H), 'client')
})

test('标题栏（按钮之外）仍然是拖动区', () => {
  assert.equal(panelHitZone(W / 2, 22, IDLE, W, H), 'caption')
  assert.equal(hitTestCode('caption'), 2) // HTCAPTION
})

test('标题栏按钮压过右上角的缩放手柄', () => {
  const close = panelButtons(IDLE, W).find((button) => button.id === 'close')
  assert.ok(close !== undefined)
  // 关闭按钮的最右端正好落在右上角区里：这一点必须是按钮的，不能被手柄抢走
  const x = close.x + close.size - 2
  const y = close.y + 2
  assert.equal(panelEdgeZone(x, y, W, H), 'resize-topright')
  assert.equal(panelHit(x, y, IDLE, W), 'close')
  assert.equal(panelHitZone(x, y, IDLE, W, H), 'client')
  // 按钮上方那一条仍然是上边手柄（上边整条都能拉）
  assert.equal(panelHitZone(x, 3, IDLE, W, H), 'resize-topright')
})

test('页脚「停止」压过下边的缩放手柄', () => {
  const stop = { x: W - 46, y: H - 30, width: 36, height: 26 }
  const state = { source: '原文', context: '', stopBox: stop }
  const x = stop.x + 10
  const y = H - 4
  assert.equal(panelEdgeZone(x, y, W, H), 'resize-bottom')
  assert.equal(panelHit(x, y, state, W), 'stop')
  assert.equal(panelHitZone(x, y, state, W, H), 'client')
  // 同一条边上、按钮左边一点仍然是缩放手柄
  assert.equal(panelHitZone(x - 60, y, state, W, H), 'resize-bottom')
})

test('手柄跟着窗口的实际尺寸走，不是设计尺寸', () => {
  const W2 = 700
  const H2 = 600
  // 400×480 的右边，在拖大之后的窗口里是正文
  assert.equal(panelEdgeZone(W - 2, H / 2, W, H), 'resize-right')
  assert.equal(panelEdgeZone(W - 2, H / 2, W2, H2), null)
  assert.equal(panelEdgeZone(W2 - 2, H2 / 2, W2, H2), 'resize-right')
  assert.equal(panelHitZone(W2 - 2, H2 - 2, IDLE, W2, H2), 'resize-bottomright')
})

test('角区比边宽：圆角处的透明像素也要抓得住', () => {
  // 分层窗口的透明像素不接收鼠标，窗口圆角（16 DIP）正好在角上——角区窄了角就废了
  assert.ok(PANEL_RESIZE.corner > PANEL_RESIZE.edge)
  assert.ok(PANEL_RESIZE.corner >= MODES.panel.radius)
})

test('边缘外一点点也算命中（原生缩放时坐标可能微负数）', () => {
  assert.equal(panelEdgeZone(-1, H / 2, W, H), 'resize-left')
  assert.equal(panelEdgeZone(W + 1, H / 2, W, H), 'resize-right')
  assert.equal(panelEdgeZone(W / 2, H + 1, W, H), 'resize-bottom')
})

/** 记录绘制指令：不用启动真实窗口，也能验证绘制坐标与命中坐标一致。 */
function recordingPainter() {
  const calls = []
  const painter = { calls }
  for (const method of ['fillRoundRect', 'strokeRoundRect', 'fillRect', 'fillCircle', 'line', 'strokeEllipse', 'fillPolygon', 'text', 'setClip', 'resetClip']) {
    painter[method] = (...args) => {
      for (const value of args) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value), method + ' 坐标必须有限')
      }
      if (['fillRoundRect', 'strokeRoundRect', 'fillRect', 'strokeEllipse', 'setClip'].includes(method)) {
        assert.ok(args[2] >= 0 && args[3] >= 0, method + ' 不允许负宽高')
      }
      calls.push({ method, args })
    }
  }
  painter.paragraph = (text, x, y, width, options = {}) => {
    calls.push({ method: 'paragraph', args: [text, x, y, width, options] })
    const lineHeight = options.lineHeight ?? options.size * 1.55
    const charsPerLine = Math.max(1, Math.floor(width / (options.size * 0.6)))
    const lines = String(text).split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
    return Math.min(lines * lineHeight, options.maxHeight ?? Infinity)
  }
  return painter
}

function panelState(overrides = {}) {
  return {
    ...IDLE, dark: false, action: 'explain', answer: '这是一段测试回答。', status: 'done', error: '',
    scroll: 0, contentHeight: 0, viewHeight: 0, hoverButton: null, copyFeedback: '', speaking: false,
    ...overrides,
  }
}

test('横向胶囊菜单四段都能命中，留白与条外不可误触', () => {
  // 32 = 上下各 4px 留白 + 28px 段高；328 = 左右各 4px 留白 + 4 段 × 80px。
  assert.deepEqual(MODES.menu, { width: 328, height: 36, radius: 10 })
  for (const y of [4, 17.99, 31.99]) {
    assert.equal(menuRowAt(4, y), 0)
    assert.equal(menuRowAt(84, y), 1)
    assert.equal(menuRowAt(164, y), 2)
    assert.equal(menuRowAt(244, y), 3)
  }
  // 段边界：左闭右开，落到下一段。
  assert.equal(menuRowAt(83.99, 18), 0)
  assert.equal(menuRowAt(84, 18), 1)
  assert.equal(menuRowAt(163.99, 18), 1)
  assert.equal(menuRowAt(164, 18), 2)
  assert.equal(menuRowAt(243.99, 18), 2)
  assert.equal(menuRowAt(244, 18), 3)
  // 条外 / 留白 / 第五段范围都是 -1。
  for (const [x, y] of [[3, 18], [324, 18], [324.5, 18], [84, 3], [84, 33], [84, 40]]) assert.equal(menuRowAt(x, y), -1)
})

test('菜单高亮绘制区域与命中区域在不同 DPI 下保持一致', () => {
  for (const dark of [false, true]) {
    for (const scale of [1, 1.25, 1.5, 2]) {
      for (const hover of [0, 1, 2, 3]) {
        const painter = recordingPainter()
        paintMenu(painter, MODES.menu.width * scale, MODES.menu.height * scale, { dark, hover }, scale)
        const highlight = painter.calls.find(({ method, args }) => method === 'fillRoundRect' && args[3] === 28 * scale)
        assert.ok(highlight)
        const [x, y, w, h] = highlight.args
        assert.equal(menuRowAt((x + w / 2) / scale, (y + h / 2) / scale), hover)
        const labels = painter.calls.filter(({ method }) => method === 'text').map(({ args }) => args[0])
        assert.deepEqual(labels, ['解释', '总结', '翻译', '朗读'])
      }
    }
  }
})

test('原文、回答与状态条在最小窗口及放大后仍互不覆盖', () => {
  for (const [width, height] of [[260, 200], [400, 480], [700, 600]]) {
    for (const source of ['', '短原文', '较长的原文内容。'.repeat(160)]) {
      for (const context of ['', '上下文内容']) {
        const layout = panelLayout({ source, context }, width, height)
        assert.equal(layout.contentWidth, width - PANEL.padding * 2)
        assert.ok(layout.sourceHeight <= PANEL.sourceMaxHeight)
        assert.ok(layout.answerLabelTop >= layout.bodyTop + layout.sourceHeight)
        assert.ok(layout.answerTop > layout.answerLabelTop)
        assert.ok(layout.answerHeight >= 28, '最小窗口也给正文留出可读的一行')
        assert.equal(layout.answerTop + layout.answerHeight, height - PANEL.footerHeight)
      }
    }
  }
})

test('标题栏三按钮随宽度移动且不会落入拖动区域', () => {
  for (const width of [260, 400, 700]) {
    const buttons = panelButtons(IDLE, width)
    assert.deepEqual(buttons.map(({ id }) => id), ['close', 'copy', 'speak'])
    for (const button of buttons) {
      const x = button.x + button.size / 2
      const y = button.y + button.size / 2
      assert.equal(panelHit(x, y, IDLE, width), button.id)
      assert.equal(panelHitZone(x, y, IDLE, width, H), 'client')
      assert.ok(button.y >= PANEL_RESIZE.edge)
      assert.ok(button.y + button.size <= PANEL.headerHeight)
    }
    assert.equal(panelHitZone(80, 24, IDLE, width, H), 'caption')
  }
})

test('深浅面板多 DPI 绘制保持裁剪、停止命中和复制反馈互不重叠', () => {
  for (const dark of [false, true]) {
    for (const scale of [1, 1.25, 1.5, 2]) {
      for (const [width, height] of [[260, 200], [400, 480], [700, 600]]) {
        const painter = recordingPainter()
        const state = panelState({ dark, source: '测试原文内容。'.repeat(40), context: '上下文', status: 'running', copyFeedback: '已复制' })
        paintPanel(painter, width * scale, height * scale, state, scale)
        assert.ok(state.stopBox)
        const stop = state.stopBox
        assert.equal(panelHit(stop.x + stop.width / 2, stop.y + stop.height / 2, state, width), 'stop')
        assert.equal(panelHitZone(stop.x + 1, stop.y + 1, state, width, height), 'client')
        const clips = painter.calls.filter(({ method }) => method === 'setClip')
        assert.equal(clips.length, 2)
        const answerClip = clips.at(-1).args
        assert.ok(Math.abs(answerClip[3] / scale - state.viewHeight) < 0.001)
        assert.ok(answerClip[1] + answerClip[3] < (height - PANEL.footerHeight) * scale)
        const feedback = painter.calls.find(({ method, args }) => method === 'text' && args[0] === '已复制').args
        const status = painter.calls.find(({ method, args }) => method === 'text' && args[0] === '正在生成…').args
        assert.ok(feedback[1] + feedback[3] <= stop.x * scale)
        assert.ok(status[1] + status[3] <= feedback[1])
        assert.equal(painter.calls.at(-1).method, 'strokeRoundRect')
      }
    }
  }
})

test('完成、读取、错误与空回答都能绘制，停止热区随生成状态清除', () => {
  for (const status of ['done', 'reading', 'error', 'idle']) {
    const painter = recordingPainter()
    const state = panelState({ status, source: '原文', answer: '', error: '测试错误', stopBox: { x: 0, y: 0, width: 100, height: 100 } })
    paintPanel(painter, W, H, state, 1)
    assert.equal(state.stopBox, null)
    assert.ok(state.contentHeight > 0)
    assert.ok(state.viewHeight > 0)
  }
})

test('长回答滚动到底部仍使用实际可视高度，不被状态栏内边距截断', () => {
  const state = panelState({ answer: Array.from({ length: 80 }, (_, i) => '第 ' + i + ' 行回答').join('\n'), scroll: 100000 })
  paintPanel(recordingPainter(), W, H, state, 1)
  assert.equal(state.scroll, state.contentHeight - state.viewHeight)
  const painter = recordingPainter()
  paintPanel(painter, W, H, state, 1)
  const lastParagraph = painter.calls.filter(({ method, args }) => method === 'paragraph' && args[4].dryRun !== true).at(-1)
  // 最后一段的底边必须落在页脚上沿之内：用该段自己的行高算，别钉死旧字号。
  const lineHeight = lastParagraph.args[4].lineHeight
  assert.ok(lastParagraph.args[2] + lineHeight <= H - PANEL.footerHeight)
})

/** 辅助字号较小，深浅主题的文字和蓝色强调都需要足够对比度。 */
function luminance(hex) {
  const values = hex.slice(1).match(/../g).map((v) => Number.parseInt(v, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}

test('两种主题的正文、辅助文案及蓝色强调保持可读对比度', () => {
  for (const theme of Object.values(THEMES)) {
    for (const background of [theme.menu, theme.layer1]) {
      for (const foreground of [theme.labelPrimary, theme.labelSecondary, theme.labelTertiary, theme.accent]) {
        const a = luminance(background)
        const b = luminance(foreground)
        assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 3.5, foreground + ' / ' + background)
      }
    }
  }
})
