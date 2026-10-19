/** 插件样式：局部令牌、轻量卡片与浮层，深浅色跟随宿主。 */
export const STYLE_TAG_ID = 'dsh-select-assist/client.css'

const CSS = `
/* 局部变量不污染宿主；所有表单控件显式继承字体与主题。 */
.dst-root, .dst-set-section {
  --dst-text: var(--dsw-alias-label-primary, #202735);
  --dst-muted: var(--dsw-alias-label-secondary, #677183);
  --dst-subtle: var(--dsw-alias-label-tertiary, #788395);
  --dst-surface: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff));
  --dst-soft: var(--dsw-alias-bg-layer-1, #f6f8fb);
  --dst-border: var(--dsw-alias-border-l1, #e5e9f0);
  --dst-accent: #6f5bd8;
  --dst-tint: color-mix(in srgb, var(--dst-accent) 9%, var(--dst-surface));
  --dst-hover: var(--dsw-alias-interactive-bg-hover, rgba(111, 91, 216, .07));
  --dst-hairline: color-mix(in srgb, var(--dst-text) 9%, transparent);
  color: var(--dst-text);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.dst-root *, .dst-set-section * { box-sizing: border-box; }
.dst-root button, .dst-set-section button { font: inherit; cursor: pointer; }
.dst-root svg, .dst-set-section svg { display: block; flex-shrink: 0; }
.dst-root button:focus-visible, .dst-set-section :is(button, select, input, textarea, summary):focus-visible {
  outline: 2px solid var(--dst-accent);
  outline-offset: 3px;
}
.dst-root button:disabled, .dst-set-section button:disabled { opacity: .4; cursor: default; }

/* 设置页：渐变抬头 + 三段编号设置区（刻意与旧版「图标卡片 + 流程条」拉开距离）。 */
.dst-set-section { container-type: inline-size; width: 100%; max-width: 860px; min-width: 0; margin: 0 auto; padding: 2px 0 28px; }
.dst-hero { position: relative; overflow: hidden; margin-bottom: 26px; padding: 22px 24px 18px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--dst-accent) 17%, var(--dst-border)); background: radial-gradient(120% 130% at 100% 0%, color-mix(in srgb, var(--dst-accent) 15%, transparent) 0%, transparent 58%), color-mix(in srgb, var(--dst-accent) 5%, var(--dst-surface)); }
.dst-hero-top { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.dst-set-heading { flex: 1; min-width: 180px; }
.dst-eyebrow { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 2px 9px 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--dst-accent) 13%, transparent); color: var(--dst-accent); font-size: 10px; font-weight: 650; letter-spacing: .5px; text-transform: uppercase; }
.dst-set-section .dst-set-title { margin: 0; font-size: 24px; line-height: 1.32; font-weight: 680; letter-spacing: -.6px; color: var(--dst-text); }
.dst-set-section .dst-set-hint { display: block; margin: 0; color: var(--dst-muted); font-size: 12px; line-height: 1.75; overflow-wrap: anywhere; }
.dst-set-section .dst-set-intro { margin-top: 6px; font-size: 13px; max-width: 48em; }
.dst-set-save { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 5px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dst-accent) 18%, transparent); background: color-mix(in srgb, var(--dst-surface) 70%, transparent); color: var(--dst-muted); font-size: 11px; white-space: nowrap; }
.dst-set-save[data-state="saving"] { color: var(--dst-accent); }
.dst-set-save[data-state="saved"] { color: #26845d; border-color: color-mix(in srgb, #26845d 26%, transparent); }
.dst-set-save[data-state="error"], .dst-set-error { color: #db5454; }
.dst-set-save[data-state="error"] { border-color: color-mix(in srgb, #db5454 30%, transparent); }
.dst-set-save[data-state="error"] svg { display: none; }
.dst-set-spinner { width: 11px; height: 11px; border: 1.5px solid var(--dst-border); border-top-color: var(--dst-accent); border-radius: 50%; animation: dst-spin .8s linear infinite; }
.dst-hero-steps { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 18px; padding-top: 14px; border-top: 1px dashed color-mix(in srgb, var(--dst-accent) 24%, transparent); }
.dst-hero-step { display: inline-flex; align-items: center; gap: 6px; padding: 3px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dst-accent) 13%, transparent); background: color-mix(in srgb, var(--dst-surface) 78%, transparent); color: var(--dst-muted); font-size: 11px; }
.dst-hero-step[data-active="true"] { color: var(--dst-accent); background: color-mix(in srgb, var(--dst-accent) 10%, var(--dst-surface)); border-color: color-mix(in srgb, var(--dst-accent) 32%, transparent); }
.dst-hero-arrow { color: var(--dst-subtle); }
.dst-set-block { padding-bottom: 24px; border-top: 1px solid var(--dst-hairline); }
.dst-set-block-head { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 13px; align-items: start; margin: 20px 0 16px; }
.dst-set-block-index { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--dst-tint); color: var(--dst-accent); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .3px; }
.dst-set-section .dst-set-block-title { margin: 1px 0 3px; font-size: 15px; line-height: 1.45; font-weight: 650; color: var(--dst-text); }
.dst-preview { margin-top: 26px; padding: 16px 18px; border: 1px dashed color-mix(in srgb, var(--dst-accent) 28%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--dst-accent) 4%, transparent); }
.dst-preview-title { display: block; margin-bottom: 12px; color: var(--dst-accent); font-size: 10px; font-weight: 650; letter-spacing: .6px; text-transform: uppercase; }
.dst-preview-quote { margin: 0 0 12px; padding-left: 12px; border-left: 2px solid color-mix(in srgb, var(--dst-accent) 38%, transparent); color: var(--dst-muted); font-size: 12px; line-height: 1.7; }
.dst-preview-answer { margin: 0; color: var(--dst-text); font-size: 13px; line-height: 1.8; }
.dst-preview-note { display: block; margin-top: 10px; color: var(--dst-subtle); font-size: 10px; }
.dst-set-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
.dst-set-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dst-set-label { display: block; font-size: 12px; font-weight: 550; color: var(--dst-text); }
.dst-set-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dst-set-sub { flex-shrink: 0; color: var(--dst-muted); font-size: 12px; }
.dst-set-input, .dst-set-textarea { width: 100%; min-width: 0; margin: 0; padding: 10px 12px; border: 1px solid var(--dst-border); border-radius: 9px; background: var(--dst-soft); color: var(--dst-text); font-family: inherit; font-size: 13px; line-height: 1.5; transition: border-color .15s, box-shadow .15s; }
.dst-set-input { min-height: 40px; }
select.dst-set-input { padding-right: 30px; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m5 6 3 3 3-3' fill='none' stroke='%23788395' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; cursor: pointer; text-overflow: ellipsis; }
.dst-set-input option { background: var(--dst-surface); color: var(--dst-text); }
.dst-set-input:hover, .dst-set-textarea:hover { border-color: color-mix(in srgb, var(--dst-accent) 30%, var(--dst-border)); }
.dst-set-input:focus, .dst-set-textarea:focus { border-color: var(--dst-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dst-accent) 10%, transparent); }
.dst-set-input::placeholder { color: var(--dst-subtle); }
.dst-set-rules { display: grid; gap: 10px; }
.dst-set-rule { border: 1px solid var(--dst-border); border-radius: 12px; background: color-mix(in srgb, var(--dst-soft) 55%, var(--dst-surface)); overflow: hidden; transition: border-color .15s, background .15s; }
.dst-set-rule[open] { border-color: color-mix(in srgb, var(--dst-accent) 30%, var(--dst-border)); background: var(--dst-surface); }
.dst-set-rule-summary { display: flex; align-items: center; gap: 10px; padding: 13px 15px; list-style: none; cursor: pointer; color: var(--dst-muted); transition: background .15s; }
.dst-set-rule-summary::-webkit-details-marker { display: none; }
.dst-set-rule-summary:hover { background: var(--dst-hover); }
.dst-set-rule-summary:focus-visible { outline-offset: -3px !important; }
.dst-set-rule-name { flex: 1; font-size: 13px; font-weight: 550; color: var(--dst-text); }
.dst-set-rule-badge { font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; background: color-mix(in srgb, var(--dst-text) 7%, transparent); color: var(--dst-muted); }
.dst-set-rule-badge[data-custom="true"] { background: color-mix(in srgb, var(--dst-accent) 12%, transparent); border-color: color-mix(in srgb, var(--dst-accent) 26%, transparent); color: var(--dst-accent); }
.dst-set-rule-chevron { transition: transform .16s; }
.dst-set-rule[open] .dst-set-rule-chevron { transform: rotate(180deg); }
.dst-set-rule-body { padding: 0 15px 15px; }
.dst-set-textarea { display: block; resize: vertical; min-height: 140px; line-height: 1.8; }
.dst-set-labelrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; flex-wrap: wrap; }
.dst-set-slider-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.dst-set-slider-value { flex-shrink: 0; padding: 1px 8px; border-radius: 6px; background: var(--dst-tint); color: var(--dst-accent); font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
.dst-set-range { width: 100%; height: 22px; margin: 0; appearance: none; background: transparent; cursor: pointer; }
.dst-set-range::-webkit-slider-runnable-track { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--dst-accent) 20%, var(--dst-border)); }
.dst-set-range::-webkit-slider-thumb { appearance: none; width: 15px; height: 15px; margin-top: -5.5px; border-radius: 50%; border: 2px solid var(--dst-surface); background: var(--dst-accent); box-shadow: 0 1px 4px #101b3233; }
.dst-set-range::-moz-range-track { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--dst-accent) 20%, var(--dst-border)); }
.dst-set-range::-moz-range-thumb { width: 15px; height: 15px; border: 2px solid var(--dst-surface); border-radius: 50%; background: var(--dst-accent); }
.dst-set-range:focus-visible { outline: 2px solid color-mix(in srgb, var(--dst-accent) 45%, transparent); outline-offset: 3px; }
.dst-set-range-ends { display: flex; justify-content: space-between; margin-top: -4px; color: var(--dst-subtle); font-size: 10px; }
.dst-set-section .dst-set-link { display: inline-flex; align-items: center; flex-shrink: 0; min-height: 28px; padding: 2px 6px; border: none; border-radius: 5px; background: transparent; color: var(--dst-accent); font-size: 12px; }
.dst-set-link:hover:not(:disabled) { background: var(--dst-tint); }
.dst-set-status, .dst-set-error-banner { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 10px; background: var(--dst-soft); font-size: 13px; overflow-wrap: anywhere; }
.dst-set-error-banner { color: #db5454; border: 1px solid color-mix(in srgb, #db5454 25%, transparent); }

/* 划词菜单：一次品牌标记，两个紧凑操作。 */
.dst-menu { position: fixed; z-index: 2400; display: flex; flex-direction: column; padding: 6px; background: var(--dst-surface); border: 1px solid var(--dst-border); border-radius: 14px; box-shadow: 0 12px 36px #101b3224, 0 2px 6px #101b320a; animation: dst-fade-in .14s ease-out; }
.dst-menu-caption { display: flex; align-items: center; justify-content: space-between; height: 26px; padding: 0 9px; color: var(--dst-subtle); font-size: 10px; letter-spacing: .2px; }
.dst-menu-caption span:last-child { font-size: 9px; border: 1px solid var(--dst-border); border-radius: 4px; padding: 0 4px; line-height: 15px; }
.dst-menu-item { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dst-text); text-align: left; }
.dst-menu-item:hover { background: var(--dst-tint); color: var(--dst-accent); }
.dst-menu-item-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 26px; height: 26px; border-radius: 7px; color: var(--dst-accent); background: var(--dst-tint); }
.dst-menu-item-label { flex: 1; min-width: 0; white-space: nowrap; font-size: 13px; font-weight: 500; }
.dst-menu-arrow { color: var(--dst-subtle); opacity: 0; transition: opacity .15s; }
.dst-menu-item:hover .dst-menu-arrow, .dst-menu-item:focus-visible .dst-menu-arrow { opacity: 1; }

/* 回答浮层：紧凑标题栏、引用原文、独立阅读区。 */
.dst-panel { position: fixed; z-index: 2390; display: flex; flex-direction: column; min-width: 280px; min-height: 180px; background: var(--dst-surface); border: 1px solid var(--dst-border); border-radius: 16px; box-shadow: 0 20px 60px #101b3229, 0 3px 12px #101b320d; animation: dst-fade-in .16s ease-out; }
.dst-panel-header { display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-height: 56px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--dst-border); cursor: grab; touch-action: none; user-select: none; }
.dst-panel-header:active { cursor: grabbing; }
.dst-panel-title { min-width: 0; font-size: 14px; font-weight: 600; }
.dst-panel-brand { margin-left: 4px; color: var(--dst-subtle); font-size: 10px; font-weight: 400; }
.dst-panel-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; }
.dst-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--dst-muted); }
.dst-icon-btn:hover:not(:disabled) { background: var(--dst-hover); color: var(--dst-text); }
.dst-panel-body { flex: 1; min-height: 0; padding: 16px 18px; overflow: auto; scrollbar-width: thin; overflow-wrap: anywhere; }
.dst-source { margin-bottom: 18px; padding: 10px 12px; border-left: 2px solid color-mix(in srgb, var(--dst-accent) 45%, transparent); border-radius: 0 8px 8px 0; background: var(--dst-soft); color: var(--dst-muted); font-size: 12px; line-height: 1.7; }
.dst-source-label { display: block; color: var(--dst-subtle); font-size: 10px; font-weight: 500; margin-bottom: 4px; }
.dst-source-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.dst-source[data-expanded="false"] .dst-source-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.dst-source-toggle, .dst-link { border: 0; background: transparent; color: var(--dst-accent); padding: 3px 0; font-size: 12px !important; }
.dst-source-toggle:hover, .dst-link:hover { text-decoration: underline; }
.dst-answer { font-size: 14px; line-height: 1.85; }
.dst-answer > :first-child, .dst-answer p:first-child { margin-top: 0; }
.dst-answer > :last-child, .dst-answer p:last-child { margin-bottom: 0; }
.dst-answer pre { max-width: 100%; overflow: auto; }
.dst-plain { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.dst-empty { color: var(--dst-subtle); font-size: 13px; }
.dst-caret { display: inline-block; width: 6px; height: 16px; border-radius: 3px; background: var(--dst-accent); animation: dst-pulse 1.2s ease-in-out infinite; }
.dst-panel-foot { display: flex; align-items: center; gap: 7px; flex-shrink: 0; min-height: 38px; padding: 8px 16px; border-top: 1px solid var(--dst-border); color: var(--dst-muted); font-size: 11px; line-height: 1.5; }
.dst-panel-foot .dst-error { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dst-foot-spacer { flex: 1; }
.dst-dot { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: #32a478; }
.dst-dot[data-state="running"] { background: var(--dst-accent); animation: dst-pulse 1.2s ease-in-out infinite; }
.dst-dot[data-state="error"] { background: #db5454; }
.dst-error { color: #db5454; }
.dst-resize { position: absolute; z-index: 2; touch-action: none; }
.dst-resize-n, .dst-resize-s { left: 16px; right: 16px; height: 6px; cursor: ns-resize; }
.dst-resize-n { top: 0; } .dst-resize-s { bottom: 0; }
.dst-resize-e, .dst-resize-w { top: 16px; bottom: 16px; width: 6px; cursor: ew-resize; }
.dst-resize-e { right: 0; } .dst-resize-w { left: 0; }
.dst-resize-ne, .dst-resize-nw, .dst-resize-se, .dst-resize-sw { width: 16px; height: 16px; }
.dst-resize-ne { top: 0; right: 0; cursor: nesw-resize; } .dst-resize-nw { top: 0; left: 0; cursor: nwse-resize; }
.dst-resize-se { bottom: 0; right: 0; cursor: nwse-resize; } .dst-resize-sw { bottom: 0; left: 0; cursor: nesw-resize; }
@container (max-width: 520px) {
  .dst-set-grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .dst-hero { padding: 18px 16px 15px; border-radius: 15px; }
  .dst-hero-steps { gap: 4px; }
  .dst-hero-step { padding: 2px 9px; font-size: 10px; }
  .dst-set-block-head { grid-template-columns: 28px minmax(0, 1fr); gap: 11px; }
  .dst-set-block-index { width: 28px; height: 28px; border-radius: 9px; }
}
@container (max-width: 360px) {
  .dst-hero-top { gap: 10px; }
  .dst-set-section .dst-set-title { font-size: 20px; }
  .dst-set-section .dst-set-intro { display: none; }
}
@keyframes dst-fade-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dst-pulse { 50% { opacity: .35; } }
@keyframes dst-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dst-root *, .dst-set-section * { animation: none !important; transition: none !important; }
}
`

/** 注入一次；沿用宿主 HMR 的样式标签身份，卸载时可回收。 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-select-assist'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
