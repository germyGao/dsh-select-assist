/**
 * 浮层 UI：划词菜单与回答窗口（面板）两种形态的布局、绘制与命中测试。
 *
 * 全部用 GDI+ 画（圆角卡片、字体、换行文本），使用克制的蓝色强调与分层中性色，
 * 深色/浅色跟随系统；不依赖任何浏览器、不额外起进程。
 *
 * 尺寸：设计尺寸是 DIP（=CSS px），绘制时统一乘显示器缩放。
 */
import { rgb } from './gdi.mjs'

/** 深浅主题共用同一层级：正文底色、引用底色、蓝色强调与辅助文本。 */
export const THEMES = {
  dark: { menu: '#1c2433', layer1: '#273142', labelPrimary: '#eef3fb', labelSecondary: '#b9c6d9', labelTertiary: '#8fa1b8', hoverAlpha: 0x20, borderAlpha: 0x20, accent: '#7da6ff', danger: '#ff8f9c', success: '#7adbb5' },
  light: { menu: '#ffffff', layer1: '#f4f7fc', labelPrimary: '#1a1e2e', labelSecondary: '#3d4656', labelTertiary: '#5a6478', hoverAlpha: 0x10, borderAlpha: 0x1e, accent: '#2f63e0', danger: '#c03d50', success: '#1f7e60' },
}

/** 设计尺寸（DIP）。回答窗口只有"面板"一种形态（悬浮球已移除）。 */
export const MODES = {
  menu: { width: 328, height: 36, radius: 10 },
  panel: { width: 380, height: 460, radius: 16 },
}

/** 取调色板（按明暗主题）。 */
export function palette(dark) {
  const t = dark ? THEMES.dark : THEMES.light
  return {
    ...t,
    menuColor: rgb(t.menu),
    layer1Color: rgb(t.layer1),
    labelPrimaryColor: rgb(t.labelPrimary),
    labelSecondaryColor: rgb(t.labelSecondary),
    labelTertiaryColor: rgb(t.labelTertiary),
    hoverColor: rgb(t.accent, t.hoverAlpha),
    borderColor: rgb(dark ? '#a8bddb' : '#7186a5', t.borderAlpha),
    dividerColor: rgb(dark ? '#a8bddb' : '#7186a5', dark ? 0x18 : 0x14),
    accentSoftColor: rgb(dark ? '#2b3d60' : '#eef3ff'),
    footerColor: rgb(dark ? '#19202d' : '#f9fbff'),
    accentColor: rgb(t.accent),
    dangerColor: rgb(t.danger),
    successColor: rgb(t.success),
    // 不可用状态（例如还没有回答时的"复制"）
    disabledColor: rgb(dark ? '#53627a' : '#b1bed0'),
  }
}

/** 面板布局常量（DIP）。 */
export const PANEL = { padding: 16, headerHeight: 48, buttonSize: 28, sourcePadding: 12, sourceMaxHeight: 96, footerHeight: 36, scrollbarWidth: 3 }
/** 菜单绘制与命中共享段尺寸，避免点按错位。 */
const MENU = { padding: 4, segmentWidth: 80, segmentHeight: 28 }
/** 正文区底部与状态条之间留出的空隙（DIP）。 */
const BOTTOM_INSET = 6

/**
 * 缩放手柄的宽度（DIP）：四条边一样窄，四个角都更大。
 *
 * 角必须比边宽：窗口圆角（`MODES.panel.radius` = 16 DIP）让最角落的几个像素画出来是
 * 全透明的，而分层窗口（UpdateLayeredWindow）的透明像素**不接收鼠标**——角区窄了就等于
 * 抓不住（尤其是左上/右上这种"角上就是圆角"的地方）。
 */
export const PANEL_RESIZE = { edge: 6, corner: 16 }

