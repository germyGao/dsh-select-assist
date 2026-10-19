/**
 * 跨 host/client 的稳定协议：路由前缀、请求体、SSE 事件。
 *
 * host 半边在 webServer 上注册 `/api/dsh-select-assist/*` 路由，
 * 浏览器半边用同源 fetch 调用（POST + SSE 流式返回）。
 */

/** 插件 id：bundle 行 name、client bundle 注册 id、日志标签共用。 */
export const PLUGIN_ID = 'dsh-select-assist'

/** 插件自有 HTTP 路由前缀（host half 注册，client half fetch）。 */
export const API_PREFIX = '/api/dsh-select-assist'

/** 一次划词请求允许的最大字符数（超出直接拒绝，避免意外把整篇文档塞给模型）。 */
export const MAX_SELECTION_LENGTH = 12000

/** 上下文段落允许的最大字符数（系统级取词用 UIA 读选区所在段落，超长直接截断）。 */
export const MAX_CONTEXT_LENGTH = 4000

/** 划词菜单的三个动作。 */
export type SelectionAction = 'translate' | 'explain' | 'summarize'

/** 界面语言：决定回答语言与默认目标语言。 */
export type UiLocale = 'zh' | 'en'

/** POST `${API_PREFIX}/run` 的请求体。 */
export interface RunRequest {
  /** 菜单动作。 */
  action: SelectionAction
  /** 选中的文本。 */
  text: string
  /**
   * 选中文本所在的上下文（选区所在的那个段落）。
   *
   * 系统级取词由伴生进程用 UI Automation 读到；页内划词取选区所在的块级元素文本。
   * 缺席表示"没有上下文"，提示词按无上下文的老路径走。
   */
  context?: string
  /** 当前会话的工作目录：决定复用哪一个插件会话（同目录共用一个会话）。 */
  cwd?: string
  /** 当前会话正在使用的模型 route，与 DSH 中保持一致；缺席时回落到部署默认模型。 */
  provider?: string
  model?: string
  /** 目标语言覆盖（默认按源文本自动判定）。 */
  target?: string
  /** 界面语言。 */
  locale?: UiLocale
  /** 强制走哪条执行路径（缺省读设置里的 engine）。 */
  engine?: RunEngine
}

/** SSE 事件（每帧 `data: <json>\n\n`）。 */
export type RunEvent =
  /** 已解析出运行会话，先于任何增量发出。 */
  | { type: 'session'; sessionId: string }
  /** assistant 文本增量。 */
  | { type: 'delta'; text: string }
  /** 本轮结束：text 是服务端汇总后的最终文本（客户端以此为准）。 */
  | { type: 'done'; sessionId: string; text: string }
  /** 失败。 */
  | { type: 'error'; message: string }

/** POST `${API_PREFIX}/stop` 的请求体。 */
export interface StopRequest {
  sessionId?: string
}

/** 解析一帧 SSE 的 data 负载；不是本协议的帧返回 undefined。 */
export function parseRunEvent(raw: string): RunEvent | undefined {
  try {
    const value = JSON.parse(raw) as RunEvent
    if (value === null || typeof value !== 'object') return undefined
    if (typeof (value as { type?: unknown }).type !== 'string') return undefined
    return value
  } catch {
    return undefined
  }
}
// ---------------------------------------------------------------- 插件设置

/**
 * 语言选项。
 *
 * `id` 是设置里持久化的稳定值，`prompt` 是交给模型的语言名（用英文名，避免模型
 * 在"把语言名当内容翻译"这类地方自作聪明），`label` 是界面显示名。
 */
export interface LanguageOption {
  id: string
  label: string
  prompt: string
}

/** "跟随原文自动"（中文→英文，其余→中文）——保留旧行为的那个选项。 */
export const AUTO_LANGUAGE_ID = 'auto'

