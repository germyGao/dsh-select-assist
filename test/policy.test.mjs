/**
 * 划词策略单测：菜单该不该弹、这一次用哪段文字。
 *
 * 这两条判断是「菜单呼不出来」和「回答的不是我选的那段」两个老问题的分水岭，
 * 所以每条分支都钉住——反证过：把 \`menuDecision\` 里"空选区"那一档改成一律弹，
 * 「拖窗口也弹菜单」的用例立刻红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { menuDecision, pickSelection, unknownFallback } from '../companion/policy.mjs'
import { pointNearRects } from '../companion/native/uia.mjs'
import { createGestureDetector } from '../companion/gesture.mjs'

test('手势落在桌面/任务栏这类系统外壳上：外壳不含可选文本，不弹', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'shell' }), { open: false, reason: 'shell' })
  assert.deepEqual(menuDecision({ selection: '  ', source: 'shell' }), { open: false, reason: 'shell' })
})

test('读不到 UIA 文本时不表态（open=null）：UIA 说不出话，交给剪贴板核实', () => {
  // 办公套件（WPS 的 Qt 版最典型）整个窗口树里没有文档的 TextPattern——UIA 对"选没选中
  // 文字"完全无话可说。这时不能凭猜弹菜单，也不能凭猜不弹：返回 open=null 让调用方用
  // 剪贴板核实一次（真选中文字才会复制出文字）。
  assert.deepEqual(menuDecision(null), { open: null, reason: 'unknown' })
  assert.deepEqual(menuDecision(undefined), { open: null, reason: 'unknown' })
  assert.deepEqual(menuDecision(null, '', { kind: 'drag' }), { open: null, reason: 'unknown' })
  assert.deepEqual(menuDecision(null, '', { kind: 'double' }), { open: null, reason: 'unknown' })
  // 探针慢（两级预算都用完）也是"没结论"，同样交给核实；诊断理由要保留。
  assert.deepEqual(menuDecision(null, '', { kind: 'drag', reason: 'timeout' }), { open: null, reason: 'timeout' })
})

test('核实跑不起来时的兜底 = 改动前的老行为：拖选照弹、双击不弹', () => {
  // 只有"终端窗口（Ctrl+C 是中断）/ 用户此刻正按着 Ctrl+C / 显式关掉核实"才走这一档。
  assert.deepEqual(unknownFallback('drag'), { open: true, reason: 'unknown' })
  assert.deepEqual(unknownFallback(), { open: true, reason: 'unknown' })
  assert.deepEqual(unknownFallback('double'), { open: false, reason: 'double-unverified' })
})

test('双击真的选中了文字：必须碰到这次选区才弹', () => {
  assert.deepEqual(
    menuDecision({ selection: 'Go 调度器', source: 'point', atGesture: true }, '', { kind: 'double' }),
    { open: true, reason: 'selection' },
  )
  // 双击读到的可能是旧选区/附近文本，但这次手势没碰到它：不能沿用拖选的
  // “文字不同就认”兜底，否则双击空白处也会拿旧文本呼出菜单。
  assert.deepEqual(
    menuDecision({ selection: 'Go', source: 'focused', atGesture: false }, '别的文字', { kind: 'double' }),
    { open: false, reason: 'double-not-at-gesture' },
  )
  assert.deepEqual(
    menuDecision({ selection: 'Go', source: 'point', atGesture: null }, '', { kind: 'double' }),
    { open: false, reason: 'double-not-at-gesture' },
  )
})

test('双击未命中选区：不同文字、首次划词及焦点旧选区都不能绕过验证', () => {
  // 真实日志：双击读到 3/10/4/1 字，atGesture=false 却被判为 selection。
  for (const length of [3, 10, 4, 1]) {
    const selection = '字'.repeat(length)
    for (const source of ['point', 'focused']) {
      for (const previous of ['', '别处的文字', selection]) {
        for (const atGesture of [false, null, undefined]) {
          assert.deepEqual(menuDecision({ selection, source, atGesture }, previous, { kind: 'double' }),
            { open: false, reason: 'double-not-at-gesture' })
        }
      }
    }
  }
})

test('鼠标双击采样传入策略：读到其他位置文字时不会发出打开菜单指令', () => {
  for (const atGesture of [false, null, true]) {
    const decisions = []
    const detector = createGestureDetector({ onGesture: (gesture) => {
      decisions.push(menuDecision({ selection: '残留文字', source: 'point', atGesture }, '', { kind: gesture.kind }))
    } })
    for (const [down, time] of [[true, 0], [false, 150], [true, 230], [false, 380]]) {
      detector.push({ down, time, x: 1915, y: 1085 })
    }
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].open, atGesture === true)
  }
})

test('双击空选区交给剪贴板确认；非空同词再次命中仍能弹', () => {
  for (const selection of ['', '   ', '\n']) {
    assert.equal(menuDecision({ selection, atGesture: true }, '', { kind: 'double' }).open, null)
  }
  assert.equal(menuDecision({ selection: '同词', atGesture: true }, '同词', { kind: 'double' }).open, true)
})

test('这次手势碰到了这段选区（按下点/松开点在选区里）：弹——这次手势选的就是它', () => {
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'point', atGesture: true }), { open: true, reason: 'selection' })
  assert.deepEqual(menuDecision({ selection: '  hi ', source: 'focused', atGesture: true }), { open: true, reason: 'selection' })
})

test('按下时就是这段选区、松开时还是它：这次手势没改动选区，不弹（WPS/Office 里拖动已选中的元素）', () => {
  // 复现：PPT 里选中一个形状/文本框再拖它、Excel 里拖一个已选中的单元格，UIA 一路都报着
  // "这个对象被选中"——按下的地方在选区里（atGesture=true），只看松开那一刻就会弹菜单。
  const probe = { selection: '形状里的文字', source: 'point', atGesture: true }
  assert.deepEqual(
    menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: '形状里的文字' } }),
    { open: false, reason: 'unchanged-selection' },
  )
  // 空白差异不算改动（UIA 会把缩进折成空格）：折叠后相同就是同一段。
  assert.deepEqual(
    menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: '  形状里的文字 ' } }),
    { open: false, reason: 'unchanged-selection' },
  )
  // 双击一个已经选中的对象（形状/图标）同理：这一串点击没选出任何新东西。
  assert.deepEqual(
    menuDecision(probe, '', { kind: 'double', pressProbe: { selection: '形状里的文字' } }),
    { open: false, reason: 'unchanged-selection' },
  )
  // 没拍到快照（老数据/关掉了按下探针/拍得太慢）：少一条判据，照原样弹。
  assert.deepEqual(menuDecision(probe, '', { kind: 'drag' }), { open: true, reason: 'selection' })
  assert.deepEqual(menuDecision(probe, '', { kind: 'drag', pressProbe: null }), { open: true, reason: 'selection' })
  assert.deepEqual(menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: '   ' } }), { open: true, reason: 'selection' })
  // 拖形状时指针一直在元素里：读数到手时指针没离开按下点（driftPx 很小），快照可信，照样不弹。
  assert.deepEqual(
    menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: '形状里的文字', driftPx: 0 } }),
    { open: false, reason: 'unchanged-selection' },
  )
})

test('按下快照拍晚了（读数到手时指针已经拖出去）：不能拿它判「没改动选区」', () => {
  // 用户报的就是这条：浏览器里 UIA 首查要 100ms 以上，一次 80px 的拖选只要 150ms，读数回来
  // 时早就拖完了——"按下那一刻"读到的是这次手势自己选出来的文字，跟松开时一模一样。判成
  // unchanged-selection 的话，重复划同一段就再也弹不出来。
  const probe = { selection: '只看三件事…虚拟环境…cv2.imread', source: 'point', atGesture: true }
  for (const driftPx of [13, 40, 83, 500]) {
    assert.deepEqual(
      menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: probe.selection, driftPx } }),
      { open: true, reason: 'selection' },
    )
  }
  // 量不到（null / 非数字）：按老行为处理，快照仍算可信——不能凭空多出一条判据。
  for (const driftPx of [null, undefined, Number.NaN, 'x']) {
    assert.deepEqual(
      menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: probe.selection, driftPx } }),
      { open: false, reason: 'unchanged-selection' },
    )
  }
  // 阈值附近：≤12px 仍算"没离开按下点"（拖形状时指针会有一点点抖动）。
  assert.deepEqual(
    menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: probe.selection, driftPx: 12 } }),
    { open: false, reason: 'unchanged-selection' },
  )
})

test('同一段文字但选区矩形原地没动：重划同一段，应该弹（DSH/浏览器菜单超时后旧选区还在）', () => {
  const probe = {
    selection: '重划同一段',
    source: 'point',
    atGesture: true,
    rects: [{ left: 100, top: 200, right: 300, bottom: 220 }],
  }
  const pressProbe = {
    selection: '重划同一段',
    driftPx: 0,
    rects: [{ left: 100, top: 200, right: 300, bottom: 220 }],
  }
  // 矩形一致 → 不判 unchanged-selection；后续 atGesture=true → 弹。
  assert.deepEqual(
    menuDecision(probe, '', { kind: 'drag', pressProbe }),
    { open: true, reason: 'selection' },
  )
  // 矩形抖动在容差内（≤6px）也算没动。
  assert.deepEqual(
    menuDecision(
      { ...probe, rects: [{ left: 100, top: 206, right: 300, bottom: 220 }] },
      '',
      { kind: 'drag', pressProbe: { ...pressProbe, rects: [{ left: 100, top: 200, right: 300, bottom: 214 }] } },
    ),
    { open: true, reason: 'selection' },
  )
})

test('同一段文字但选区矩形明显挪动了：才认定是拖对象，不弹', () => {
  const probe = {
    selection: '形状里的文字',
    source: 'point',
    atGesture: true,
    rects: [{ left: 100, top: 200, right: 300, bottom: 220 }],
  }
  const pressProbe = {
    selection: '形状里的文字',
    driftPx: 0,
    rects: [{ left: 100, top: 200, right: 300, bottom: 220 }],
  }
  // 矩形向下挪了 50px：拖对象。
  assert.deepEqual(
    menuDecision(
      { ...probe, rects: [{ left: 100, top: 250, right: 300, bottom: 270 }] },
      '',
      { kind: 'drag', pressProbe },
    ),
    { open: false, reason: 'unchanged-selection' },
  )
  // 左右也同理。
  assert.deepEqual(
    menuDecision(
      { ...probe, rects: [{ left: 170, top: 200, right: 370, bottom: 220 }] },
      '',
      { kind: 'drag', pressProbe },
    ),
    { open: false, reason: 'unchanged-selection' },
  )
})

test('没拿到矩形信息时， unchanged-selection 按老行为走：同文字 + 快照可信 → 不弹', () => {
  const probe = { selection: '形状里的文字', source: 'point', atGesture: true }
  const pressProbe = { selection: '形状里的文字', driftPx: 0 }
  assert.deepEqual(
    menuDecision(probe, '', { kind: 'drag', pressProbe }),
    { open: false, reason: 'unchanged-selection' },
  )
})

test('按下时是别的文字（或没有选区）：这次手势确实改动了选区，照弹', () => {
  const probe = { selection: 'Go 调度器', source: 'point', atGesture: true }
  // 拖之前这里是空的（按下即把旧选区收成插入符）：这就是一次正常的拖选。
  assert.deepEqual(menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: '' } }), { open: true, reason: 'selection' })
  // 拖之前是别的一段：用户重新选了一段。
  assert.deepEqual(menuDecision(probe, '', { kind: 'drag', pressProbe: { selection: '别的文字' } }), { open: true, reason: 'selection' })
})

test('几何判定没命中，但文字跟上次菜单那段不一样：照弹（真划词不能被 DPI/字符吸附的噪声杀掉）', () => {
  // 实测踩过：150% 缩放下一个字 15–30px，从右往左拖时锚点吸附到字形边界，
  // 按下点会落在选区矩形外一点点——用户看到的就是"经常弹不出来"。
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'point', atGesture: false }, '别的文字'), { open: true, reason: 'selection' })
  assert.deepEqual(menuDecision({ selection: 'Go', source: 'focused', atGesture: null }, '别的文字'), { open: true, reason: 'selection' })
  // 第一次划词（还没有"上次菜单那段"）：也认。
  assert.deepEqual(menuDecision({ selection: 'Go', source: 'focused', atGesture: false }, ''), { open: true, reason: 'selection' })
})

test('同一段文字 + 手势没碰到它：这是上次留下的旧选区，菜单已经为它弹过，不再弹', () => {
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'focused', atGesture: false }, 'Go 调度器'), { open: false, reason: 'stale-selection' })
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'point', atGesture: false }, ' Go  调度器 '), { open: false, reason: 'stale-selection' })
})

test('普通 UIA 元素没有选区：交给剪贴板确认', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'point' }), { open: null, reason: 'unknown' })
  assert.deepEqual(menuDecision({ selection: '   ', source: 'point' }), { open: null, reason: 'unknown' })
})

test('焦点元素带 TextPattern 却报不出选区：交给剪贴板确认', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'focused' }), { open: null, reason: 'unknown' })
})

test('选区字段缺失/不是字符串时交给剪贴板确认，不抛错', () => {
  assert.deepEqual(menuDecision({ source: 'point' }), { open: null, reason: 'unknown' })
  assert.deepEqual(menuDecision({ selection: null, source: 'point' }), { open: null, reason: 'unknown' })
  assert.deepEqual(menuDecision({}), { open: null, reason: 'unknown' })
})

test('几何判定：点在选区矩形里就算碰到；不在里面要看余量', () => {
  const rects = [{ left: 100, top: 200, right: 400, bottom: 236 }]
  assert.equal(pointNearRects({ x: 250, y: 218 }, rects), true, '正中')
  assert.equal(pointNearRects({ x: 250, y: 250 }, rects), true, '下沿外 14px，仍在余量内')
  assert.equal(pointNearRects({ x: 250, y: 400 }, rects), false, '隔了 164px，不算碰到')
  assert.equal(pointNearRects({ x: 250, y: 218 }, []), false)
  assert.equal(pointNearRects({ x: 250, y: 218 }, null), false)
})

test('几何判定：余量按行高缩放（150% 下一个字 15–30px，写死 8px 会误杀正常划词）', () => {
  const tall = [{ left: 0, top: 0, right: 100, bottom: 60 }]
  const short = [{ left: 0, top: 0, right: 100, bottom: 12 }]
  assert.equal(pointNearRects({ x: -50, y: 30 }, tall), true, '60px 的行高给 60px 余量')
  assert.equal(pointNearRects({ x: -50, y: 6 }, short), false, '12px 的行高只给 12px 余量')
  assert.equal(pointNearRects({ x: -5, y: 6 }, short), true, '8px 兜底')
})

test('几何判定：矩形只有 left/top/right/bottom，没有 height 字段（踩过：读 height 得到 NaN，判定恒 false，菜单怎么划都不弹）', () => {
  const rect = { left: 100, top: 200, right: 400, bottom: 236 }
  assert.equal('height' in rect, false, 'UIA 矩形本来就没有 height')
  assert.equal(pointNearRects({ x: 250, y: 218 }, [rect]), true)
})

test('挑文字：按优先级取第一个非空来源（UIA 预读 → UIA 补读 → 剪贴板兜底）', () => {
  assert.deepEqual(
    pickSelection([
      { source: 'uia-prefetch', text: '' },
      { source: 'uia-fresh', text: '选中的文字' },
      { source: 'clipboard', text: '剪贴板里的' },
    ]),
    { text: '选中的文字', source: 'uia-fresh' },
  )
})

test('挑文字：正文原样返回，不做 trim（选区里的换行与缩进是用户的原文）', () => {
  assert.deepEqual(pickSelection([{ source: 'uia', text: '  a\n  b  ' }]), { text: '  a\n  b  ', source: 'uia' })
})

test('挑文字：一个可用来源都没有时返回 null（调用方据此显示「未能读取选中的文字」）', () => {
  assert.equal(pickSelection([]), null)
  assert.equal(pickSelection(undefined), null)
  assert.equal(pickSelection([{ source: 'uia', text: '   ' }, { source: 'clipboard', text: null }]), null)
})

test('挑文字：来源名缺失时兜成 unknown，不抛错', () => {
  assert.deepEqual(pickSelection([{ text: 'x' }]), { text: 'x', source: 'unknown' })
})
