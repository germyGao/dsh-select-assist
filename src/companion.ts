/**
 * 系统级划词伴生进程的生命周期管理。
 *
 * 插件本体跑在 dsh 进程里，做不了"全局划词 + 置顶浮层"这类系统级动作，
 * 于是把这块交给一个独立的 Node 伴生进程（companion/main.mjs，用 dsh 自带的
 * koffi 调 Win32）。这里只负责：按需拉起、读取它上报的端口、异常退出后退避重启、
 * 插件卸载时收尸。
 *
 * 伴生进程崩溃或不可用，只影响"系统级划词"这一条能力，DSH 本体与页内划词不受影响。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 伴生进程入口（本包内的相对路径）。 */
const COMPANION_ENTRY = fileURLToPath(new URL('../companion/main.mjs', import.meta.url))

/** 伴生进程对外状态。 */
export interface CompanionStatus {
  state: 'stopped' | 'starting' | 'running' | 'failed'
  port?: number
  pid?: number
  restarts: number
  lastError?: string
  startedAt?: number
}

/** 插件侧上下文里本模块用到的最小面。 */
export interface CompanionContext {
  logger?: { warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
  effect: (callback: () => unknown, label?: string) => unknown
  webServer: { port?: number }
  get?: (name: string) => any
}

/** 监听端口上报的日志行：\`... listening on http://127.0.0.1:<port>\`。 */
const PORT_PATTERN = /listening on http:\/\/127\.0\.0\.1:(\d+)/

/** 管理器可选注入项（给单测留的口子：换掉 spawn、退避时长与强杀宽限）。 */
export interface CompanionManagerOptions {
  /** 关掉伴生进程（上层按环境变量传入）。 */
  enabled?: boolean
  /** 崩溃后最多自动重启几次。 */
  maxRestarts?: number
  /** 拉起伴生进程（默认真起一个 node 子进程）。 */
  spawnChild?: () => ChildProcess
  /** 第 attempt 次重启前等多久（默认 1s / 2s / 4s … 上限 30s）。 */
  restartDelayMs?: (attempt: number) => number
  /** stop() 之后给 kill 多少时间生效（默认 800ms），超时就直接 taskkill。 */
  killGraceMs?: number
}

/**
 * 创建伴生进程管理器。
 * @param ctx - 插件上下文。
 * @param options - 见 {@link CompanionManagerOptions}。
 */
export function createCompanionManager(
  ctx: CompanionContext,
  options: CompanionManagerOptions = {},
) {
  const enabled = options.enabled !== false
  const maxRestarts = options.maxRestarts ?? 5
  const killGraceMs = options.killGraceMs ?? 800
  const restartDelayMs = options.restartDelayMs ?? ((attempt: number) => Math.min(30_000, 1000 * 2 ** attempt))
  let child: ChildProcess | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let stopping = false
  let status: CompanionStatus = { state: 'stopped', restarts: 0 }

  /** dsh 安装目录里的某个文件（用作 koffi 解析锚点）。 */
  function koffiHint(): string {
    const argv1 = process.argv[1]
    return typeof argv1 === 'string' && argv1.endsWith('.js') ? argv1 : ''
  }

  /** 进程还活着吗（抛 ESRCH = 已经退出）。 */
  function isAlive(pid: number | undefined): boolean {
    if (pid === undefined || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * 兜底强杀。
   *
   * \`ChildProcess.kill()\` 偶尔漏杀（踩过：/system/restart 之后老伴生进程还活着，
   * 于是两个进程各自钩全局鼠标、各自开浮层——用户会看到两个菜单、两个回答窗口，
   * 而插件自己只认得新的那一个）。宽限期内没死就直接 taskkill；本插件只支持 Windows。
   */
  function forceKill(pid: number | undefined): void {
    if (pid === undefined || pid <= 0 || process.platform !== 'win32') return
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {})
      killer.unref?.()
    } catch {
      /* 没有 taskkill 就只能算了 */
    }
  }

  /** 默认拉起方式：起一个 node 子进程跑伴生进程入口。 */
  function spawnDefault(): ChildProcess {
    const port = ctx.webServer?.port
    const origin = typeof port === 'number' && port > 0 ? 'http://127.0.0.1:' + port : 'http://127.0.0.1:3080'
    return spawn(process.execPath, [COMPANION_ENTRY], {
      env: {
        ...process.env,
        DSH_SELECTION_DSH_ORIGIN: origin,
        DSH_SELECTION_KOFFI_HINT: koffiHint(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }
  const spawnChild = options.spawnChild ?? spawnDefault

  /** 启动伴生进程。 */
  function start(): void {
    if (!enabled || stopping || child !== null) return
    status = { state: 'starting', restarts: status.restarts, startedAt: Date.now() }
    const spawned = spawnChild()
    child = spawned
    spawned.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      const match = PORT_PATTERN.exec(text)
      if (match !== null) {
        status = { ...status, state: 'running', port: Number(match[1]), pid: spawned.pid }
        ctx.logger?.info?.('dsh-select-assist: companion ready on ' + match[1])
      }
    })
    spawned.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') status = { ...status, lastError: text.slice(-400) }
    })
    spawned.on('exit', (code, signal) => {
      // 只认"当前这个孩子"。重启时老进程的 exit 可能迟到（kill 没立刻生效、taskkill 补刀
      // 之后才退），那时 child 已经是新进程了——不认身份就会把新进程的引用和状态一起抹掉
      // （踩过：重启之后状态莫名变 stopped，看门狗也跟着失效）。
      if (child !== spawned) return
      child = null
      if (stopping) {
        status = { ...status, state: 'stopped', pid: undefined }
        return
      }
      status = { ...status, state: 'failed', pid: undefined, lastError: 'exited (code=' + String(code) + ' signal=' + String(signal) + ')' }
      ctx.logger?.warn?.('dsh-select-assist: companion exited (code=' + String(code) + ')')
      if (status.restarts < maxRestarts) {
        status.restarts += 1
        const delay = restartDelayMs(status.restarts)
        restartTimer = setTimeout(() => {
          restartTimer = null
          if (!stopping) start()
        }, delay)
        restartTimer.unref?.()
      }
    })
  }

  /** 送走当前伴生进程：先 kill，宽限期内还活着就强杀。 */
  function killChild(): void {
    const doomed = child
    child = null
    if (doomed === null) return
    const pid = doomed.pid
    try {
      doomed.kill()
    } catch {
      /* 已退出 */
    }
    if (pid === undefined || !isAlive(pid)) return
    const timer = setTimeout(() => {
      if (isAlive(pid)) forceKill(pid)
    }, killGraceMs)
    timer.unref?.()
  }

  /** 停止伴生进程（并取消排队中的自动重启）。 */
  function stop(): void {
    stopping = true
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    killChild()
    status = { ...status, state: 'stopped', pid: undefined }
  }

  /** 等目标进程真的退出（最多 timeoutMs；超时也不阻塞调用方）。 */
  function waitForExit(target: ChildProcess | null, timeoutMs: number): Promise<void> {
    if (target === null || target.exitCode !== null || target.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        target.removeListener('exit', finish)
        finish()
      }, timeoutMs)
      timer.unref?.()
      target.once('exit', finish)
    })
  }

  /**
   * 重启：先送走老进程、**等它真的退出**，再拉起新的。
   *
   * 两处不能省：等退出是为了不出现"新老两个伴生进程同时活着"（两个全局钩子抢鼠标）；
   * 复位 \`stopping\` 是因为它只在 stop() 里置位——不复位的话看门狗就永久失效了
   * （踩过：/system/restart 之后伴生进程再崩也不会自动重启）。
   */
  async function restart(): Promise<void> {
    const doomed = child
    stop()
    await waitForExit(doomed, killGraceMs + 700)
    stopping = false
    start()
  }

  return {
    start,
    stop,
    restart,
    status: () => ({ ...status, enabled, entry: COMPANION_ENTRY }),
    /** 把伴生进程绑到插件生命周期上。 */
    install(): void {
      ctx.effect(() => {
        start()
        return () => {
          stop()
        }
      }, 'dsh-select-assist: companion')
    },
  }
}