/**
 * 面板各区域（DIP）。
 *
 * 宽高必须传**窗口的实际尺寸**：窗口可以被用户拖着改大小，布局不能钉死在设计尺寸上
 * （踩过：拖动改大小后正文/页脚还按 400×480 排版，窗口下方留一大片空白）。
 * @param width - 实际宽度（DIP），省略时用设计尺寸。
 * @param height - 实际高度（DIP），省略时用设计尺寸。
 */
export function panelLayout(state, width = MODES.panel.width, height = MODES.panel.height) {
  const bodyTop = PANEL.headerHeight + 8
  const bodyHeight = height - bodyTop - PANEL.footerHeight
  const contentWidth = width - PANEL.padding * 2
  // 引用高度随实际宽度估算；小窗口优先给回答留出一行，不让引用挤进状态栏。
  const source = typeof state.source === 'string' ? state.source : ''
  const charsPerLine = Math.max(12, Math.floor((contentWidth - PANEL.sourcePadding * 2) / 12))
  const sourceLines = source.split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
  const sourceHeight = source === '' ? 0 : Math.min(PANEL.sourceMaxHeight, 32 + sourceLines * 16, Math.max(0, bodyHeight - 56))
  // 上下文提示和回答标签同处一行，不额外侵占正文高度。
  const contextLine = state.context === undefined || state.context === '' ? 0 : 16
  const answerLabelTop = bodyTop + sourceHeight + (sourceHeight > 0 ? 8 : 0)
  const answerTop = answerLabelTop + 18
  return {
    width,
    height,
    bodyTop,
    bodyHeight,
    sourceHeight,
    contextLine,
    answerLabelTop,
    answerTop,
    answerHeight: Math.max(0, height - PANEL.footerHeight - answerTop),
    contentWidth,
  }
}

/** 标题栏按钮（DIP）：朗读、复制与关闭，从**实际宽度**的右边往左排。 */
export function panelButtons(state, width = MODES.panel.width) {
  // 从右往左排：关闭永远在最右（与 DSH 和其他窗口的习惯一致），往左依次是复制、朗读
  const ids = ['close', 'copy', 'speak']
  const boxes = []
  let right = width - 6
  for (const id of ids) {
    right -= PANEL.buttonSize
    boxes.push({ id, x: right, y: (PANEL.headerHeight - PANEL.buttonSize) / 2, size: PANEL.buttonSize })
    right -= 2
  }
  return boxes
}

/** 菜单段命中（DIP）→ 0/1/2/3/-1（0=解释，1=总结，2=翻译，3=朗读）。 */
export function menuRowAt(x, y) {
  if (y < MENU.padding || y > MODES.menu.height - MENU.padding) return -1
  const seg = Math.floor((x - MENU.padding) / MENU.segmentWidth)
  return seg === 0 || seg === 1 || seg === 2 || seg === 3 ? seg : -1
}

/** 动作 → 面板标题栏图标。与菜单行图标保持一致。 */
function actionIcon(action) {
  if (action === 'summarize') return 'list'
  if (action === 'translate') return 'globe'
  return 'sparkle'
}

/** 动作 → 面板标题栏文字。 */
function actionTitle(action) {
  if (action === 'summarize') return '总结'
  if (action === 'translate') return '翻译'
  return '解释'
}

/** 动作 → 正文区上方的标签（译文 / 总结 / 回答）。 */
function actionBodyLabel(action) {
  if (action === 'summarize') return '总结'
  if (action === 'translate') return '译文'
  return '回答'
}

function insideBox(x, y, box) {
  return box !== undefined && box !== null && x >= box.x && x <= box.x + box.size && y >= box.y && y <= box.y + box.size
}

/** 面板命中：按钮 id / 'stop' / 'body' / null。 */
export function panelHit(x, y, state, width = MODES.panel.width) {
  for (const button of panelButtons(state, width)) {
    if (insideBox(x, y, button)) return button.id
  }
  if (state.stopBox !== null && state.stopBox !== undefined) {
    const box = state.stopBox
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return 'stop'
  }
  return 'body'
}

