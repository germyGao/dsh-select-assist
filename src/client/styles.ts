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
  --dst-accent: #4176e6;
  --dst-tint: color-mix(in srgb, var(--dst-accent) 9%, var(--dst-surface));
  --dst-hover: var(--dsw-alias-interactive-bg-hover, rgba(65, 118, 230, .06));
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

/* 设置页：标题、操作路径、三个独立设置区域。 */
.dst-set-section { container-type: inline-size; width: 100%; max-width: 840px; min-width: 0; margin: 0 auto; padding: 4px 0 24px; }
.dst-set-header { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; flex-wrap: wrap; }
.dst-set-brand { display: grid; place-items: center; width: 52px; height: 52px; flex-shrink: 0; border-radius: 16px; background: var(--dst-tint); color: var(--dst-accent); border: 1px solid color-mix(in srgb, var(--dst-accent) 14%, transparent); }
.dst-set-heading { flex: 1; min-width: 160px; }
.dst-set-section .dst-set-title { margin: 0; font-size: 23px; line-height: 1.4; font-weight: 650; letter-spacing: -.5px; color: var(--dst-text); }
.dst-set-section .dst-set-hint { display: block; margin: 0; color: var(--dst-muted); font-size: 12px; line-height: 1.75; overflow-wrap: anywhere; }
.dst-set-section .dst-set-intro { margin-top: 4px; font-size: 13px; }
.dst-set-save { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 7px; font-size: 11px; color: var(--dst-muted); background: var(--dst-soft); white-space: nowrap; }
.dst-set-save[data-state="saved"] { color: #26845d; }
.dst-set-save[data-state="error"], .dst-set-error { color: #db5454; }
.dst-set-save[data-state="error"] svg { display: none; }
.dst-set-spinner { width: 11px; height: 11px; border: 1.5px solid var(--dst-border); border-top-color: var(--dst-accent); border-radius: 50%; animation: dst-spin .8s linear infinite; }
.dst-set-workflow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 24px; padding: 12px 18px; color: var(--dst-subtle); background: var(--dst-soft); border-radius: 11px; font-size: 12px; }
.dst-set-step { display: inline-flex; align-items: center; gap: 8px; color: var(--dst-muted); }
.dst-set-step:first-child svg { color: var(--dst-accent); }
.dst-set-card { padding: 20px; margin-top: 16px; border: 1px solid var(--dst-border); border-radius: 14px; background: var(--dst-surface); }
.dst-set-card-heading { display: flex; align-items: center; gap: 11px; margin-bottom: 20px; }
.dst-set-card-icon { display: grid; place-items: center; flex-shrink: 0; width: 34px; height: 34px; border-radius: 10px; background: var(--dst-soft); color: var(--dst-muted); }
.dst-set-section .dst-set-card-title { margin: 0 0 2px; font-size: 14px; line-height: 1.5; font-weight: 650; color: var(--dst-text); }
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
.dst-set-rules { border: 1px solid var(--dst-border); border-radius: 10px; overflow: hidden; }
.dst-set-rule + .dst-set-rule { border-top: 1px solid var(--dst-border); }
.dst-set-rule-summary { display: flex; align-items: center; gap: 10px; padding: 14px; list-style: none; cursor: pointer; color: var(--dst-muted); transition: background .15s; }
.dst-set-rule-summary::-webkit-details-marker { display: none; }
.dst-set-rule-summary:hover { background: var(--dst-hover); }
.dst-set-rule-summary:focus-visible { outline-offset: -3px !important; }
.dst-set-rule-name { flex: 1; font-size: 13px; font-weight: 500; color: var(--dst-text); }
.dst-set-rule-badge { font-size: 10px; padding: 2px 7px; border-radius: 5px; background: var(--dst-soft); color: var(--dst-muted); }
.dst-set-rule-badge[data-custom="true"] { background: var(--dst-tint); color: var(--dst-accent); }
.dst-set-rule-chevron { transition: transform .16s; }
.dst-set-rule[open] .dst-set-rule-chevron { transform: rotate(180deg); }
.dst-set-rule-body { padding: 0 14px 14px; }
.dst-set-textarea { display: block; resize: vertical; min-height: 140px; line-height: 1.8; }
.dst-set-labelrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; flex-wrap: wrap; }
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
  .dst-set-card { padding: 16px; }
  .dst-set-workflow { padding: 10px 12px; gap: 6px; font-size: 11px; }
  .dst-set-step { gap: 5px; }
  .dst-set-step svg { display: none; }
}
@container (max-width: 360px) {
  .dst-set-header { gap: 10px; }
  .dst-set-save { margin-left: 62px; }
  .dst-set-brand { width: 44px; height: 44px; border-radius: 13px; }
  .dst-set-section .dst-set-title { font-size: 20px; }
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
