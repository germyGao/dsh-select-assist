/**
 * dsh-select-assist —— host 半边（Cordis 插件）。
 *
 * 职责只有两件事：
 * 1. 在 webServer 上注册 `/api/dsh-select-assist/*` 同源路由（run / stop / ping）。
 * 2. `run` 里用 Harness 自己的 agent（ctx.agents）跑一轮真实的会话回合，
 *    把 assistant 文本增量以 SSE 推给浏览器半边。
 *
 * 因为跑的是同一套 agent loop（同系统提示、同工具、同模型 route），
 * 划词翻译/解释的行为与结果和直接在 DSH 里手敲同一句话一致；
 * 会话本身也是一条真实会话，可以在 DSH 侧栏里打开继续对话。
 */
import { randomUUID } from 'node:crypto'

import { createCompanionManager, type CompanionStatus } from './companion.js'
import { buildPrompt, resolveTarget } from './prompt.js'
import { loadSettings, saveSettings, settingsFilePath } from './settings.js'
import {
  API_PREFIX,
  DEFAULT_SETTINGS,
  type SelectionToolsSettings,
  LANGUAGES,
  MAX_CONTEXT_LENGTH,
  MAX_SELECTION_LENGTH,
  PLUGIN_ID,
  type RunRequest,
  type SettingsResponse,
  type UiLocale,
} from './shared/protocol.js'

/** Cordis 插件名。 */
export const name = PLUGIN_ID

/**
 * 硬依赖：路由宿主、agent 注册表、LLM 服务。
 * （model route 默认值经 ctx.get('agentDefaultModel') 可选读取。）
 *
 * `agents` 只在 engine='agent' 那条老路径上用到；`llm` 是快路径的唯一依赖。
 */
export const inject = ['webServer', 'agents', 'llm']

/** 每个会话串行执行，避免两次划词互相打断（仅 engine='agent' 路径）。 */
const queues = new Map<string, Promise<unknown>>()

/** 正在跑的直连请求：runId → 中止器（`/stop` 用）。 */
const runs = new Map<string, AbortController>()

/** @deepseek-ai/dsh-agent 的 AgentHandle（只用到 agent / dispose）。 */
interface AgentHandle {
  agent: AgentLike
  dispose?: () => Promise<void> | void
}

/** 只声明本插件真正读写的 agent 面。 */
interface AgentLike {
  id?: string
  session?: SessionLike
  /** agent 自己的作用域上下文（订阅 agent/* 事件用）。 */
  ctx?: { on?: (event: string, listener: (...args: any[]) => void) => () => void }
  followup: (input: unknown) => void
  whenIdle: () => Promise<void>
  cancel?: (cause: unknown, options?: unknown) => void
}

/** 只声明本插件真正读写的 session 面。 */
interface SessionLike {
  id: string
  seq: number
  eventAt: (seq: number) => { type: string; data?: unknown } | undefined
}

/**
 * 造一条与官方 `@deepseek-ai/dsh-llm` createUserMessage 等价的 user 消息。
 *
 * 这里刻意不 import 官方包：插件常以 `link:`/本地路径装进 profile，而 Node 按
 * **真实路径**解析 import —— 官方包只在 `$DSH_HOME/profiles/node_modules` 里可达，
 * 插件源码在别的盘符时就会 ERR_MODULE_NOT_FOUND（实测会让整个 dsh web 起不来）。
 * 官方实现就是 `{ role:'user', content, source, id: uuid }` 再冻结，这里照做。
 *
 * `source.rpcId` 必须给：官方 session.prompt 用它做 UI 去重/装配，缺了会话在 DSH
 * 对话视图里会报 "received more than one start Match"（实测）。
 * @param prompt - 本轮用户消息文本。
 * @returns 可直接交给 `agent.followup` 的消息对象。
 */
function createUserMessage(prompt: string): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: prompt })]),
    source: Object.freeze({ kind: 'user', rpcId: randomUUID() }),
  })
}

/** 一圈 SSE 写出的最小响应面。 */
interface SseSink {
  send: (payload: unknown) => void
}

/** 把值以 lossless JSON 写进响应；响应已结束则静默丢弃。 */
function makeSink(res: {
  writableEnded?: boolean
  write: (chunk: string) => void
}): SseSink {
  return {
    send(payload: unknown) {
      if (res.writableEnded === true) return
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    },
  }
}