/**
 * 回答窗口的缩放命中区（DIP）：**四边 + 四角，八个方向都算**。
 *
 * 坐标传窗口的**实际**宽高（用户可以把窗口拖大拖小），钉死在设计尺寸上手柄就会跑偏。
 * 落在边缘外一点点（原生缩放时坐标可能微负数）也算：比较本身就是"越界即命中"。
 *
 * @param width - 实际宽度（DIP）。
 * @param height - 实际高度（DIP）。
 * @returns `resize-<方向>`（left/right/top/bottom + 四个对角）；不在边缘上返回 null。
 */
export function panelEdgeZone(x, y, width = MODES.panel.width, height = MODES.panel.height) {
  const nearLeft = x < PANEL_RESIZE.corner
  const nearRight = x > width - PANEL_RESIZE.corner
  const nearTop = y < PANEL_RESIZE.corner
  const nearBottom = y > height - PANEL_RESIZE.corner
  // 角优先：只有角区够宽，圆角那一圈才点得到（边只有 6 DIP）
  if (nearLeft && nearTop) return 'resize-topleft'
  if (nearRight && nearTop) return 'resize-topright'
  if (nearLeft && nearBottom) return 'resize-bottomleft'
  if (nearRight && nearBottom) return 'resize-bottomright'
  if (x < PANEL_RESIZE.edge) return 'resize-left'
  if (x > width - PANEL_RESIZE.edge) return 'resize-right'
  // 上边只有最外面这 6 DIP 是缩放手柄：再往下就是标题栏，交给拖动（HTCAPTION）
  if (y < PANEL_RESIZE.edge) return 'resize-top'
  if (y > height - PANEL_RESIZE.edge) return 'resize-bottom'
  return null
}

/**
 * 回答窗口的完整命中区（DIP → 语义），原生窗口的 WM_NCHITTEST 直接吃这个结果。
 *
 * 优先级：**标题栏按钮 / 页脚「停止」 > 八向缩放手柄 > 标题栏（拖动） > 客户区**。
 * 按钮必须先判：缩放手柄就压在它们旁边（上右角贴着关闭按钮、底边贴着「停止」），
 * 反过来会把这两个按钮的边角抢走（踩过的方向：菜单项被 HTCAPTION 吃掉点不动）。
 */
export function panelHitZone(x, y, state, width = MODES.panel.width, height = MODES.panel.height) {
  if (panelHit(x, y, state, width) !== 'body') return 'client'
  const edge = panelEdgeZone(x, y, width, height)
  if (edge !== null) return edge
  return y < PANEL.headerHeight ? 'caption' : 'client'
}

// ---------------------------------------------------------------- 绘制

/** 画划词菜单（横向胶囊条）。 */
export function paintMenu(painter, width, height, state, scale) {
  const p = palette(state.dark)
  const s = scale
  painter.fillRoundRect(0, 0, width, height, MODES.menu.radius * s, p.menuColor)
  painter.strokeRoundRect(0.5 * s, 0.5 * s, width - s, height - s, MODES.menu.radius * s, p.borderColor, Math.max(1, s))
  // 4 段并列：段与段之间画一条 1px 分隔线，让胶囊条不会糊成一坨。
  for (let k = 1; k < 4; k++) {
    const sepX = (MENU.padding + k * MENU.segmentWidth) * s
    painter.line(sepX, 8 * s, sepX, height - 8 * s, p.dividerColor, 1)
  }
  const segs = [
    { label: '解释', icon: 'sparkle' },
    { label: '总结', icon: 'list' },
    { label: '翻译', icon: 'globe' },
    { label: '朗读', icon: 'speak' },
  ]
  for (let i = 0; i < segs.length; i++) {
    const left = (MENU.padding + i * MENU.segmentWidth) * s
    const active = state.hover === i
    if (active) {
      // 整段胶囊底色 + 文字加粗变色：轻量但一眼能认出当前项。
      painter.fillRoundRect(left, MENU.padding * s, MENU.segmentWidth * s, MENU.segmentHeight * s, 8 * s, p.hoverColor)
    }
    // 图标 + 两字标签，水平居中，垂直居中于段高。
    const labelW = 34 * s
    const iconW = 14 * s
    const gap = 4 * s
    const totalW = iconW + gap + labelW
    const cx = left + (MENU.segmentWidth * s - totalW) / 2
    const iconY = MENU.padding * s + (MENU.segmentHeight - 14) / 2 * s
    const textY = MENU.padding * s + (MENU.segmentHeight - 18) / 2 * s
    drawIcon(painter, segs[i].icon, cx, iconY, iconW, active ? p.accentColor : p.labelPrimaryColor, s)
    painter.text(segs[i].label, cx + iconW + gap, textY, labelW, 20 * s, { size: 13 * s, color: active ? p.accentColor : p.labelPrimaryColor })
  }
}

