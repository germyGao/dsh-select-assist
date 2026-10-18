/**
 * 提示词构造：翻译 / 解释。
 *
 * 这里只负责「用户会怎么问」——真正干活的是 Harness 自己的 agent
 * （同一个 agent loop、同一套系统提示与工具），因此行为与在 DSH 里
 * 手敲同一句话完全一致。
 *
 * 「要求」那一段是**用户可编辑**的（设置页里改，存在 dsh-selection-tools.json）：
 * 解释/翻译的规则就是要交给模型的规则信息，不锁死在代码里。
 */
import {
  AUTO_LANGUAGE_ID,
  DEFAULT_EXPLAIN_RULES,
  DEFAULT_SUMMARIZE_RULES,
  DEFAULT_TRANSLATE_RULES,
  languageById,
  type SelectionAction,
  type SelectionToolsSettings,
  type UiLocale,
} from './shared/protocol.js'

/** 文本里是否含 CJK 汉字。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}

/** 文本里是否含日文假名。 */
function hasKana(text: string): boolean {
  return /[\u3040-\u30ff]/.test(text)
}

/** 文本里是否含韩文谚文。 */
function hasHangul(text: string): boolean {
  return /[\uac00-\ud7af]/.test(text)
}

/**
 * 默认目标语言：源文本是中文 → 译成英文；否则译成中文。
 * @param text - 选中文本。
 * @param locale - 界面语言（决定中文写成「中文」还是「Chinese」）。
 */
export function defaultTarget(text: string, locale: UiLocale): string {
  return hasCjk(text) ? (locale === 'en' ? 'English' : '英文') : locale === 'en' ? 'Chinese (Simplified)' : '中文'
}

/** 语言 id → 提示词里的语言名（中文界面下中/英用中文写法，其余用英文名）。 */
export function languagePromptName(id: string, locale: UiLocale): string {
  const option = languageById(id)
  if (option === undefined) return locale === 'en' ? 'Chinese (Simplified)' : '中文'
  if (locale === 'en') return option.prompt
  if (option.id === 'zh-Hans') return '中文'
  if (option.id === 'en') return '英文'
  return option.prompt
}

/** 文本看着像不像某种语言（只做能可靠判断的几种，其余一律"不像"）。 */
function looksLikeLanguage(text: string, id: string): boolean {
  if (id === 'zh-Hans' || id === 'zh-Hant') return hasCjk(text) && !hasKana(text)
  if (id === 'ja') return hasKana(text)
  if (id === 'ko') return hasHangul(text)
  return false
}

/**
 * 这一轮到底翻成什么语言。
 *
 * - 「默认翻译至」= auto：保持旧行为（中文→英文，其余→中文）；
 * - 选了具体语言：就是它；要是原文已经是这个语言，改用「反向目标语言」
 *   （fallback 也是 auto 时取镜像：原文是中文就译英文，否则译中文）。
 */
export function resolveTarget(text: string, settings: SelectionToolsSettings, locale: UiLocale): string {
  const requested = settings.targetLanguage
  if (requested === AUTO_LANGUAGE_ID) return defaultTarget(text, locale)
  if (!looksLikeLanguage(text, requested)) return languagePromptName(requested, locale)
  const fallback = settings.fallbackLanguage
  if (fallback === AUTO_LANGUAGE_ID || fallback === requested) return defaultTarget(text, locale)
  return languagePromptName(fallback, locale)
}

/** 取规则文本（空串退回默认）。 */
function rulesOf(value: string, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? fallback : text
}

/** 提示词骨架（各语言一套）。 */
function skeleton(
  locale: UiLocale,
  action: SelectionAction,
): { intro: string; heading: string; textLabel: string; contextLabel: string } {
  if (locale === 'en') {
    const shared = { heading: 'Requirements:', textLabel: 'Selected text:', contextLabel: 'Surrounding text (context only):' }
    if (action === 'translate') return { intro: 'Translate the text below into {target}.', ...shared }
    if (action === 'summarize') return { intro: 'Summarize the text below.', ...shared }
    return { intro: 'Explain the text below.', ...shared, contextLabel: 'Surrounding text:' }
  }
  const shared = { heading: '要求：', textLabel: '选中的文本：', contextLabel: '上文（仅作语境，不要翻译）：' }
  if (action === 'translate') return { intro: '把下面的文本翻译成{target}。', ...shared }
  if (action === 'summarize') return { intro: '总结下面这段文本。', ...shared }
  return { intro: '解释下面这段文本。', ...shared, contextLabel: '上文：' }
}

/**
 * 构造本轮发给 agent 的用户消息。
 * @param action - 翻译或解释。
 * @param text - 选中文本。
 * @param target - 目标语言（仅翻译用）。
 * @param locale - 界面语言。
 * @param context - 选中文本所在的上下文段落（没有就传空串）。
 * @param rules - 该动作用户配置的"要求"文本（空串用默认）。
 */
export function buildPrompt(
  action: SelectionAction,
  text: string,
  target: string,
  locale: UiLocale,
  context = '',
  rules = '',
): string {
  const trimmed = typeof context === 'string' ? context.trim() : ''
  const parts = skeleton(locale, action)
  const fallbackRules =
    action === 'translate'
      ? DEFAULT_TRANSLATE_RULES
      : action === 'summarize'
        ? DEFAULT_SUMMARIZE_RULES
        : DEFAULT_EXPLAIN_RULES
  const requirement = rulesOf(rules, fallbackRules)
  const lines = [
    parts.intro.replace('{target}', target),
    '',
    parts.heading,
    requirement,
    '',
    parts.textLabel,
    '```',
    text,
    '```',
  ]
  if (trimmed !== '') lines.push('', parts.contextLabel, '```', trimmed, '```')
  return lines.join('\n')
}