/** 读满请求体（上限 1 MiB，防御性上限，真正的长度校验在正文里）。 */
async function readBody(req: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 读取 `{ action, text, ... }` 请求体。 */
async function parseRunRequest(req: AsyncIterable<unknown>): Promise<RunRequest> {
  const raw = await readBody(req)
  const parsed = JSON.parse(raw === '' ? '{}' : raw) as Partial<RunRequest>
  const action =
    parsed.action === 'translate'
      ? 'translate'
      : parsed.action === 'summarize'
        ? 'summarize'
        : parsed.action === 'explain'
          ? 'explain'
          : undefined
  if (action === undefined) throw new Error('action must be "translate", "explain" or "summarize"')
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  if (text.trim() === '') throw new Error('text is empty')
  if (text.length > MAX_SELECTION_LENGTH) throw new Error(`text is longer than ${MAX_SELECTION_LENGTH} characters`)
  const locale: UiLocale = parsed.locale === 'en' ? 'en' : 'zh'
  const context = typeof parsed.context === 'string' ? parsed.context.trim() : ''
  return {
    action,
    text,
    locale,
    ...(context === '' ? {} : { context: context.slice(0, MAX_CONTEXT_LENGTH) }),
    ...(typeof parsed.cwd === 'string' && parsed.cwd !== '' ? { cwd: parsed.cwd } : {}),
    ...(typeof parsed.provider === 'string' && parsed.provider !== '' ? { provider: parsed.provider } : {}),
    ...(typeof parsed.model === 'string' && parsed.model !== '' ? { model: parsed.model } : {}),
    ...(typeof parsed.target === 'string' && parsed.target !== '' ? { target: parsed.target } : {}),
    ...(parsed.engine === 'direct' || parsed.engine === 'agent' ? { engine: parsed.engine } : {}),
  }
}

/**
 * 决定这条 agent 用的模型 route：优先跟随当前 DSH 会话的模型，
 * 否则用部署默认（`ctx.agentDefaultModel`），再否则交给 agent loop 自己的默认。
 */
function resolveAgentOptions(
  ctx: AnyCtx,
  request: RunRequest,
  settings: SelectionToolsSettings,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  // 设置里为这个动作指定了模型座位 → 它就是最优先（用户显式选择）。
  const seat =
    request.action === 'translate'
      ? settings.translateModel
      : request.action === 'summarize'
        ? settings.summarizeModel
        : settings.explainModel
  if (seat !== null) {
    return {
      provider: seat.provider,
      model: seat.model,
      ...(seat.reasoningEffort === undefined ? {} : { reasoningEffort: seat.reasoningEffort }),
    }
  }
  if (request.provider !== undefined && request.model !== undefined) {
    return { provider: request.provider, model: request.model }
  }
  return defaultAgentOptions(ctx)
}

/** 部署默认模型 route（agentDefaultModel 服务缺席时返回 undefined）。 */
function defaultAgentOptions(ctx: AnyCtx): { provider: string; model: string } | undefined {
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() as
      | { provider?: unknown; model?: unknown }
      | undefined
    if (typeof selection?.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* 服务缺席：交给 agent loop 自己的默认值 */
  }
  return undefined
}

/**
 * 每次划词都用一条**全新会话**：
 * - 与 DSH 里"新开一个对话"一致——上下文干净，回答不会被历史轮次带跑
 *   （复用一条会话时实测模型会开始评论"同一段文本这是第四次了"）；
 * - 会话**不归档**，跑完留在侧栏的「未分组」里，随时能翻出来继续问。
 *
 * 会话仍带上当前会话的 cwd（agent 没有工作目录会静默无输出），但不会被挂进
 * 任何项目分组——`meta` 里不写 workspaceId，宿主就不会自动 attach；
 * 万一被别处挂上了，ensureUngrouped() 会再把它摘下来。
 */
async function ensureAgent(
  ctx: AnyCtx,
  cwd: string | undefined,
  request: RunRequest,
  settings: SelectionToolsSettings,
): Promise<AgentHandle> {
  const agentOptions = resolveAgentOptions(ctx, request, settings)
  // 会话始终带 cwd：agent 在没有工作目录的会话上装配请求会失败（实测静默无输出）。
  const effectiveCwd = cwd ?? process.cwd()
  const sessionId = `session-${randomUUID()}`
  const handle = (await ctx.agents.create({
    sessionId,
    meta: { cwd: effectiveCwd },
    ...(agentOptions === undefined ? {} : { agentOptions }),
  })) as AgentHandle
  // 建好就定分组：这一轮中途失败也不会把它留在某个项目下，落点始终是「未分组」。
  await ensureUngrouped(ctx, sessionId)
  return handle
}

/** 串行执行同一 handle 上的一轮对话。 */
function enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(job, job)
  queues.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** 从本轮起点向后找最后一条 assistant 消息的文本（服务端权威结果）。 */
function lastAssistantText(session: SessionLike, fromSeq: number): string {
  const end = Number(session.seq ?? 0)
  for (let seq = end - 1; seq >= fromSeq; seq -= 1) {
    let event: { type: string; data?: unknown } | undefined
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const content = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type: 'text'; text: string } => {
        const candidate = block as { type?: unknown; text?: unknown }
        return candidate?.type === 'text' && typeof candidate.text === 'string'
      })
      .map((block) => block.text)
      .join('')
    if (text.trim() !== '') return text
  }
  return ''
}