/** 画悬浮窗。 */
export function paintPanel(painter, width, height, state, scale) {
  const p = palette(state.dark)
  const s = scale
  // 窗口可以被用户拖动改大小：布局一律按**实际**宽高（DIP）算，不能钉死设计尺寸。
  const dipWidth = Math.max(200, width / s)
  const dipHeight = Math.max(160, height / s)
  const layout = panelLayout(state, dipWidth, dipHeight)
  painter.fillRoundRect(0, 0, width, height, MODES.panel.radius * s, p.menuColor)

  // 蓝色图标底座。
  painter.fillRoundRect(PANEL.padding * s, 11 * s, 26 * s, 26 * s, 8 * s, p.accentSoftColor)
  drawIcon(painter, actionIcon(state.action), (PANEL.padding + 5) * s, 16 * s, 16 * s, p.accentColor, s)
  painter.text(actionTitle(state.action), (PANEL.padding + 36) * s, 13 * s, 60 * s, 23 * s, { size: 14 * s, bold: true, color: p.labelPrimaryColor })
  // "DSH" 水印移除：标题栏保持干净，品牌感由整体配色和圆角传达。
  const hasAnswer = typeof state.answer === 'string' && state.answer !== ''
  const hasSource = typeof state.source === 'string' && state.source !== ''
  for (const button of panelButtons(state, dipWidth)) {
    // 没有内容可复制 / 没有原文可读时对应按钮画成灰的，让“点了没反应”变成“看得出点不了”。
    const disabled = (button.id === 'copy' && !hasAnswer) || (button.id === 'speak' && !hasSource)
    const speaking = button.id === 'speak' && state.speaking === true
    const active = (state.hoverButton === button.id || speaking) && !disabled
    const centerX = (button.x + button.size / 2) * s
    const centerY = (button.y + button.size / 2) * s
    if (active) painter.fillRoundRect(button.x * s, button.y * s, button.size * s, button.size * s, 9 * s, p.hoverColor)
    const color = disabled ? p.disabledColor : active ? p.accentColor : p.labelTertiaryColor
    drawIcon(painter, button.id, centerX - 8 * s, centerY - 8 * s, 16 * s, color, s)
  }
  painter.line(PANEL.padding * s, PANEL.headerHeight * s, (dipWidth - PANEL.padding) * s, PANEL.headerHeight * s, p.dividerColor, s)

  if (layout.sourceHeight > 0) {
    const sourceX = PANEL.padding * s
    const sourceY = layout.bodyTop * s
    // 原文区：去掉蓝色背景，只保留左侧竖条作为视觉锚点。
    painter.fillRoundRect(sourceX, sourceY + 12 * s, 3 * s, Math.max(0, layout.sourceHeight - 24) * s, 1.5 * s, p.accentColor)
    painter.text('原文', (PANEL.padding + PANEL.sourcePadding) * s, sourceY + 4 * s, (layout.contentWidth - PANEL.sourcePadding * 2) * s, 14 * s, { size: 9.5 * s, bold: true, color: p.labelTertiaryColor })
    // 原文独立裁剪，极窄窗口或连续长词也不能侵入回答区。
    painter.setClip((PANEL.padding + PANEL.sourcePadding) * s, sourceY + 19 * s, (layout.contentWidth - PANEL.sourcePadding * 2) * s, Math.max(0, layout.sourceHeight - 25) * s)
    painter.paragraph(state.source, (PANEL.padding + PANEL.sourcePadding) * s, sourceY + 19 * s, (layout.contentWidth - PANEL.sourcePadding * 2) * s, {
      size: 11.5 * s,
      lineHeight: 16 * s,
      color: p.labelSecondaryColor,
      maxHeight: Math.max(0, layout.sourceHeight - 25) * s,
    })
    painter.resetClip()
  }

  painter.text(actionBodyLabel(state.action), PANEL.padding * s, layout.answerLabelTop * s, 48 * s, 16 * s, { size: 10.5 * s, bold: true, color: p.labelTertiaryColor })
  if (layout.contextLine > 0) {
    painter.text('已结合上下文', (dipWidth - PANEL.padding - 90) * s, layout.answerLabelTop * s, 90 * s, 16 * s, { size: 9.5 * s, color: p.labelTertiaryColor })
  }

  const clipTop = layout.answerTop * s
  // 底部留一点内边距：滚动内容被裁时不会紧贴状态条的分隔线。
  const clipBottom = (layout.bodyTop + layout.bodyHeight - BOTTOM_INSET) * s
  state.viewHeight = Math.max(0, layout.answerHeight - BOTTOM_INSET)
  // 滚动条单独占据右侧留白，长正文不会与滑块叠在一起。
  painter.setClip(PANEL.padding * s, clipTop, (layout.contentWidth - 8) * s, Math.max(0, clipBottom - clipTop))
  const contentHeight = drawAnswer(painter, state, PANEL.padding * s, clipTop - state.scroll * s, (layout.contentWidth - 8) * s, s, p, clipTop, clipBottom)
  painter.resetClip()
  state.contentHeight = contentHeight / s

  const maxScroll = Math.max(0, state.contentHeight - state.viewHeight)
  if (state.scroll > maxScroll) state.scroll = maxScroll
  if (maxScroll > 0 && state.viewHeight > 0) {
    const visible = Math.min(state.viewHeight, Math.max(24, (state.viewHeight / state.contentHeight) * state.viewHeight))
    const offset = (state.scroll / maxScroll) * (state.viewHeight - visible)
    painter.fillRoundRect((dipWidth - PANEL.padding + 2) * s, (layout.answerTop + offset) * s, PANEL.scrollbarWidth * s, visible * s, (PANEL.scrollbarWidth / 2) * s, p.borderColor)
  }

  const footerTop = dipHeight - PANEL.footerHeight
  // 分层状态栏保留底部圆角；不能用铺满整宽的矩形把窗口圆角填成直角。
  painter.fillRoundRect(0, footerTop * s, width, PANEL.footerHeight * s, MODES.panel.radius * s, p.footerColor)
  painter.fillRect(0, footerTop * s, width, MODES.panel.radius * s, p.footerColor)
  painter.line(PANEL.padding * s, footerTop * s, (dipWidth - PANEL.padding) * s, footerTop * s, p.dividerColor, s)
  const statusText =
    state.status === 'running'
      ? '正在生成…'
      : state.status === 'reading'
        ? '正在读取选区…'
        : state.status === 'done'
          ? '已完成'
          : state.status === 'error'
            ? state.error ? '生成失败 · ' + state.error : '生成失败'
            : '就绪'
  const statusColor =
    state.status === 'running' || state.status === 'reading'
      ? p.accentColor
      : state.status === 'done'
        ? p.successColor
        : state.status === 'error'
          ? p.dangerColor
          : p.labelTertiaryColor
  // 从右向左分配停止与复制回执，避免生成中复制时两段文字互相覆盖。
  let statusRight = dipWidth - PANEL.padding
  if (state.status === 'running') {
    state.stopBox = { x: statusRight - 54, y: footerTop + 6, width: 54, height: 28 }
    const box = state.stopBox
    painter.fillRoundRect(box.x * s, box.y * s, box.width * s, box.height * s, 8 * s, state.hoverButton === 'stop' ? p.hoverColor : p.accentSoftColor)
    drawIcon(painter, 'stop', (box.x + 8) * s, (box.y + 8) * s, 12 * s, p.accentColor, s)
    painter.text('停止', (box.x + 24) * s, (box.y + 5) * s, 28 * s, 18 * s, { size: 11.5 * s, color: p.accentColor })
    statusRight = box.x - 8
  } else {
    state.stopBox = null
  }
  if (typeof state.copyFeedback === 'string' && state.copyFeedback !== '') {
    const feedbackWidth = 70
    painter.text(state.copyFeedback, (statusRight - feedbackWidth) * s, (footerTop + 10) * s, feedbackWidth * s, 18 * s, {
      size: 11.5 * s,
      color: state.copyFeedback === '已复制' || state.copyFeedback === 'Copied' ? p.successColor : p.dangerColor,
    })
    statusRight -= feedbackWidth + 8
  }
  painter.fillCircle(PANEL.padding * s, (footerTop + 17) * s, 5.5 * s, statusColor)
  painter.text(statusText, (PANEL.padding + 13) * s, (footerTop + 10) * s, Math.max(0, statusRight - PANEL.padding - 13) * s, 18 * s, { size: 12 * s, color: state.status === 'error' ? p.dangerColor : p.labelTertiaryColor })
  // 描边最后绘制，让分层背景与四边缩放区始终保持整洁完整。
  painter.strokeRoundRect(0.5 * s, 0.5 * s, width - s, height - s, MODES.panel.radius * s, p.borderColor, Math.max(1, s))
}