/** 可选语言（覆盖常用语种；加语言只需在这里加一行）。 */
export const LANGUAGES: readonly LanguageOption[] = [
  { id: 'zh-Hans', label: '简体中文', prompt: 'Simplified Chinese' },
  { id: 'zh-Hant', label: '繁體中文', prompt: 'Traditional Chinese' },
  { id: 'en', label: 'English', prompt: 'English' },
  { id: 'ja', label: '日本語', prompt: 'Japanese' },
  { id: 'ko', label: '한국어', prompt: 'Korean' },
  { id: 'fr', label: 'Français', prompt: 'French' },
  { id: 'de', label: 'Deutsch', prompt: 'German' },
  { id: 'es', label: 'Español', prompt: 'Spanish' },
  { id: 'pt', label: 'Português', prompt: 'Portuguese' },
  { id: 'ru', label: 'Русский', prompt: 'Russian' },
  { id: 'it', label: 'Italiano', prompt: 'Italian' },
  { id: 'nl', label: 'Nederlands', prompt: 'Dutch' },
  { id: 'pl', label: 'Polski', prompt: 'Polish' },
  { id: 'sv', label: 'Svenska', prompt: 'Swedish' },
  { id: 'tr', label: 'Türkçe', prompt: 'Turkish' },
  { id: 'uk', label: 'Українська', prompt: 'Ukrainian' },
  { id: 'ar', label: 'العربية', prompt: 'Arabic' },
  { id: 'he', label: 'עברית', prompt: 'Hebrew' },
  { id: 'fa', label: 'فارسی', prompt: 'Persian' },
  { id: 'hi', label: 'हिन्दी', prompt: 'Hindi' },
  { id: 'bn', label: 'বাংলা', prompt: 'Bengali' },
  { id: 'th', label: 'ไทย', prompt: 'Thai' },
  { id: 'vi', label: 'Tiếng Việt', prompt: 'Vietnamese' },
  { id: 'id', label: 'Bahasa Indonesia', prompt: 'Indonesian' },
  { id: 'ms', label: 'Bahasa Melayu', prompt: 'Malay' },
] as const

/** 取语言选项（未知 id 返回 undefined）。 */
export function languageById(id: string): LanguageOption | undefined {
  return LANGUAGES.find((item) => item.id === id)
}

/** 一个"模型座位"：provider + model，外加可选的推理等级。 */
export interface ModelSeat {
  provider: string
  model: string
  /** 适配器拥有的推理等级 id（缺席 = 用适配器默认）。 */
  reasoningEffort?: string
}

/** 一次划词走哪条执行路径。 */
export type RunEngine =
  /** 直连模型：一次普通调用，边生成边显示，最快，但没有会话记录、不能用工具。 */
  | 'direct'
  /** 走 Harness 自己的 agent 回合：会建一条真实会话（可在侧栏继续追问），但慢得多。 */
  | 'agent'

/** 插件设置（持久化在 DSH home 下的 dsh-select-assist.json）。 */
export interface SelectionToolsSettings {
  /** 执行路径（默认 direct）。 */
  engine: RunEngine
  /** 默认翻译至：语言 id 或 `auto`（跟随原文自动）。 */
  targetLanguage: string
  /** 选中文本已经是「默认翻译至」的语言时改译成的语言：语言 id 或 `auto`（镜像）。 */
  fallbackLanguage: string
  /** 解释时交给模型的"要求"文本（每行一条，原样进提示词）。 */
  explainRules: string
  /** 翻译时交给模型的"要求"文本。 */
  translateRules: string
  /** 总结时交给模型的"要求"文本。 */
  summarizeRules: string
  /** 翻译用的模型座位；null = 跟随当前会话 / 部署默认。 */
  translateModel: ModelSeat | null
  /** 解释用的模型座位；null = 跟随当前会话 / 部署默认。 */
  explainModel: ModelSeat | null
  /** 总结用的模型座位；null = 跟随当前会话 / 部署默认。 */
  summarizeModel: ModelSeat | null
}

/** 解释规则默认文本。 */
export const DEFAULT_EXPLAIN_RULES = [
  '- 结合语境解释选中的文本：它指什么、在这里起什么作用。',
  '- 先用一两句话说明它的含义，再分小节说明关键概念与背景；如果是代码，说明它的作用与执行过程。',
  '- 用 Markdown 组织回答，简洁准确，不要整段复述选中的文本或上文。',
  '- 不要评论有没有提供上文、也不要说明你是怎么判断语境的，直接给出解释。',
  '- 这是一次独立请求：只解释选中的文本，不要提及或评论任何先前的对话内容。',
].join('\n')

/**
 * 翻译规则默认文本。
 *
 * 词/短语按词典条目给（最佳翻译 + 音标 + 其他翻译 + 术语说明），句子/段落给整段译文
 * 并额外解释其中的关键术语与缩写——这些都靠规则驱动，模型自己判断是词还是句。
 */