/** 直连路径用到的 LLM 服务面（`ctx.get('llm')`）。 */
interface LlmLike {
  stream: (options: unknown) => AsyncIterable<StreamChunkLike>
}

/** 只声明本插件真正读的 chunk 字段。 */
interface StreamChunkLike {
  type?: string
  text?: unknown
  reason?: { kind?: string; failure?: { message?: unknown; code?: unknown } }
}

/** 一轮直连请求的运行句柄。 */
interface DirectCall {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * 决定这条请求打到哪个模型：设置里的座位 > 请求自带的 route > 部署默认。
 * 与 agent 路径共用同一套优先级（resolveAgentOptions）。
 */
function resolveDirectCall(
  ctx: AnyCtx,
  request: RunRequest,
  settings: SelectionToolsSettings,
): DirectCall | undefined {
  const seat =
    request.action === 'translate'
      ? settings.translateModel
      : request.action === 'summarize'
        ? settings.summarizeModel
        : settings.explainModel
  if (seat !== null) {
    return {
      provider: seat.provider,
      model: seat.model,
      ...(seat.reasoningEffort === undefined ? {} : { reasoningEffort: seat.reasoningEffort }),
    }
  }
  if (request.provider !== undefined && request.model !== undefined) {
    return { provider: request.provider, model: request.model }
  }
  return defaultAgentOptions(ctx)
}

/**
 * 快路径：不建会话、不进 agent loop，直接调一次模型并把增量推下去。
 *
 * 这是与 agent 路径的**行为差异**所在：没有系统提示、没有工具、没有 DSH 会话记录，
 * 因此不能在侧栏里接着追问——换来的是首字延迟从"整轮跑完"降到"模型吐第一个字"。
 *
 * @param ctx - 宿主上下文（用它的 `llm` 服务）。
 * @param sink - SSE 写出面。
 * @param args - 已校验的划词请求。
 */
async function runDirect(ctx: AnyCtx, sink: SseSink, args: RunRequest): Promise<void> {
  const settings = loadSettings()
  const llm = ctx.get?.('llm') as LlmLike | undefined
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('llm service is unavailable')
  }
  const call = resolveDirectCall(ctx, args, settings)
  if (call === undefined) {
    throw new Error('no model route: set one in the plugin settings or in the current session')
  }

  const locale = args.locale ?? 'zh'
  const target = args.target ?? resolveTarget(args.text, settings, locale)
  const rules =
    args.action === 'translate'
      ? settings.translateRules
      : args.action === 'summarize'
        ? settings.summarizeRules
        : settings.explainRules
  const prompt = buildPrompt(args.action, args.text, target, locale, args.context ?? '', rules)

  const runId = `run-${randomUUID()}`
  const controller = new AbortController()
  runs.set(runId, controller)
  // 客户端拿 runId 当 sessionId 用（/stop 的形状不变，只是它现在指向一次请求而不是一条会话）。
  sink.send({ type: 'session', sessionId: runId })

  let text = ''
  try {
    const options = {
      provider: call.provider,
      model: call.model,
      ...(call.reasoningEffort === undefined ? {} : { reasoningEffort: call.reasoningEffort }),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    }
    for await (const chunk of llm.stream(options)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        sink.send({ type: 'delta', text: chunk.text })
        continue
      }
      if (chunk.type !== 'finish') continue
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const failure = chunk.reason?.failure
        const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : 'model call failed'
        throw new Error(message)
      }
    }
  } finally {
    runs.delete(runId)
  }

  if (text.trim() === '') throw new Error('model produced no text output')
  sink.send({ type: 'done', sessionId: runId, text })
}