/** 画答案（markdown-lite），返回内容高度（物理像素）。 */
function drawAnswer(painter, state, x, y, width, s, p, clipTop, clipBottom) {
  if (state.answer === '') {
    if (state.status === 'running' || state.status === 'reading') {
      painter.fillCircle(x + 2 * s, y + 6 * s, 3.5 * s, p.accentColor)
      painter.text(state.status === 'reading' ? '正在获取所选文本…' : '正在整理回答…', x + 12 * s, y + 1 * s, width - 12 * s, 18 * s, { size: 11.5 * s, color: p.labelTertiaryColor })
      return 20 * s
    }
    painter.text('暂无文本输出', x, y, width, 18 * s, { size: 13 * s, color: p.labelTertiaryColor })
    return 26 * s
  }
  const blocks = parseBlocks(state.answer)
  let cursor = y
  const bodySize = 12.5 * s
  const lineHeight = 17 * s
  for (const block of blocks) {
    const near = cursor > clipTop - 600 * s && cursor < clipBottom + 600 * s
    if (block.kind === 'heading') {
      const size = (block.level <= 1 ? 15 : 14) * s
      cursor += near
        ? painter.paragraph(block.text, x, cursor + 4 * s, width, { size, lineHeight: size * 1.45, bold: true, color: p.labelPrimaryColor })
        : measure(painter, block.text, width, size, size * 1.45, true)
      cursor += 4 * s
    } else if (block.kind === 'bullet' || block.kind === 'ordered') {
      const marker = block.kind === 'ordered' ? String(block.marker) + '.' : '•'
      painter.text(marker, x, cursor, 18 * s, lineHeight, { size: bodySize, color: p.labelSecondaryColor })
      cursor += near
        ? painter.paragraph(block.text, x + 14 * s, cursor, width - 14 * s, { size: bodySize, lineHeight, color: p.labelPrimaryColor })
        : measure(painter, block.text, width - 14 * s, bodySize, lineHeight, false)
      cursor += 2 * s
    } else if (block.kind === 'code') {
      const codeSize = 11.5 * s
      const codeLine = 17 * s
      const boxHeight = block.lines.length * codeLine + 12 * s
      if (near) {
        painter.fillRoundRect(x, cursor + 2 * s, width, boxHeight, 7 * s, p.layer1Color)
        for (let i = 0; i < block.lines.length; i++) {
          painter.text(block.lines[i], x + 9 * s, cursor + 8 * s + i * codeLine, width - 18 * s, codeLine, { size: codeSize, mono: true, color: p.labelPrimaryColor })
        }
      }
      cursor += boxHeight + 4 * s
    } else if (block.kind === 'quote') {
      const used = near
        ? painter.paragraph(block.text, x + 10 * s, cursor, width - 10 * s, { size: bodySize, lineHeight, color: p.labelSecondaryColor })
        : measure(painter, block.text, width - 10 * s, bodySize, lineHeight, false)
      if (near) painter.fillRect(x, cursor + 2 * s, 2 * s, Math.max(3, used - 3 * s), p.accentColor)
      cursor += used + 3 * s
    } else if (block.kind === 'table') {
      const rowLine = 18 * s
      for (const row of block.rows) {
        cursor += near
          ? painter.paragraph(row, x, cursor, width, { size: 12 * s, lineHeight: rowLine, color: p.labelSecondaryColor })
          : measure(painter, row, width, 12 * s, rowLine, false)
      }
      cursor += 3 * s
    } else if (block.kind === 'hr') {
      if (near) painter.line(x, cursor + 7 * s, x + width, cursor + 7 * s, p.dividerColor, 1)
      cursor += 16 * s
    } else {
      cursor += near
        ? painter.paragraph(block.text, x, cursor, width, { size: bodySize, lineHeight, color: p.labelPrimaryColor })
        : measure(painter, block.text, width, bodySize, lineHeight, false)
      cursor += 3 * s
    }
  }
  return cursor - (clipTop - state.scroll * s)
}

