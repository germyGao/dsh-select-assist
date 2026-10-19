import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region src/companion.ts
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
/** 伴生进程入口（本包内的相对路径）。 */
const COMPANION_ENTRY = fileURLToPath(new URL("../companion/main.mjs", import.meta.url));
/** 监听端口上报的日志行：\`... listening on http://127.0.0.1:<port>\`。 */
const PORT_PATTERN = /listening on http:\/\/127\.0\.0\.1:(\d+)/;
/**
* 创建伴生进程管理器。
* @param ctx - 插件上下文。
* @param options - 见 {@link CompanionManagerOptions}。
*/
function createCompanionManager(ctx, options = {}) {
	const enabled = options.enabled !== false;
	const maxRestarts = options.maxRestarts ?? 5;
	const killGraceMs = options.killGraceMs ?? 800;
	const restartDelayMs = options.restartDelayMs ?? ((attempt) => Math.min(3e4, 1e3 * 2 ** attempt));
	let child = null;
	let restartTimer = null;
	let stopping = false;
	let status = {
		state: "stopped",
		restarts: 0
	};
	/** dsh 安装目录里的某个文件（用作 koffi 解析锚点）。 */
	function koffiHint() {
		const argv1 = process.argv[1];
		return typeof argv1 === "string" && argv1.endsWith(".js") ? argv1 : "";
	}
	/** 进程还活着吗（抛 ESRCH = 已经退出）。 */
	function isAlive(pid) {
		if (pid === void 0 || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	/**
	* 兜底强杀。
	*
	* \`ChildProcess.kill()\` 偶尔漏杀（踩过：/system/restart 之后老伴生进程还活着，
	* 于是两个进程各自钩全局鼠标、各自开浮层——用户会看到两个菜单、两个回答窗口，
	* 而插件自己只认得新的那一个）。宽限期内没死就直接 taskkill；本插件只支持 Windows。
	*/
	function forceKill(pid) {
		if (pid === void 0 || pid <= 0 || process.platform !== "win32") return;
		try {
			const killer = spawn("taskkill", [
				"/pid",
				String(pid),
				"/T",
				"/F"
			], {
				stdio: "ignore",
				windowsHide: true
			});
			killer.on("error", () => {});
			killer.unref?.();
		} catch {}
	}
	/** 默认拉起方式：起一个 node 子进程跑伴生进程入口。 */
	function spawnDefault() {
		const port = ctx.webServer?.port;
		const origin = typeof port === "number" && port > 0 ? "http://127.0.0.1:" + port : "http://127.0.0.1:3080";
		return spawn(process.execPath, [COMPANION_ENTRY], {
			env: {
				...process.env,
				DSH_SELECTION_DSH_ORIGIN: origin,
				DSH_SELECTION_KOFFI_HINT: koffiHint()
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
	}
	const spawnChild = options.spawnChild ?? spawnDefault;
	/** 启动伴生进程。 */
	function start() {
		if (!enabled || stopping || child !== null) return;
		status = {
			state: "starting",
			restarts: status.restarts,
			startedAt: Date.now()
		};
		const spawned = spawnChild();
		child = spawned;
		spawned.stdout?.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			const match = PORT_PATTERN.exec(text);
			if (match !== null) {
				status = {
					...status,
					state: "running",
					port: Number(match[1]),
					pid: spawned.pid
				};
				ctx.logger?.info?.("dsh-select-assist: companion ready on " + match[1]);
			}
		});
		spawned.stderr?.on("data", (chunk) => {
			const text = chunk.toString("utf8").trim();
			if (text !== "") status = {
				...status,
				lastError: text.slice(-400)
			};
		});
		spawned.on("exit", (code, signal) => {
			if (child !== spawned) return;
			child = null;
			if (stopping) {
				status = {
					...status,
					state: "stopped",
					pid: void 0
				};
				return;
			}
			status = {
				...status,
				state: "failed",
				pid: void 0,
				lastError: "exited (code=" + String(code) + " signal=" + String(signal) + ")"
			};
			ctx.logger?.warn?.("dsh-select-assist: companion exited (code=" + String(code) + ")");
			if (status.restarts < maxRestarts) {
				status.restarts += 1;
				const delay = restartDelayMs(status.restarts);
				restartTimer = setTimeout(() => {
					restartTimer = null;
					if (!stopping) start();
				}, delay);
				restartTimer.unref?.();
			}
		});
	}
	/** 送走当前伴生进程：先 kill，宽限期内还活着就强杀。 */
	function killChild() {
		const doomed = child;
		child = null;
		if (doomed === null) return;
		const pid = doomed.pid;
		try {
			doomed.kill();
		} catch {}
		if (pid === void 0 || !isAlive(pid)) return;
		setTimeout(() => {
			if (isAlive(pid)) forceKill(pid);
		}, killGraceMs).unref?.();
	}
	/** 停止伴生进程（并取消排队中的自动重启）。 */
	function stop() {
		stopping = true;
		if (restartTimer !== null) {
			clearTimeout(restartTimer);
			restartTimer = null;
		}
		killChild();
		status = {
			...status,
			state: "stopped",
			pid: void 0
		};
	}
	/** 等目标进程真的退出（最多 timeoutMs；超时也不阻塞调用方）。 */
	function waitForExit(target, timeoutMs) {
		if (target === null || target.exitCode !== null || target.signalCode !== null) return Promise.resolve();
		return new Promise((resolve) => {
			let timer = null;
			const finish = () => {
				if (timer !== null) clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(() => {
				target.removeListener("exit", finish);
				finish();
			}, timeoutMs);
			timer.unref?.();
			target.once("exit", finish);
		});
	}
	/**
	* 重启：先送走老进程、**等它真的退出**，再拉起新的。
	*
	* 两处不能省：等退出是为了不出现"新老两个伴生进程同时活着"（两个全局钩子抢鼠标）；
	* 复位 \`stopping\` 是因为它只在 stop() 里置位——不复位的话看门狗就永久失效了
	* （踩过：/system/restart 之后伴生进程再崩也不会自动重启）。
	*/
	async function restart() {
		const doomed = child;
		stop();
		await waitForExit(doomed, killGraceMs + 700);
		stopping = false;
		start();
	}
	return {
		start,
		stop,
		restart,
		status: () => ({
			...status,
			enabled,
			entry: COMPANION_ENTRY
		}),
		/** 把伴生进程绑到插件生命周期上。 */
		install() {
			ctx.effect(() => {
				start();
				return () => {
					stop();
				};
			}, "dsh-select-assist: companion");
		}
	};
}
//#endregion
//#region src/shared/protocol.ts
/**
* 跨 host/client 的稳定协议：路由前缀、请求体、SSE 事件。
*
* host 半边在 webServer 上注册 `/api/dsh-select-assist/*` 路由，
* 浏览器半边用同源 fetch 调用（POST + SSE 流式返回）。
*/
/** 插件 id：bundle 行 name、client bundle 注册 id、日志标签共用。 */
const PLUGIN_ID = "dsh-select-assist";
/** 插件自有 HTTP 路由前缀（host half 注册，client half fetch）。 */
const API_PREFIX = "/api/dsh-select-assist";
/** 一次划词请求允许的最大字符数（超出直接拒绝，避免意外把整篇文档塞给模型）。 */
const MAX_SELECTION_LENGTH = 12e3;
/** 上下文段落允许的最大字符数（系统级取词用 UIA 读选区所在段落，超长直接截断）。 */
const MAX_CONTEXT_LENGTH = 4e3;
/** "跟随原文自动"（中文→英文，其余→中文）——保留旧行为的那个选项。 */
const AUTO_LANGUAGE_ID = "auto";
/** 可选语言（覆盖常用语种；加语言只需在这里加一行）。 */
const LANGUAGES = [
	{
		id: "zh-Hans",
		label: "简体中文",
		prompt: "Simplified Chinese"
	},
	{
		id: "zh-Hant",
		label: "繁體中文",
		prompt: "Traditional Chinese"
	},
	{
		id: "en",
		label: "English",
		prompt: "English"
	},
	{
		id: "ja",
		label: "日本語",
		prompt: "Japanese"
	},
	{
		id: "ko",
		label: "한국어",
		prompt: "Korean"
	},
	{
		id: "fr",
		label: "Français",
		prompt: "French"
	},
	{
		id: "de",
		label: "Deutsch",
		prompt: "German"
	},
	{
		id: "es",
		label: "Español",
		prompt: "Spanish"
	},
	{
		id: "pt",
		label: "Português",
		prompt: "Portuguese"
	},
	{
		id: "ru",
		label: "Русский",
		prompt: "Russian"
	},
	{
		id: "it",
		label: "Italiano",
		prompt: "Italian"
	},
	{
		id: "nl",
		label: "Nederlands",
		prompt: "Dutch"
	},
	{
		id: "pl",
		label: "Polski",
		prompt: "Polish"
	},
	{
		id: "sv",
		label: "Svenska",
		prompt: "Swedish"
	},
	{
		id: "tr",
		label: "Türkçe",
		prompt: "Turkish"
	},
	{
		id: "uk",
		label: "Українська",
		prompt: "Ukrainian"
	},
	{
		id: "ar",
		label: "العربية",
		prompt: "Arabic"
	},
	{
		id: "he",
		label: "עברית",
		prompt: "Hebrew"
	},
	{
		id: "fa",
		label: "فارسی",
		prompt: "Persian"
	},
	{
		id: "hi",
		label: "हिन्दी",
		prompt: "Hindi"
	},
	{
		id: "bn",
		label: "বাংলা",
		prompt: "Bengali"
	},
	{
		id: "th",
		label: "ไทย",
		prompt: "Thai"
	},
	{
		id: "vi",
		label: "Tiếng Việt",
		prompt: "Vietnamese"
	},
	{
		id: "id",
		label: "Bahasa Indonesia",
		prompt: "Indonesian"
	},
	{
		id: "ms",
		label: "Bahasa Melayu",
		prompt: "Malay"
	}
];
/** 取语言选项（未知 id 返回 undefined）。 */
function languageById(id) {
	return LANGUAGES.find((item) => item.id === id);
}
/** 解释规则默认文本。 */
const DEFAULT_EXPLAIN_RULES = [
	"- 结合语境解释选中的文本：它指什么、在这里起什么作用。",
	"- 先用一两句话说明它的含义，再分小节说明关键概念与背景；如果是代码，说明它的作用与执行过程。",
	"- 用 Markdown 组织回答，简洁准确，不要整段复述选中的文本或上文。",
	"- 不要评论有没有提供上文、也不要说明你是怎么判断语境的，直接给出解释。",
	"- 这是一次独立请求：只解释选中的文本，不要提及或评论任何先前的对话内容。"
].join("\n");
/**
* 翻译规则默认文本。
*
* 词/短语按词典条目给（最佳翻译 + 音标 + 其他翻译 + 术语说明），句子/段落给整段译文
* 并额外解释其中的关键术语与缩写——这些都靠规则驱动，模型自己判断是词还是句。
*/
const DEFAULT_TRANSLATE_RULES = [
	"- 先判断选中的是「词/短语」还是「句子/段落」，按对应格式输出。",
	"- 词或短语：按词典条目排版——",
	"  - 第一行：**最佳翻译**（最贴合当前语境的那一个译法）。",
	"  - 第二行：读音，写成 `英 /…/　美 /…/`（国际音标；中文等非表音文字可省略这一行）。",
	"  - 空一行后给 `其他翻译`：2~4 个其他义项，每条一行，写成 `- 译法 — 词性/领域，什么时候用`。",
	"  - 如果它是关键术语或缩写：再给一小节 `术语说明`，缩写先写全称，再用一句话说明它指什么。",
	"- 句子或段落：先给完整译文；如果句中出现了关键术语、缩写或专有名词，再追加小节 `关键术语`，逐条给出全称与一句解释（没有就不写这一节，不要硬凑）。",
	"- 只输出译文与上述小节：不要前言、不要复述原文、不要说明你是怎么判断词还是句子的。",
	"- 保留原文的格式、换行、行内代码与专有名词；如果原文已经是目标语言，原样返回。"
].join("\n");
/** 总结规则默认文本。 */
const DEFAULT_SUMMARIZE_RULES = [
	"- 先用一句话给出核心结论，再分「要点」小节逐条列出关键信息（每条一行，最多 5 条）。",
	"- 如果原文有明确的结构（章节、列表、对话轮次），保留它的大致层次再压缩。",
	"- 只保留原文真正说了的内容：不要补充背景知识，不要评价好坏，不要给建议。",
	"- 数字、专有名词、结论性判断必须原样保留，不要模糊成「一些」「若干」。",
	"- 用 Markdown 组织回答；原文很短时直接给一句话总结，不要硬凑要点。",
	"- 这是一次独立请求：只总结选中的文本，不要提及或评论任何先前的对话内容。"
].join("\n");
/** 语速/音量的合法区间。 */
const SPEAK_RATE_RANGE = {
	min: -10,
	max: 10
};
const SPEAK_VOLUME_RANGE = {
	min: 0,
	max: 100
};
/** 默认设置。 */
const DEFAULT_SETTINGS = {
	engine: "direct",
	targetLanguage: AUTO_LANGUAGE_ID,
	fallbackLanguage: AUTO_LANGUAGE_ID,
	explainRules: DEFAULT_EXPLAIN_RULES,
	translateRules: DEFAULT_TRANSLATE_RULES,
	summarizeRules: DEFAULT_SUMMARIZE_RULES,
	translateModel: null,
	explainModel: null,
	summarizeModel: null,
	speakRate: -1,
	speakVolume: 100
};
/** 规则文本上限（避免把提示词撑爆）。 */
const MAX_RULES_LENGTH = 4e3;
/**
* 把任意输入规整成合法设置（缺项补默认、非法值丢弃）。
* 主客两边共用：客户端在提交前也用它做一次本地校验。
*/
function normalizeSettings(input) {
	const raw = input ?? {};
	const language = (value, fallback) => {
		const id = typeof value === "string" ? value : "";
		if (id === "auto") return id;
		return languageById(id) === void 0 ? fallback : id;
	};
	const rules = (value, fallback) => {
		if (typeof value !== "string") return fallback;
		const text = value.replace(/\r\n/g, "\n").trim();
		if (text === "") return fallback;
		return text.length > 4e3 ? text.slice(0, MAX_RULES_LENGTH) : text;
	};
	const seat = (value) => {
		if (value === null || value === void 0 || typeof value !== "object") return null;
		const candidate = value;
		const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
		const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
		if (provider === "" || model === "") return null;
		const effort = typeof candidate.reasoningEffort === "string" ? candidate.reasoningEffort.trim() : "";
		return {
			provider,
			model,
			...effort === "" ? {} : { reasoningEffort: effort }
		};
	};
	const number = (value, fallback, range) => {
		const parsed = typeof value === "number" ? value : NaN;
		if (!Number.isFinite(parsed)) return fallback;
		return Math.max(range.min, Math.min(range.max, Math.round(parsed)));
	};
	return {
		engine: raw.engine === "agent" ? "agent" : "direct",
		targetLanguage: language(raw.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
		fallbackLanguage: language(raw.fallbackLanguage, DEFAULT_SETTINGS.fallbackLanguage),
		explainRules: rules(raw.explainRules, DEFAULT_SETTINGS.explainRules),
		translateRules: rules(raw.translateRules, DEFAULT_SETTINGS.translateRules),
		summarizeRules: rules(raw.summarizeRules, DEFAULT_SETTINGS.summarizeRules),
		translateModel: seat(raw.translateModel),
		explainModel: seat(raw.explainModel),
		summarizeModel: seat(raw.summarizeModel),
		speakRate: number(raw.speakRate, DEFAULT_SETTINGS.speakRate, SPEAK_RATE_RANGE),
		speakVolume: number(raw.speakVolume, DEFAULT_SETTINGS.speakVolume, SPEAK_VOLUME_RANGE)
	};
}
//#endregion
//#region src/prompt.ts
/**
* 提示词构造：翻译 / 解释。
*
* 这里只负责「用户会怎么问」——真正干活的是 Harness 自己的 agent
* （同一个 agent loop、同一套系统提示与工具），因此行为与在 DSH 里
* 手敲同一句话完全一致。
*
* 「要求」那一段是**用户可编辑**的（设置页里改，存在 dsh-select-assist.json）：
* 解释/翻译的规则就是要交给模型的规则信息，不锁死在代码里。
*/
/** 文本里是否含 CJK 汉字。 */
function hasCjk(text) {
	return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}
/** 文本里是否含日文假名。 */
function hasKana(text) {
	return /[\u3040-\u30ff]/.test(text);
}
/** 文本里是否含韩文谚文。 */
function hasHangul(text) {
	return /[\uac00-\ud7af]/.test(text);
}
/**
* 默认目标语言：源文本是中文 → 译成英文；否则译成中文。
* @param text - 选中文本。
* @param locale - 界面语言（决定中文写成「中文」还是「Chinese」）。
*/
function defaultTarget(text, locale) {
	return hasCjk(text) ? locale === "en" ? "English" : "英文" : locale === "en" ? "Chinese (Simplified)" : "中文";
}
/** 语言 id → 提示词里的语言名（中文界面下中/英用中文写法，其余用英文名）。 */
function languagePromptName(id, locale) {
	const option = languageById(id);
	if (option === void 0) return locale === "en" ? "Chinese (Simplified)" : "中文";
	if (locale === "en") return option.prompt;
	if (option.id === "zh-Hans") return "中文";
	if (option.id === "en") return "英文";
	return option.prompt;
}
/** 文本看着像不像某种语言（只做能可靠判断的几种，其余一律"不像"）。 */
function looksLikeLanguage(text, id) {
	if (id === "zh-Hans" || id === "zh-Hant") return hasCjk(text) && !hasKana(text);
	if (id === "ja") return hasKana(text);
	if (id === "ko") return hasHangul(text);
	return false;
}
/**
* 这一轮到底翻成什么语言。
*
* - 「默认翻译至」= auto：保持旧行为（中文→英文，其余→中文）；
* - 选了具体语言：就是它；要是原文已经是这个语言，改用「反向目标语言」
*   （fallback 也是 auto 时取镜像：原文是中文就译英文，否则译中文）。
*/
function resolveTarget(text, settings, locale) {
	const requested = settings.targetLanguage;
	if (requested === "auto") return defaultTarget(text, locale);
	if (!looksLikeLanguage(text, requested)) return languagePromptName(requested, locale);
	const fallback = settings.fallbackLanguage;
	if (fallback === "auto" || fallback === requested) return defaultTarget(text, locale);
	return languagePromptName(fallback, locale);
}
/** 取规则文本（空串退回默认）。 */
function rulesOf(value, fallback) {
	const text = typeof value === "string" ? value.trim() : "";
	return text === "" ? fallback : text;
}
/** 提示词骨架（各语言一套）。 */
function skeleton(locale, action) {
	if (locale === "en") {
		const shared = {
			heading: "Requirements:",
			textLabel: "Selected text:",
			contextLabel: "Surrounding text (context only):"
		};
		if (action === "translate") return {
			intro: "Translate the text below into {target}.",
			...shared
		};
		if (action === "summarize") return {
			intro: "Summarize the text below.",
			...shared
		};
		return {
			intro: "Explain the text below.",
			...shared,
			contextLabel: "Surrounding text:"
		};
	}
	const shared = {
		heading: "要求：",
		textLabel: "选中的文本：",
		contextLabel: "上文（仅作语境，不要翻译）："
	};
	if (action === "translate") return {
		intro: "把下面的文本翻译成{target}。",
		...shared
	};
	if (action === "summarize") return {
		intro: "总结下面这段文本。",
		...shared
	};
	return {
		intro: "解释下面这段文本。",
		...shared,
		contextLabel: "上文："
	};
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
function buildPrompt(action, text, target, locale, context = "", rules = "") {
	const trimmed = typeof context === "string" ? context.trim() : "";
	const parts = skeleton(locale, action);
	const requirement = rulesOf(rules, action === "translate" ? DEFAULT_TRANSLATE_RULES : action === "summarize" ? DEFAULT_SUMMARIZE_RULES : DEFAULT_EXPLAIN_RULES);
	const lines = [
		parts.intro.replace("{target}", target),
		"",
		parts.heading,
		requirement,
		"",
		parts.textLabel,
		"```",
		text,
		"```"
	];
	if (trimmed !== "") lines.push("", parts.contextLabel, "```", trimmed, "```");
	return lines.join("\n");
}
//#endregion
//#region src/settings.ts
/**
* 插件设置的宿主侧存取。
*
* 存哪儿：DSH home 下的 \`dsh-select-assist.json\`（\`DSH_HOME\` 优先，否则 \`~/.dsh\`）。
* 为什么不走 \`ctx.settings\`：那是宿主设置文档的一层，写进去需要宿主挂载 settings provider
* 与 schemastery schema；本插件要保持"零官方依赖、任何 profile 都能跑"，所以自带一个小
* 文件 + 自带 HTTP 路由（浏览器半边用同源 fetch 读写）。
*
* 读写都很便宜（几百字节），所以每次跑一轮前现读，不做缓存——用户改完设置立刻生效。
*/
/** 设置文件路径（\`DSH_HOME\` 优先）。 */
function settingsFilePath() {
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "dsh-select-assist.json");
}
/** 读设置（文件缺失/损坏都退回默认值，绝不让设置拖垮划词）。 */
function loadSettings() {
	try {
		const raw = readFileSync(settingsFilePath(), "utf8");
		return normalizeSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}
/** 写设置（先写临时文件再改名，避免半截文件）。 */
function saveSettings(patch) {
	const merged = normalizeSettings({
		...loadSettings(),
		...typeof patch === "object" && patch !== null ? patch : {}
	});
	try {
		const file = settingsFilePath();
		mkdirSync(dirname(file), { recursive: true });
		const temporary = file + ".tmp";
		writeFileSync(temporary, JSON.stringify(merged, null, 2), "utf8");
		renameSync(temporary, file);
	} catch {}
	return merged;
}
//#endregion
//#region src/index.ts
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
/** Cordis 插件名。 */
const name = PLUGIN_ID;
/**
* 硬依赖：路由宿主、agent 注册表、LLM 服务。
* （model route 默认值经 ctx.get('agentDefaultModel') 可选读取。）
*
* `agents` 只在 engine='agent' 那条老路径上用到；`llm` 是快路径的唯一依赖。
*/
const inject = [
	"webServer",
	"agents",
	"llm"
];
/** 每个会话串行执行，避免两次划词互相打断（仅 engine='agent' 路径）。 */
const queues = /* @__PURE__ */ new Map();
/** 正在跑的直连请求：runId → 中止器（`/stop` 用）。 */
const runs = /* @__PURE__ */ new Map();
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
function createUserMessage(prompt) {
	return Object.freeze({
		id: randomUUID(),
		role: "user",
		content: Object.freeze([Object.freeze({
			type: "text",
			text: prompt
		})]),
		source: Object.freeze({
			kind: "user",
			rpcId: randomUUID()
		})
	});
}
/** 把值以 lossless JSON 写进响应；响应已结束则静默丢弃。 */
function makeSink(res) {
	return { send(payload) {
		if (res.writableEnded === true) return;
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	} };
}
/** 读满请求体（上限 1 MiB，防御性上限，真正的长度校验在正文里）。 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.byteLength;
		if (size > 1048576) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** 读取 `{ action, text, ... }` 请求体。 */
async function parseRunRequest(req) {
	const raw = await readBody(req);
	const parsed = JSON.parse(raw === "" ? "{}" : raw);
	const action = parsed.action === "translate" ? "translate" : parsed.action === "summarize" ? "summarize" : parsed.action === "explain" ? "explain" : void 0;
	if (action === void 0) throw new Error("action must be \"translate\", \"explain\" or \"summarize\"");
	const text = typeof parsed.text === "string" ? parsed.text : "";
	if (text.trim() === "") throw new Error("text is empty");
	if (text.length > 12e3) throw new Error(`text is longer than ${MAX_SELECTION_LENGTH} characters`);
	const locale = parsed.locale === "en" ? "en" : "zh";
	const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
	return {
		action,
		text,
		locale,
		...context === "" ? {} : { context: context.slice(0, MAX_CONTEXT_LENGTH) },
		...typeof parsed.cwd === "string" && parsed.cwd !== "" ? { cwd: parsed.cwd } : {},
		...typeof parsed.provider === "string" && parsed.provider !== "" ? { provider: parsed.provider } : {},
		...typeof parsed.model === "string" && parsed.model !== "" ? { model: parsed.model } : {},
		...typeof parsed.target === "string" && parsed.target !== "" ? { target: parsed.target } : {},
		...parsed.engine === "direct" || parsed.engine === "agent" ? { engine: parsed.engine } : {}
	};
}
/**
* 决定这条 agent 用的模型 route：优先跟随当前 DSH 会话的模型，
* 否则用部署默认（`ctx.agentDefaultModel`），再否则交给 agent loop 自己的默认。
*/
function resolveAgentOptions(ctx, request, settings) {
	const seat = request.action === "translate" ? settings.translateModel : request.action === "summarize" ? settings.summarizeModel : settings.explainModel;
	if (seat !== null) return {
		provider: seat.provider,
		model: seat.model,
		...seat.reasoningEffort === void 0 ? {} : { reasoningEffort: seat.reasoningEffort }
	};
	if (request.provider !== void 0 && request.model !== void 0) return {
		provider: request.provider,
		model: request.model
	};
	return defaultAgentOptions(ctx);
}
/** 部署默认模型 route（agentDefaultModel 服务缺席时返回 undefined）。 */
function defaultAgentOptions(ctx) {
	try {
		const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.();
		if (typeof selection?.provider === "string" && typeof selection.model === "string") return {
			provider: selection.provider,
			model: selection.model
		};
	} catch {}
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
async function ensureAgent(ctx, cwd, request, settings) {
	const agentOptions = resolveAgentOptions(ctx, request, settings);
	const effectiveCwd = cwd ?? process.cwd();
	const sessionId = `session-${randomUUID()}`;
	const handle = await ctx.agents.create({
		sessionId,
		meta: { cwd: effectiveCwd },
		...agentOptions === void 0 ? {} : { agentOptions }
	});
	await ensureUngrouped(ctx, sessionId);
	return handle;
}
/** 串行执行同一 handle 上的一轮对话。 */
function enqueue(sessionId, job) {
	const next = (queues.get(sessionId) ?? Promise.resolve()).then(job, job);
	queues.set(sessionId, next.then(() => void 0, () => void 0));
	return next;
}
/** 从本轮起点向后找最后一条 assistant 消息的文本（服务端权威结果）。 */
function lastAssistantText(session, fromSeq) {
	const end = Number(session.seq ?? 0);
	for (let seq = end - 1; seq >= fromSeq; seq -= 1) {
		let event;
		try {
			event = session.eventAt(seq);
		} catch {
			continue;
		}
		if (event?.type !== "assistant/message") continue;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) continue;
		const text = content.filter((block) => {
			const candidate = block;
			return candidate?.type === "text" && typeof candidate.text === "string";
		}).map((block) => block.text).join("");
		if (text.trim() !== "") return text;
	}
	return "";
}
/**
* 决定这条请求打到哪个模型：设置里的座位 > 请求自带的 route > 部署默认。
* 与 agent 路径共用同一套优先级（resolveAgentOptions）。
*/
function resolveDirectCall(ctx, request, settings) {
	const seat = request.action === "translate" ? settings.translateModel : request.action === "summarize" ? settings.summarizeModel : settings.explainModel;
	if (seat !== null) return {
		provider: seat.provider,
		model: seat.model,
		...seat.reasoningEffort === void 0 ? {} : { reasoningEffort: seat.reasoningEffort }
	};
	if (request.provider !== void 0 && request.model !== void 0) return {
		provider: request.provider,
		model: request.model
	};
	return defaultAgentOptions(ctx);
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
async function runDirect(ctx, sink, args) {
	const settings = loadSettings();
	const llm = ctx.get?.("llm");
	if (llm === void 0 || llm === null || typeof llm.stream !== "function") throw new Error("llm service is unavailable");
	const call = resolveDirectCall(ctx, args, settings);
	if (call === void 0) throw new Error("no model route: set one in the plugin settings or in the current session");
	const locale = args.locale ?? "zh";
	const target = args.target ?? resolveTarget(args.text, settings, locale);
	const rules = args.action === "translate" ? settings.translateRules : args.action === "summarize" ? settings.summarizeRules : settings.explainRules;
	const prompt = buildPrompt(args.action, args.text, target, locale, args.context ?? "", rules);
	const runId = `run-${randomUUID()}`;
	const controller = new AbortController();
	runs.set(runId, controller);
	sink.send({
		type: "session",
		sessionId: runId
	});
	let text = "";
	try {
		const options = {
			provider: call.provider,
			model: call.model,
			...call.reasoningEffort === void 0 ? {} : { reasoningEffort: call.reasoningEffort },
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: prompt
				}]
			}],
			signal: controller.signal
		};
		for await (const chunk of llm.stream(options)) {
			if (chunk === null || typeof chunk !== "object") continue;
			if (chunk.type === "text-delta" && typeof chunk.text === "string") {
				text += chunk.text;
				sink.send({
					type: "delta",
					text: chunk.text
				});
				continue;
			}
			if (chunk.type !== "finish") continue;
			const kind = chunk.reason?.kind;
			if (kind === "error" || kind === "aborted") {
				const failure = chunk.reason?.failure;
				const message = typeof failure?.message === "string" && failure.message !== "" ? failure.message : "model call failed";
				throw new Error(message);
			}
		}
	} finally {
		runs.delete(runId);
	}
	if (text.trim() === "") throw new Error("model produced no text output");
	sink.send({
		type: "done",
		sessionId: runId,
		text
	});
}
/** 跑一轮：把 agent 的 assistant 文本增量以 SSE 推给调用方。 */
async function runTurn(ctx, sink, args) {
	const settings = loadSettings();
	const agent = (await ensureAgent(ctx, args.cwd, args, settings)).agent;
	const session = agent.session;
	if (session === void 0) throw new Error("agent has no session");
	const sessionId = session.id;
	sink.send({
		type: "session",
		sessionId
	});
	const fromSeq = Number(session.seq ?? 0);
	const locale = args.locale ?? "zh";
	const target = args.target ?? resolveTarget(args.text, settings, locale);
	const rules = args.action === "translate" ? settings.translateRules : args.action === "summarize" ? settings.summarizeRules : settings.explainRules;
	const prompt = buildPrompt(args.action, args.text, target, locale, args.context ?? "", rules);
	/** 本轮事件轨迹（诊断用：失败时能看出卡在哪一步）。 */
	const trace = [];
	/** agent 自己上报的失败（agent/error）；kick() 会把异常吞掉，只能从这里拿到原因。 */
	let agentFailure;
	const offAgentError = listenAgentError(agent, (message) => {
		agentFailure = message;
	});
	const off = ctx.on("session/event", (eventSession, event) => {
		if (eventSession !== session) return;
		if (typeof event?.type === "string") {
			trace.push(event.type);
			if (trace.length > 24) trace.shift();
		}
		if (event?.type !== "assistant/chunk") return;
		const chunk = event.data?.chunk;
		if (chunk?.type === "text-delta" && typeof chunk.text === "string") sink.send({
			type: "delta",
			text: chunk.text
		});
	});
	let text = "";
	try {
		await enqueue(sessionId, async () => {
			agent.followup(createUserMessage(prompt));
			await agent.whenIdle();
		});
		text = lastAssistantText(session, fromSeq);
		await flushSession(ctx, session);
	} finally {
		off();
		offAgentError();
	}
	if (text.trim() === "") {
		const reason = agentFailure ?? `agent produced no assistant text (events: ${trace.join(", ") || "none"})`;
		throw new Error(reason);
	}
	sink.send({
		type: "done",
		sessionId,
		text
	});
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
async function ensureUngrouped(ctx, sessionId) {
	try {
		const registry = ctx.get?.("workspaceRegistry");
		if (registry === void 0 || registry === null) return "unknown";
		const workspaces = typeof registry.list === "function" ? registry.list() ?? [] : [];
		for (const workspace of workspaces) {
			const ids = workspace?.sessionIds;
			if (!Array.isArray(ids) || !ids.includes(sessionId)) continue;
			if (typeof workspace?.detachSession !== "function") return "unknown";
			await workspace.detachSession(sessionId);
			return "detached";
		}
		return "ungrouped";
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: keeping ${sessionId} ungrouped failed`, error);
		return "unknown";
	}
}
/** 等一轮持久化落盘（服务缺席或失败都不影响本轮作答）。 */
async function flushSession(ctx, session) {
	try {
		await ctx.get?.("sessions")?.flush?.(session);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: session flush failed`, error);
	}
}
/** 订阅 agent 自己的失败上报；事件缺席或上下文不可用时安静跳过。 */
function listenAgentError(agent, report) {
	try {
		const agentCtx = agent.ctx;
		if (typeof agentCtx?.on !== "function") return () => {};
		return agentCtx.on("agent/error", (payload) => {
			const message = payload?.error?.message ?? payload?.message;
			report(typeof message === "string" && message !== "" ? message : "agent reported an error");
		});
	} catch {
		return () => {};
	}
}
/** 停止一轮：直连请求走 AbortController，agent 请求走 agent.cancel。 */
function stopTurn(ctx, sessionId) {
	if (sessionId === void 0) return false;
	const direct = runs.get(sessionId);
	if (direct !== void 0) {
		direct.abort();
		return true;
	}
	const agent = ctx.agents.get?.(sessionId);
	if (agent?.cancel === void 0) return false;
	agent.cancel({ kind: "user" }, { keepInbox: true });
	return true;
}
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}
/** 路由总入口。 */
async function handleRequest(ctx, req, res, companion) {
	const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
	if (url.pathname === `/api/dsh-select-assist/ping`) {
		writeJson(res, 200, {
			ok: true,
			plugin: PLUGIN_ID
		});
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/system/status`) {
		writeJson(res, 200, {
			ok: true,
			companion: companion.status()
		});
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/system/restart`) {
		await companion.restart();
		writeJson(res, 200, {
			ok: true,
			companion: companion.status()
		});
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/settings`) {
		const method = String(req.method ?? "GET").toUpperCase();
		try {
			if (method === "GET") {
				writeJson(res, 200, {
					ok: true,
					settings: loadSettings(),
					defaults: { ...DEFAULT_SETTINGS },
					languages: LANGUAGES,
					path: settingsFilePath()
				});
				return;
			}
			if (method === "POST") {
				const raw = await readBody(req);
				const next = saveSettings(JSON.parse(raw === "" ? "{}" : raw));
				ctx.logger?.info?.(`${PLUGIN_ID}: settings updated`);
				writeJson(res, 200, {
					ok: true,
					settings: next,
					defaults: { ...DEFAULT_SETTINGS },
					languages: LANGUAGES,
					path: settingsFilePath()
				});
				return;
			}
			writeJson(res, 405, {
				ok: false,
				message: "use GET or POST"
			});
		} catch (error) {
			writeJson(res, 400, {
				ok: false,
				message: error instanceof Error ? error.message : String(error)
			});
		}
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/stop`) {
		try {
			const raw = await readBody(req);
			const parsed = JSON.parse(raw === "" ? "{}" : raw);
			writeJson(res, 200, { ok: stopTurn(ctx, typeof parsed.sessionId === "string" ? parsed.sessionId : void 0) });
		} catch (error) {
			writeJson(res, 400, {
				ok: false,
				message: error instanceof Error ? error.message : String(error)
			});
		}
		return;
	}
	if (url.pathname !== `/api/dsh-select-assist/run`) {
		writeJson(res, 404, {
			ok: false,
			message: "not found"
		});
		return;
	}
	if (String(req.method ?? "GET").toUpperCase() !== "POST") {
		writeJson(res, 405, {
			ok: false,
			message: "use POST"
		});
		return;
	}
	let args;
	try {
		args = await parseRunRequest(req);
	} catch (error) {
		writeJson(res, 400, {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		});
		return;
	}
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive"
	});
	const sink = makeSink(res);
	try {
		if ((args.engine ?? loadSettings().engine) === "agent") await runTurn(ctx, sink, args);
		else await runDirect(ctx, sink, args);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: run failed`, error);
		sink.send({
			type: "error",
			message: error instanceof Error ? error.message : String(error)
		});
	} finally {
		res.end();
	}
}
/**
* 挂载插件：注册同源路由，plugin unload 时随之摘除。
* @param ctx - 宿主 Cordis 上下文。
*/
function apply(ctx) {
	const companion = createCompanionManager(ctx, { enabled: process.env.DSH_SELECTION_DISABLE_SYSTEM !== "1" });
	companion.install();
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => {
			handleRequest(ctx, req, res, companion).catch((error) => {
				ctx.logger?.warn?.(`${PLUGIN_ID}: route failure`, error);
				if (res.headersSent !== true) writeJson(res, 500, {
					ok: false,
					message: "internal error"
				});
				else if (res.writableEnded !== true) res.end();
			});
		}
	}), `${PLUGIN_ID}: routes`);
}
//#endregion
export { apply, inject, name };