/** 跑一轮：把 agent 的 assistant 文本增量以 SSE 推给调用方。 */
async function runTurn(
  ctx: AnyCtx,
  sink: SseSink,
  args: RunRequest,
): Promise<void> {
  const settings = loadSettings()
  const handle = await ensureAgent(ctx, args.cwd, args, settings)
  const agent = handle.agent
  const session = agent.session
  if (session === undefined) throw new Error('agent has no session')
  const sessionId = session.id
  sink.send({ type: 'session', sessionId })

  const fromSeq = Number(session.seq ?? 0)
  const locale = args.locale ?? 'zh'
  const target = args.target ?? resolveTarget(args.text, settings, locale)
  const rules =
    args.action === 'translate'
      ? settings.translateRules
      : args.action === 'summarize'
        ? settings.summarizeRules
        : settings.explainRules
  const prompt = buildPrompt(args.action, args.text, target, locale, args.context ?? '', rules)

  /** 本轮事件轨迹（诊断用：失败时能看出卡在哪一步）。 */
  const trace: string[] = []
  /** agent 自己上报的失败（agent/error）；kick() 会把异常吞掉，只能从这里拿到原因。 */
  let agentFailure: string | undefined
  const offAgentError = listenAgentError(agent, (message) => {
    agentFailure = message
  })

  const off = ctx.on('session/event', (eventSession: SessionLike, event: { type?: string; data?: unknown }) => {
    if (eventSession !== session) return
    if (typeof event?.type === 'string') {
      trace.push(event.type)
      if (trace.length > 24) trace.shift()
    }
    if (event?.type !== 'assistant/chunk') return
    const chunk = (event.data as { chunk?: { type?: string; text?: unknown } } | undefined)?.chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') sink.send({ type: 'delta', text: chunk.text })
  })

  let text = ''
  try {
    await enqueue(sessionId, async () => {
      agent.followup(createUserMessage(prompt))
      await agent.whenIdle()
    })
    text = lastAssistantText(session, fromSeq)
    // 落盘：会话记录留在磁盘上，并且留在侧栏的「未分组」里（不归档）。
    await flushSession(ctx, session)
  } finally {
    off()
    offAgentError()
  }

  if (text.trim() === '') {
    const reason = agentFailure ?? `agent produced no assistant text (events: ${trace.join(', ') || 'none'})`
    throw new Error(reason)
  }
  sink.send({ type: 'done', sessionId, text })
}

/**
 * 让这条会话留在侧栏的「未分组」里（best-effort）。
 *
 * 侧栏的分组规则是：归档集合里的会话在所有视图里都不显示；剩下的会话按"是否被
 * 某个项目（workspace）记账"分到项目下或「未分组」。所以本插件**不调用
 * archiveSession**，只在确实被挂到项目上时把它摘出来（detach），保证落点是「未分组」
 * 而不是某个项目——插件的划词记录是即用即走的一次性对话，不该混进用户的工程分组。
 *
 * @returns 实际落点，仅用于日志/诊断。
 */
async function ensureUngrouped(ctx: AnyCtx, sessionId: string): Promise<'ungrouped' | 'detached' | 'unknown'> {
  try {
    const registry = ctx.get?.('workspaceRegistry')
    if (registry === undefined || registry === null) return 'unknown'
    const workspaces = typeof registry.list === 'function' ? registry.list() ?? [] : []
    for (const workspace of workspaces) {
      const ids = workspace?.sessionIds
      if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
      if (typeof workspace?.detachSession !== 'function') return 'unknown'
      await workspace.detachSession(sessionId)
      return 'detached'
    }
    return 'ungrouped'
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: keeping ${sessionId} ungrouped failed`, error)
    return 'unknown'
  }
}

/** 等一轮持久化落盘（服务缺席或失败都不影响本轮作答）。 */
async function flushSession(ctx: AnyCtx, session: SessionLike): Promise<void> {
  try {
    await ctx.get?.('sessions')?.flush?.(session)
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: session flush failed`, error)
  }
}

/** 订阅 agent 自己的失败上报；事件缺席或上下文不可用时安静跳过。 */
function listenAgentError(agent: AgentLike, report: (message: string) => void): () => void {
  try {
    const agentCtx = agent.ctx
    if (typeof agentCtx?.on !== 'function') return () => {}
    return agentCtx.on('agent/error', (payload: { error?: { message?: unknown }; message?: unknown }) => {
      const message = payload?.error?.message ?? payload?.message
      report(typeof message === 'string' && message !== '' ? message : 'agent reported an error')
    })
  } catch {
    return () => {}
  }
}

/** 停止一轮：直连请求走 AbortController，agent 请求走 agent.cancel。 */
function stopTurn(ctx: AnyCtx, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false
  const direct = runs.get(sessionId)
  if (direct !== undefined) {
    direct.abort()
    return true
  }
  const agent = ctx.agents.get?.(sessionId) as AgentLike | undefined
  if (agent?.cancel === undefined) return false
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  return true
}