function measure(painter, text, width, size, lineHeight, bold) {
  return painter.paragraph(text, 0, 0, width, { size, lineHeight, bold, dryRun: true })
}

// ---------------------------------------------------------------- Markdown-lite 解析

/** 把答案切成块（标题 / 列表 / 代码 / 引用 / 表格 / 段落）。 */
export function parseBlocks(text) {
  const TICK = String.fromCharCode(96)
  const FENCE = TICK + TICK + TICK
  const lines = String(text).split(/\r?\n/)
  const blocks = []
  let code = null
  let table = null
  const flushTable = () => {
    if (table !== null && table.length > 0) blocks.push({ kind: 'table', rows: table })
    table = null
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '')
    if (code !== null) {
      if (line.trim().startsWith(FENCE)) {
        blocks.push({ kind: 'code', lines: code })
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    if (line.trim().startsWith(FENCE)) {
      flushTable()
      code = []
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
      if (table === null) table = []
      table.push(line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join('   '))
      continue
    }
    flushTable()
    // 分隔线（---、***、___）画成一条细分隔线，而不是把字符原样画出来。
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      blocks.push({ kind: 'bullet', text: bullet[1] })
      continue
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered !== null) {
      blocks.push({ kind: 'ordered', marker: ordered[1] + '.', text: ordered[2] })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      blocks.push({ kind: 'quote', text: quote[1] })
      continue
    }
    if (line.trim() === '') continue
    blocks.push({ kind: 'paragraph', text: line })
  }
  if (code !== null && code.length > 0) blocks.push({ kind: 'code', lines: code })
  flushTable()
  return blocks
}