export const DEFAULT_TRANSLATE_RULES = [
  '- 先判断选中的是「词/短语」还是「句子/段落」，按对应格式输出。',
  '- 词或短语：按词典条目排版——',
  '  - 第一行：**最佳翻译**（最贴合当前语境的那一个译法）。',
  '  - 第二行：读音，写成 \`英 /…/　美 /…/\`（国际音标；中文等非表音文字可省略这一行）。',
  '  - 空一行后给 \`其他翻译\`：2~4 个其他义项，每条一行，写成 \`- 译法 — 词性/领域，什么时候用\`。',
  '  - 如果它是关键术语或缩写：再给一小节 \`术语说明\`，缩写先写全称，再用一句话说明它指什么。',
  '- 句子或段落：先给完整译文；如果句中出现了关键术语、缩写或专有名词，再追加小节 \`关键术语\`，逐条给出全称与一句解释（没有就不写这一节，不要硬凑）。',
  '- 只输出译文与上述小节：不要前言、不要复述原文、不要说明你是怎么判断词还是句子的。',
  '- 保留原文的格式、换行、行内代码与专有名词；如果原文已经是目标语言，原样返回。',
].join('\n')

/** 总结规则默认文本。 */
export const DEFAULT_SUMMARIZE_RULES = [
  '- 先用一句话给出核心结论，再分「要点」小节逐条列出关键信息（每条一行，最多 5 条）。',
  '- 如果原文有明确的结构（章节、列表、对话轮次），保留它的大致层次再压缩。',
  '- 只保留原文真正说了的内容：不要补充背景知识，不要评价好坏，不要给建议。',
  '- 数字、专有名词、结论性判断必须原样保留，不要模糊成「一些」「若干」。',
  '- 用 Markdown 组织回答；原文很短时直接给一句话总结，不要硬凑要点。',
  '- 这是一次独立请求：只总结选中的文本，不要提及或评论任何先前的对话内容。',
].join('\n')

/** 默认设置。 */
export const DEFAULT_SETTINGS: SelectionToolsSettings = {
  engine: 'direct',
  targetLanguage: AUTO_LANGUAGE_ID,
  fallbackLanguage: AUTO_LANGUAGE_ID,
  explainRules: DEFAULT_EXPLAIN_RULES,
  translateRules: DEFAULT_TRANSLATE_RULES,
  summarizeRules: DEFAULT_SUMMARIZE_RULES,
  translateModel: null,
  explainModel: null,
  summarizeModel: null,
}

/** 规则文本上限（避免把提示词撑爆）。 */
export const MAX_RULES_LENGTH = 4000

/** GET/POST `${API_PREFIX}/settings` 的响应体。 */
export interface SettingsResponse {
  ok: boolean
  settings: SelectionToolsSettings
  defaults: SelectionToolsSettings
  languages: readonly LanguageOption[]
  /** 设置文件路径（排障用）。 */
  path: string
}

/**
 * 把任意输入规整成合法设置（缺项补默认、非法值丢弃）。
 * 主客两边共用：客户端在提交前也用它做一次本地校验。
 */
export function normalizeSettings(input: unknown): SelectionToolsSettings {
  const raw = (input ?? {}) as Partial<Record<keyof SelectionToolsSettings, unknown>>
  const language = (value: unknown, fallback: string): string => {
    const id = typeof value === 'string' ? value : ''
    if (id === AUTO_LANGUAGE_ID) return id
    return languageById(id) === undefined ? fallback : id
  }
  const rules = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string') return fallback
    const text = value.replace(/\r\n/g, '\n').trim()
    if (text === '') return fallback
    return text.length > MAX_RULES_LENGTH ? text.slice(0, MAX_RULES_LENGTH) : text
  }
  const seat = (value: unknown): ModelSeat | null => {
    if (value === null || value === undefined || typeof value !== 'object') return null
    const candidate = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
    const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
    if (provider === '' || model === '') return null
    const effort = typeof candidate.reasoningEffort === 'string' ? candidate.reasoningEffort.trim() : ''
    return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
  }
  return {
    engine: raw.engine === 'agent' ? 'agent' : 'direct',
    targetLanguage: language(raw.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
    fallbackLanguage: language(raw.fallbackLanguage, DEFAULT_SETTINGS.fallbackLanguage),
    explainRules: rules(raw.explainRules, DEFAULT_SETTINGS.explainRules),
    translateRules: rules(raw.translateRules, DEFAULT_SETTINGS.translateRules),
    summarizeRules: rules(raw.summarizeRules, DEFAULT_SETTINGS.summarizeRules),
    translateModel: seat(raw.translateModel),
    explainModel: seat(raw.explainModel),
    summarizeModel: seat(raw.summarizeModel),
  }
}