/** 插件持有的最小 ctx 面（避免依赖官方类型包）。 */
interface AnyCtx {
  webServer: {
    register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: any, res: any) => unknown }) => () => void
    /** 监听端口（传给伴生进程作为 DSH 路由的基地址）。 */
    port?: number
  }
  agents: {
    create: (options: unknown) => Promise<unknown>
    get?: (sessionId: string) => unknown
  }
  on: (event: string, listener: (...args: any[]) => void) => () => void
  effect: (callback: () => unknown, label?: string) => unknown
  get?: (name: string) => any
  logger?: { warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
}

function writeJson(res: any, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 伴生进程管理器（apply 时注入，供 /system/* 路由读取状态）。 */
interface CompanionManager {
  status: () => CompanionStatus & { enabled: boolean; entry: string }
  start: () => void
  stop: () => void
  /** 重启：先送走老进程（等它真的退出）再拉起新的。 */
  restart: () => Promise<void>
}

/** 路由总入口。 */
async function handleRequest(ctx: AnyCtx, req: any, res: any, companion: CompanionManager): Promise<void> {
  const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
  if (url.pathname === `${API_PREFIX}/ping`) {
    writeJson(res, 200, { ok: true, plugin: PLUGIN_ID })
    return
  }
  if (url.pathname === `${API_PREFIX}/system/status`) {
    writeJson(res, 200, { ok: true, companion: companion.status() })
    return
  }
  if (url.pathname === `${API_PREFIX}/system/restart`) {
    await companion.restart()
    writeJson(res, 200, { ok: true, companion: companion.status() })
    return
  }
  if (url.pathname === `${API_PREFIX}/settings`) {
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET') {
        const payload: SettingsResponse = {
          ok: true,
          settings: loadSettings(),
          defaults: { ...DEFAULT_SETTINGS },
          languages: LANGUAGES,
          path: settingsFilePath(),
        }
        writeJson(res, 200, payload)
        return
      }
      if (method === 'POST') {
        const raw = await readBody(req)
        const parsed = JSON.parse(raw === '' ? '{}' : raw) as unknown
        const next = saveSettings(parsed)
        ctx.logger?.info?.(`${PLUGIN_ID}: settings updated`)
        writeJson(res, 200, { ok: true, settings: next, defaults: { ...DEFAULT_SETTINGS }, languages: LANGUAGES, path: settingsFilePath() })
        return
      }
      writeJson(res, 405, { ok: false, message: 'use GET or POST' })
    } catch (error) {
      writeJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (url.pathname === `${API_PREFIX}/stop`) {
    try {
      const raw = await readBody(req)
      const parsed = JSON.parse(raw === '' ? '{}' : raw) as { sessionId?: unknown }
      const stopped = stopTurn(ctx, typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined)
      writeJson(res, 200, { ok: stopped })
    } catch (error) {
      writeJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (url.pathname !== `${API_PREFIX}/run`) {
    writeJson(res, 404, { ok: false, message: 'not found' })
    return
  }
  if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
    writeJson(res, 405, { ok: false, message: 'use POST' })
    return
  }

  let args: RunRequest
  try {
    args = await parseRunRequest(req)
  } catch (error) {
    writeJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const sink = makeSink(res)
  try {
    const engine = args.engine ?? loadSettings().engine
    if (engine === 'agent') await runTurn(ctx, sink, args)
    else await runDirect(ctx, sink, args)
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: run failed`, error)
    sink.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    res.end()
  }
}

/**
 * 挂载插件：注册同源路由，plugin unload 时随之摘除。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx: AnyCtx): void {
  // 系统级划词（全局取词 + 置顶浮层）由独立伴生进程承担：它用 dsh 自带的 koffi
  // 调 Win32，崩溃也不会带走本进程。DSH_SELECTION_DISABLE_SYSTEM=1 可整体关闭。
  const companion = createCompanionManager(ctx, {
    enabled: process.env.DSH_SELECTION_DISABLE_SYSTEM !== '1',
  })
  companion.install()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req: any, res: any) => {
          void handleRequest(ctx, req, res, companion).catch((error: unknown) => {
            ctx.logger?.warn?.(`${PLUGIN_ID}: route failure`, error)
            if (res.headersSent !== true) writeJson(res, 500, { ok: false, message: 'internal error' })
            else if (res.writableEnded !== true) res.end()
          })
        },
      }),
    `${PLUGIN_ID}: routes`,
  )
}