// ---------------------------------------------------------------- 图标

/** 画一个 16×16 设计栅格的小图标。 */
export function drawIcon(painter, id, x, y, size, color, s = 1) {
  const u = size / 16
  const px = (v) => x + v * u
  const py = (v) => y + v * u
  const w = Math.max(1, 1.4 * u)
  // 所有图标共用线宽与折线路径，不混用实心喇叭或实心星形。
  const path = (points, closed = false) => {
    const vertices = closed ? [...points, points[0]] : points
    for (let i = 0; i + 1 < vertices.length; i++) {
      painter.line(px(vertices[i][0]), py(vertices[i][1]), px(vertices[i + 1][0]), py(vertices[i + 1][1]), color, w)
    }
  }
  switch (id) {
    case 'sparkle': {
      // 四角星使用描线，与翻译、复制、朗读保持一致。
      const star = (cx, cy, r) => {
        const inner = r * 0.28
        const points = []
        for (let i = 0; i < 8; i++) {
          const angle = (Math.PI / 4) * i - Math.PI / 2
          const radius = i % 2 === 0 ? r : inner
          points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
        }
        path(points, true)
      }
      star(6.3, 9.1, 4.5)
      star(12.1, 3.8, 2.2)
      return
    }
    case 'globe': {
      painter.strokeEllipse(px(1.5), py(1.5), 13 * u, 13 * u, color, w)
      painter.line(px(1.5), py(8), px(14.5), py(8), color, w)
      painter.strokeEllipse(px(5), py(1.5), 6 * u, 13 * u, color, w)
      return
    }
    case 'list': {
      // 三条横线 + 左侧圆点：与"总结"语义一致的清单图标。
      path([[6, 4], [14, 4]])
      path([[6, 8], [14, 8]])
      path([[6, 12], [11.5, 12]])
      painter.fillCircle(px(2.4), py(3.4), 1.8 * u, color)
      painter.fillCircle(px(2.4), py(7.4), 1.8 * u, color)
      painter.fillCircle(px(2.4), py(11.4), 1.8 * u, color)
      return
    }
    case 'copy': {
      path([[3.5, 11], [2, 11], [2, 2], [10, 2], [10, 3.5]])
      painter.strokeRoundRect(px(5), py(5), 9 * u, 9 * u, 1.8 * u, color, w)
      return
    }
    case 'speak': {
      // 喇叭 + 两道声波：朗读按钮
      path([[2, 6], [5, 6], [8, 3.5], [8, 12.5], [5, 10], [2, 10]], true)
      // 两道声波用短线段拼弧线（画成同心圆环会看不出是"声波"）
      const wave = (radius) => {
        const points = []
        for (let i = 0; i <= 4; i++) {
          const angle = -Math.PI / 3 + ((2 * Math.PI) / 3) * (i / 4)
          points.push([9 + Math.cos(angle) * radius * 0.55, 8 + Math.sin(angle) * radius])
        }
        for (let i = 0; i + 1 < points.length; i++) {
          painter.line(px(points[i][0]), py(points[i][1]), px(points[i + 1][0]), py(points[i + 1][1]), color, w)
        }
      }
      wave(3.1)
      wave(5.2)
      return
    }
    case 'chevron': {
      path([[6, 4.5], [9.5, 8], [6, 11.5]])
      return
    }
    case 'stop': {
      painter.strokeRoundRect(px(4), py(4), 8 * u, 8 * u, 1.5 * u, color, w)
      return
    }
    case 'min': {
      painter.line(px(4), py(8.5), px(12), py(8.5), color, w)
      return
    }
    case 'close': {
      painter.line(px(4.4), py(4.4), px(11.6), py(11.6), color, w)
      painter.line(px(11.6), py(4.4), px(4.4), py(11.6), color, w)
      return
    }
    default:
      return
  }
}
