window.__ModuleLoader__.load({
	id: "dsh-selection-tools",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/protocol.ts
		/** 插件自有 HTTP 路由前缀（host half 注册，client half fetch）。 */
		const API_PREFIX = "/api/dsh-selection-tools";
		/** 一次划词请求允许的最大字符数（超出直接拒绝，避免意外把整篇文档塞给模型）。 */
		const MAX_SELECTION_LENGTH = 12e3;
		/** 上下文段落允许的最大字符数（系统级取词用 UIA 读选区所在段落，超长直接截断）。 */
		const MAX_CONTEXT_LENGTH = 4e3;
		/** 解析一帧 SSE 的 data 负载；不是本协议的帧返回 undefined。 */
		function parseRunEvent(raw) {
			try {
				const value = JSON.parse(raw);
				if (value === null || typeof value !== "object") return void 0;
				if (typeof value.type !== "string") return void 0;
				return value;
			} catch {
				return;
			}
		}
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
			summarizeModel: null
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
			return {
				engine: raw.engine === "agent" ? "agent" : "direct",
				targetLanguage: language(raw.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
				fallbackLanguage: language(raw.fallbackLanguage, DEFAULT_SETTINGS.fallbackLanguage),
				explainRules: rules(raw.explainRules, DEFAULT_SETTINGS.explainRules),
				translateRules: rules(raw.translateRules, DEFAULT_SETTINGS.translateRules),
				summarizeRules: rules(raw.summarizeRules, DEFAULT_SETTINGS.summarizeRules),
				translateModel: seat(raw.translateModel),
				explainModel: seat(raw.explainModel),
				summarizeModel: seat(raw.summarizeModel)
			};
		}
		//#endregion
		//#region src/client/api.ts
		/**
		* 浏览器半边对宿主插件路由的调用层：同源 fetch + SSE 帧解析，
		* 外加从官方 client 服务读取「当前会话/当前模型」的只读快照。
		*/
		/** 从字符串里取第一个非空字符串字段。 */
		function pickString(value) {
			return typeof value === "string" && value !== "" ? value : void 0;
		}
		/**
		* 读取当前会话的 cwd 与生效模型（与 DSH 输入框模型座位同源）。
		* 任何一步缺席都安静降级——宿主会回落到部署默认模型。
		* @param ctx - 客户端 Cordis 上下文。
		*/
		function readCurrentContext(ctx) {
			const result = {};
			try {
				const snapshot = (ctx.get?.("sessions"))?.list?.getSnapshot?.();
				const current = pickString(snapshot?.current);
				if (current === void 0) return result;
				result.sessionId = current;
				result.cwd = pickString(snapshot?.byId?.[current]?.cwd);
				const selection = ctx.get?.("modelDirectories")?.directoryFor?.(current)?.store?.getSnapshot?.()?.current;
				result.provider = pickString(selection?.provider);
				result.model = pickString(selection?.model);
			} catch {}
			return result;
		}
		/** 界面语言：与宿主 html lang / 浏览器语言一致。 */
		function detectLocale() {
			try {
				const lang = String(document?.documentElement?.lang ?? "");
				if (lang.toLowerCase().startsWith("zh")) return "zh";
				if (lang !== "") return "en";
				return String(navigator?.language ?? "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
			} catch {
				return "zh";
			}
		}
		/**
		* 发起一轮划词翻译/解释。
		* @param action - 菜单动作。
		* @param text - 选中文本。
		* @param ctx - 客户端上下文（读取当前会话）。
		* @param context - 选中文本所在的上下文段落（页内路径取块级元素文本；没有就传空串）。
		* @returns abort：中止本次流（宿主侧仍会跑完，除非另行调用 stop）。
		*/
		function startRun(action, text, ctx, context, handlers) {
			const controller = new AbortController();
			let sessionId;
			const session = readCurrentContext(ctx);
			const trimmed = typeof context === "string" ? context.trim() : "";
			const request = {
				action,
				text,
				locale: detectLocale(),
				...trimmed === "" ? {} : { context: trimmed.slice(0, MAX_CONTEXT_LENGTH) },
				...session.cwd === void 0 ? {} : { cwd: session.cwd },
				...session.provider === void 0 ? {} : { provider: session.provider },
				...session.model === void 0 ? {} : { model: session.model }
			};
			(async () => {
				try {
					const response = await fetch(`${API_PREFIX}/run`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request),
						signal: controller.signal
					});
					if (!response.ok) {
						const detail = await response.text().catch(() => "");
						handlers.onError(detail === "" ? `HTTP ${response.status}` : detail);
						return;
					}
					if (response.body === null) {
						handlers.onError("response body is not streamable");
						return;
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done === true) break;
						buffer += decoder.decode(value, { stream: true });
						let boundary = buffer.indexOf("\n\n");
						while (boundary !== -1) {
							const frame = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							const payload = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
							const event = payload === "" ? void 0 : parseRunEvent(payload);
							if (event?.type === "session") {
								sessionId = event.sessionId;
								handlers.onSession?.(event.sessionId);
							} else if (event?.type === "delta") handlers.onDelta(event.text);
							else if (event?.type === "done") {
								sessionId = event.sessionId;
								handlers.onDone(event.text, event.sessionId);
							} else if (event?.type === "error") handlers.onError(event.message);
							boundary = buffer.indexOf("\n\n");
						}
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					handlers.onError(error instanceof Error ? error.message : String(error));
				}
			})();
			return {
				abort: () => controller.abort(),
				sessionId: () => sessionId
			};
		}
		/** 请求宿主停止某条会话上正在跑的一轮（与官方 Stop 走同一条 agent.cancel）。 */
		async function stopRun(sessionId) {
			if (sessionId === void 0) return;
			try {
				await fetch(`${API_PREFIX}/stop`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});
			} catch {}
		}
		//#endregion
		//#region src/client/icons.tsx
		/** 统一的 20px 线性图标，不依赖宿主图标版本。 */
		const paths = {
			selection: "M7 3H4a1 1 0 0 0-1 1v3m10-4h3a1 1 0 0 1 1 1v3M3 13v3a1 1 0 0 0 1 1h3m10-4v3a1 1 0 0 1-1 1h-3M7 7h6M10 7v6m-2 0h4",
			language: "M3 5h10M8 3v2m3 0c-1 5-4 8-8 10m2-7c1 3 3 5 6 6m1 3 3-8 3 8m-5-3h4",
			model: "M6 5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm2 3h4v4H8V8ZM8 2v3m4-3v3M8 15v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3",
			rules: "M5 3h8l3 3v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v4h4M7 10h6m-6 3h4",
			sparkle: "m10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z",
			list: "M7 5h10M7 10h10M7 15h7M3.5 5h.01M3.5 10h.01M3.5 15h.01",
			check: "m5 10 3 3 7-7",
			chevron: "m7 8 3 3 3-3",
			arrow: "M4 10h12m-4-4 4 4-4 4"
		};
		function ToolIcon({ name, size = 20 }) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 20 20",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: paths[name] }));
		}
		//#endregion
		//#region src/client/overlay.tsx
		/**
		* 划词菜单 + 悬浮窗（注册进 shell.overlay 的那一个 React 组件）。
		*
		* 交互：
		* - 页面里选中文字（拖选 / 双击 / 键盘扩选）→ 以选区右下角为锚点，在锚点
		*   第四象限（右下）弹出菜单，两项：「DeepSeek Harness 解释」「…翻译」。
		* - 同一份选区只弹一次：菜单以任何方式收起（Esc / 点别处 / 滚轮 / 点了菜单项）之后，
		*   页面里那份旧选区不会让菜单再弹出来——只有重新划词（选区变了）才会再弹。
		* - 点击菜单项 → 打开悬浮窗（默认屏幕右下角，可拖动、可八向缩放，可收起为
		*   悬浮球，可关闭），窗内流式渲染 Harness agent 的回答。
		* - 回答用官方 Markdown 原语渲染（与 DSH 对话里的排版一致）。
		*/
		/** 是否是 React 能渲染的组件（函数组件 / memo / forwardRef / class）。 */
		function isComponent(value) {
			if (typeof value === "function") return true;
			if (typeof value === "object" && value !== null) {
				const candidate = value;
				return typeof candidate.$$typeof === "symbol" || typeof candidate.render === "function";
			}
			return false;
		}
		/** 载入官方原语；模块表缺席时返回空对象而不是抛错。 */
		function loadPrimitives() {
			try {
				if (typeof require !== "function") return {};
				return require("@deepseek-ai/dsh-client-ui-primitives") ?? {};
			} catch {
				return {};
			}
		}
		const primitives = loadPrimitives();
		/** Markdown 渲染的界面文案（官方原语用它给代码块加复制按钮）。 */
		function markdownLabels(locale) {
			return locale === "zh" ? {
				code: {
					copyLabel: "复制",
					copiedLabel: "已复制"
				},
				footnotes: "脚注"
			} : {
				code: {
					copyLabel: "Copy",
					copiedLabel: "Copied"
				},
				footnotes: "Footnotes"
			};
		}
		/** 界面文案。 */
		const COPY$1 = {
			zh: {
				explain: "解释",
				translate: "翻译",
				summarize: "总结",
				panelExplain: "解释",
				panelTranslate: "翻译",
				panelSummarize: "总结",
				expand: "展开原文",
				collapse: "收起原文",
				running: "生成中…",
				done: "完成",
				failed: "失败",
				copy: "复制",
				copied: "已复制",
				close: "关闭",
				stop: "停止",
				empty: "（没有文本输出）"
			},
			en: {
				explain: "Explain",
				translate: "Translate",
				summarize: "Summarize",
				panelExplain: "Explain",
				panelTranslate: "Translate",
				panelSummarize: "Summarize",
				expand: "Show full source",
				collapse: "Collapse source",
				running: "Working…",
				done: "Done",
				failed: "Failed",
				copy: "Copy",
				copied: "Copied",
				close: "Close",
				stop: "Stop",
				empty: "(no text output)"
			}
		};
		const PANEL_W = 400;
		const PANEL_H = 480;
		const PANEL_MIN_W = 280;
		const PANEL_MIN_H = 180;
		const MARGIN = 20;
		const MENU_W = 192;
		const MENU_H = 168;
		const LAYOUT_KEY = "dsh.selection-tools.layout";
		const viewport = () => ({
			w: typeof window === "undefined" ? 1280 : window.innerWidth,
			h: typeof window === "undefined" ? 800 : window.innerHeight
		});
		function clamp(value, min, max) {
			return Math.min(Math.max(value, min), Math.max(min, max));
		}
		/** 默认几何：悬浮窗停在屏幕右下角（悬浮球已移除）。 */
		function defaultLayout() {
			const { w, h } = viewport();
			return { panel: {
				x: Math.max(MARGIN, w - PANEL_W - MARGIN),
				y: Math.max(MARGIN, h - PANEL_H - MARGIN),
				w: PANEL_W,
				h: PANEL_H
			} };
		}
		/** 把几何夹回视口内（窗口缩放后仍然可见）。 */
		function clampLayout(layout) {
			const { w, h } = viewport();
			const panelW = clamp(layout.panel.w, PANEL_MIN_W, Math.max(PANEL_MIN_W, w - 40));
			const panelH = clamp(layout.panel.h, PANEL_MIN_H, Math.max(PANEL_MIN_H, h - 40));
			return { panel: {
				w: panelW,
				h: panelH,
				x: clamp(layout.panel.x, 0, w - panelW),
				y: clamp(layout.panel.y, 0, h - panelH)
			} };
		}
		function loadLayout() {
			try {
				const raw = window.localStorage.getItem(LAYOUT_KEY);
				if (raw === null) return defaultLayout();
				const parsed = JSON.parse(raw);
				return clampLayout({ panel: {
					...defaultLayout().panel,
					...parsed.panel ?? {}
				} });
			} catch {
				return defaultLayout();
			}
		}
		function saveLayout(layout) {
			try {
				window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
			} catch {}
		}
		/**
		* 选区签名：判断"这是不是已经弹过菜单的那一份选区"。
		*
		* 为什么需要它：菜单收起之后，页面的选区**还在**。用户随后在任何地方按下鼠标再松开
		* （mouseup 事件照样进来、选区也没变），旧实现会拿这份旧选区再弹一次菜单——表现就是
		* "选中一次之后，到哪里拖菜单都会冒出来"。所以菜单只认**新的**选区：同一份选区弹过一次
		* 就不再弹，直到选区变了（用户重新划词）。
		*
		* 签名取"起点/终点在 DOM 里的位置 + 文本"，因此同一处同样的文字算同一份选区。
		*/
		function selectionSignature(range, text) {
			const pathOf = (node, offset) => {
				const parts = [];
				let current = node;
				while (current !== null && current.parentNode !== null) {
					parts.push(Array.prototype.indexOf.call(current.parentNode.childNodes, current));
					current = current.parentNode;
				}
				return parts.reverse().join(".") + ":" + offset;
			};
			const snippet = text.slice(0, 120);
			return pathOf(range.startContainer, range.startOffset) + "-" + pathOf(range.endContainer, range.endOffset) + "|" + text.length + "|" + snippet;
		}
		/** 选区矩形：优先整段选区的包围盒（即「文字右下角」），退化时取最后一行的矩形。 */
		function selectionRect(range) {
			const box = range.getBoundingClientRect();
			if (box.width > 0 || box.height > 0) return {
				right: box.right,
				bottom: box.bottom
			};
			const rects = range.getClientRects();
			const last = rects.length > 0 ? rects[rects.length - 1] : void 0;
			return last === void 0 ? null : {
				right: last.right,
				bottom: last.bottom
			};
		}
		/** 输入类元素：在这些地方划词不弹菜单（避免和编辑器/输入框打架）。 */
		function isEditableTarget(node) {
			let element = node instanceof Element ? node : node?.parentElement ?? null;
			while (element !== null) {
				const tag = element.tagName.toLowerCase();
				if (tag === "input" || tag === "textarea" || tag === "select") return true;
				if (element.isContentEditable) return true;
				element = element.parentElement;
			}
			return false;
		}
		/**
		* 页内划词的"上下文"：选区所在的块级元素文本。
		*
		* 与系统级取词（伴生进程用 UIA 读段落）对齐：解释/翻译时一起交给 agent，
		* 让回答落在语境里；块级元素抓不到或与选区等价时返回空串。
		*/
		function contextForRange(range, selected) {
			try {
				const node = range.commonAncestorContainer;
				const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
				if (element === null) return "";
				const text = ((element.closest("p, li, td, th, pre, blockquote, dd, dt, figcaption, article, section") ?? element).textContent ?? "").replace(/\s+/gu, " ").trim();
				const needle = selected.trim();
				if (text === "" || needle === "" || text === needle || !text.includes(needle)) return "";
				return text.slice(0, MAX_CONTEXT_LENGTH);
			} catch {
				return "";
			}
		}
		/** 内置图标兜底（官方原语缺席时使用）。 */
		function fallbackIcon(path, size) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: path }));
		}
		const FALLBACK_PATHS = {
			sparkle: "M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6z",
			globe: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2.6 8h10.8M8 2.2c1.6 1.6 2.4 3.6 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.2z",
			list: "M6 4h8M6 8h8M6 12h5.5M3 4h.01M3 8h.01M3 12h.01",
			copy: "M6 2.8h5.2a1 1 0 0 1 1 1V9M4.8 5.2h5.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z",
			close: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6",
			chevronDown: "M4 6.4 8 10.2l4-3.8",
			stop: "M5 5h6v6H5z"
		};
		function icon(name, size = 16) {
			let official;
			switch (name) {
				case "sparkle":
					official = primitives.IconSparkle16;
					break;
				case "globe":
					official = primitives.IconGlobeOutline14;
					break;
				case "list": break;
				case "copy":
					official = primitives.IconCopyOutline16;
					break;
				case "close":
					official = primitives.IconCloseOutline16;
					break;
				case "chevronDown":
					official = primitives.IconChevronDownOutline14;
					break;
				case "stop": official = primitives.IconStopFill16;
			}
			if (isComponent(official)) return (0, react.createElement)(official, { size });
			return fallbackIcon(FALLBACK_PATHS[name], size);
		}
		/** 复制文本：优先官方剪贴板工具，其次 navigator.clipboard。 */
		async function copyText(text) {
			if (typeof primitives.writeClipboard === "function") {
				await primitives.writeClipboard(text);
				return;
			}
			await navigator.clipboard.writeText(text);
		}
		/** 渲染 Markdown 回答：官方 MarkdownText 缺席时退化为纯文本。 */
		function renderMarkdown(text, streaming, locale) {
			if (isComponent(primitives.MarkdownText)) return (0, react.createElement)(primitives.MarkdownText, {
				text,
				streaming,
				labels: markdownLabels(locale)
			});
			return (0, react.createElement)("pre", { className: "dst-plain" }, text);
		}
		/** 面板标题：按动作取文案。 */
		function actionTitle(action, copy) {
			if (action === "translate") return copy.panelTranslate;
			if (action === "summarize") return copy.panelSummarize;
			return copy.panelExplain;
		}
		/** 面板标题旁的小图标：与菜单项保持一致。 */
		function actionIcon(action) {
			if (action === "translate") return "globe";
			if (action === "summarize") return "list";
			return "sparkle";
		}
		/**
		* 划词菜单 + 悬浮窗。整个插件只有这一个 React 组件，注册进 shell.overlay。
		* @param props.ctx - 客户端 Cordis 上下文。
		*/
		function Overlay(props) {
			const { ctx } = props;
			const locale = (0, react.useMemo)(() => detectLocale(), []);
			const copy = COPY$1[locale];
			/** 系统级划词是否正在接管（接管时页内菜单让位，避免同一处弹两个菜单）。 */
			const systemWide = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				let cancelled = false;
				const probe = () => {
					fetch("/api/dsh-selection-tools/system/status").then((response) => response.ok ? response.json() : null).then((payload) => {
						if (!cancelled) systemWide.current = payload?.companion?.state === "running";
					}).catch(() => {
						if (!cancelled) systemWide.current = false;
					});
				};
				probe();
				const timer = window.setInterval(probe, 3e4);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, []);
			const [menu, setMenu] = (0, react.useState)(null);
			const [panel, setPanel] = (0, react.useState)(null);
			const [binding, setBinding] = (0, react.useState)(() => typeof window === "undefined" ? defaultLayout() : loadLayout());
			const [copied, setCopied] = (0, react.useState)(false);
			const [expanded, setExpanded] = (0, react.useState)(false);
			/** 已经为它弹过菜单的那份选区（签名）；菜单收起后不再为它重复弹。 */
			const servedSelection = (0, react.useRef)(null);
			const rootRef = (0, react.useRef)(null);
			const dragRef = (0, react.useRef)(null);
			const runRef = (0, react.useRef)(null);
			const layoutRef = (0, react.useRef)(binding);
			layoutRef.current = { panel: layoutRef.current.panel };
			/** 打开悬浮窗并立刻发起一轮。 */
			const openPanel = (0, react.useCallback)((action, text, context = "") => {
				setMenu(null);
				setCopied(false);
				setExpanded(false);
				runRef.current?.abort();
				const geometry = clampLayout(layoutRef.current);
				layoutRef.current = geometry;
				setPanel({
					x: geometry.panel.x,
					y: geometry.panel.y,
					w: geometry.panel.w,
					h: geometry.panel.h,
					action,
					source: text,
					status: "running",
					text: "",
					error: ""
				});
				runRef.current = startRun(action, text, ctx, context, {
					onSession: (sessionId) => setPanel((current) => current === null ? current : {
						...current,
						sessionId
					}),
					onDelta: (chunk) => setPanel((current) => current === null ? current : {
						...current,
						text: current.text + chunk
					}),
					onDone: (final, sessionId) => setPanel((current) => current === null ? current : {
						...current,
						status: "done",
						sessionId,
						text: final === "" ? current.text : final
					}),
					onError: (message) => setPanel((current) => current === null ? current : {
						...current,
						status: "error",
						error: message
					})
				});
			}, [ctx]);
			(0, react.useEffect)(() => {
				const insideOwnUi = (node) => node !== null && rootRef.current !== null && rootRef.current.contains(node);
				const dismiss = (event) => {
					if (insideOwnUi(event.target)) return;
					setMenu(null);
				};
				const inspectSelection = (event) => {
					const target = event.target;
					if (insideOwnUi(target) || isEditableTarget(target)) return;
					if (systemWide.current) return;
					window.setTimeout(() => {
						const selection = window.getSelection();
						if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
							setMenu(null);
							return;
						}
						const text = selection.toString().trim();
						if (text === "") {
							setMenu(null);
							return;
						}
						const range = selection.getRangeAt(0);
						if (insideOwnUi(range.commonAncestorContainer)) {
							setMenu(null);
							return;
						}
						const rect = selectionRect(range);
						if (rect === null) {
							setMenu(null);
							return;
						}
						const signature = selectionSignature(range, text);
						if (signature === servedSelection.current) {
							setMenu(null);
							return;
						}
						servedSelection.current = signature;
						setMenu({
							anchorX: rect.right,
							anchorY: rect.bottom,
							text: text.slice(0, MAX_SELECTION_LENGTH),
							context: contextForRange(range, text)
						});
					}, 0);
				};
				/**
				* 选区一变（选了新的一段、或者被点掉）就作废"弹过"的记号，用户重新划词时还能弹。
				* 选区没变时什么都不做——正是靠这条，旧选区不会再触发第二次菜单。
				*/
				const onSelectionChange = () => {
					if (servedSelection.current === null) return;
					const selection = window.getSelection();
					if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
						servedSelection.current = null;
						return;
					}
					if (selectionSignature(selection.getRangeAt(0), selection.toString().trim()) !== servedSelection.current) servedSelection.current = null;
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setMenu(null);
				};
				const onViewportChange = () => setMenu(null);
				document.addEventListener("selectionchange", onSelectionChange);
				document.addEventListener("pointerdown", dismiss, true);
				document.addEventListener("mouseup", inspectSelection, true);
				document.addEventListener("dblclick", inspectSelection, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("resize", onViewportChange);
				window.addEventListener("scroll", onViewportChange, true);
				return () => {
					document.removeEventListener("selectionchange", onSelectionChange);
					document.removeEventListener("pointerdown", dismiss, true);
					document.removeEventListener("mouseup", inspectSelection, true);
					document.removeEventListener("dblclick", inspectSelection, true);
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("resize", onViewportChange);
					window.removeEventListener("scroll", onViewportChange, true);
				};
			}, []);
			const persistPanel = (0, react.useCallback)((next) => {
				layoutRef.current = { panel: {
					x: next.x,
					y: next.y,
					w: next.w,
					h: next.h
				} };
				saveLayout(layoutRef.current);
			}, []);
			const beginMove = (event) => {
				if (panel === null || event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				dragRef.current = {
					kind: "move",
					edge: "",
					pointerX: event.clientX,
					pointerY: event.clientY,
					x: panel.x,
					y: panel.y,
					w: panel.w,
					h: panel.h
				};
			};
			const beginResize = (edge) => (event) => {
				if (panel === null || event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				dragRef.current = {
					kind: "resize",
					edge,
					pointerX: event.clientX,
					pointerY: event.clientY,
					x: panel.x,
					y: panel.y,
					w: panel.w,
					h: panel.h
				};
			};
			const onDragMove = (event) => {
				const drag = dragRef.current;
				if (drag === null) return;
				const dx = event.clientX - drag.pointerX;
				const dy = event.clientY - drag.pointerY;
				const box = viewport();
				if (drag.kind === "move") {
					const x = clamp(drag.x + dx, 0, box.w - drag.w);
					const y = clamp(drag.y + dy, 0, box.h - drag.h);
					setPanel((current) => current === null ? current : {
						...current,
						x,
						y
					});
					return;
				}
				let { x, y, w, h } = drag;
				if (drag.edge.includes("e")) w = clamp(drag.w + dx, PANEL_MIN_W, box.w - drag.x);
				if (drag.edge.includes("s")) h = clamp(drag.h + dy, PANEL_MIN_H, box.h - drag.y);
				if (drag.edge.includes("w")) {
					const nextW = clamp(drag.w - dx, PANEL_MIN_W, drag.x + drag.w);
					x = drag.x + (drag.w - nextW);
					w = nextW;
				}
				if (drag.edge.includes("n")) {
					const nextH = clamp(drag.h - dy, PANEL_MIN_H, drag.y + drag.h);
					y = drag.y + (drag.h - nextH);
					h = nextH;
				}
				setPanel((current) => current === null ? current : {
					...current,
					x,
					y,
					w,
					h
				});
			};
			const onDragEnd = () => {
				if (dragRef.current === null) return;
				dragRef.current = null;
				setPanel((current) => {
					if (current !== null) persistPanel(current);
					return current;
				});
			};
			(0, react.useEffect)(() => {
				const onResize = () => {
					const next = clampLayout(layoutRef.current);
					layoutRef.current = next;
					setBinding((current) => ({
						...current,
						panel: next.panel
					}));
					setPanel((current) => current === null ? current : {
						...current,
						x: next.panel.x,
						y: next.panel.y,
						w: next.panel.w,
						h: next.panel.h
					});
				};
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);
			const closePanel = () => {
				runRef.current?.abort();
				runRef.current = null;
				setPanel(null);
			};
			const onCopy = () => {
				if (panel === null) return;
				copyText(panel.text).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1600);
				}, () => void 0);
			};
			const onStop = () => {
				stopRun(panel?.sessionId);
				runRef.current?.abort();
				runRef.current = null;
				setPanel((current) => current === null ? current : {
					...current,
					status: "done"
				});
			};
			let menuNode = null;
			if (menu !== null) {
				const box = viewport();
				const x = clamp(menu.anchorX + 8, 8, box.w - MENU_W - 8);
				const y = clamp(menu.anchorY + 8, 8, box.h - MENU_H - 8);
				const item = (action, label, iconName) => (0, react.createElement)("button", {
					type: "button",
					className: "dst-menu-item",
					role: "menuitem",
					onMouseDown: (event) => event.preventDefault(),
					onClick: () => openPanel(action, menu.text, menu.context)
				}, (0, react.createElement)("span", { className: "dst-menu-item-icon" }, icon(iconName, 16)), (0, react.createElement)("span", { className: "dst-menu-item-label" }, label), (0, react.createElement)("span", { className: "dst-menu-arrow" }, (0, react.createElement)(ToolIcon, {
					name: "arrow",
					size: 14
				})));
				menuNode = (0, react.createElement)("div", {
					className: "dst-menu",
					style: {
						left: x,
						top: y,
						width: MENU_W
					},
					role: "menu",
					"aria-label": "Selection tools"
				}, (0, react.createElement)("div", {
					className: "dst-menu-caption",
					role: "presentation"
				}, "DeepSeek Harness", (0, react.createElement)("span", { "aria-hidden": true }, "Esc")), item("explain", copy.explain, "sparkle"), item("summarize", copy.summarize, "list"), item("translate", copy.translate, "globe"));
			}
			const statusText = panel === null ? "" : panel.status === "running" ? copy.running : panel.status === "error" ? copy.failed : copy.done;
			const headerButton = (options) => (0, react.createElement)("button", {
				type: "button",
				className: "dst-icon-btn",
				title: options.label,
				"aria-label": options.label,
				disabled: options.disabled === true,
				onPointerDown: (event) => event.stopPropagation(),
				onClick: options.onClick
			}, icon(options.iconName, 16));
			const panelNode = panel === null ? null : (0, react.createElement)("section", {
				className: "dst-panel",
				style: {
					left: panel.x,
					top: panel.y,
					width: panel.w,
					height: panel.h
				},
				role: "dialog",
				"aria-label": actionTitle(panel.action, copy)
			}, (0, react.createElement)("header", {
				className: "dst-panel-header",
				onPointerDown: beginMove,
				onPointerMove: onDragMove,
				onPointerUp: onDragEnd,
				onPointerCancel: onDragEnd
			}, (0, react.createElement)("span", { className: "dst-menu-item-icon" }, icon(actionIcon(panel.action), 16)), (0, react.createElement)("span", { className: "dst-panel-title" }, actionTitle(panel.action, copy), (0, react.createElement)("span", { className: "dst-panel-brand" }, "Harness")), (0, react.createElement)("span", { className: "dst-panel-actions" }, headerButton({
				label: copied ? copy.copied : copy.copy,
				iconName: "copy",
				disabled: panel.text === "",
				onClick: onCopy
			}), headerButton({
				label: copy.close,
				iconName: "close",
				onClick: closePanel
			}))), (0, react.createElement)("div", { className: "dst-panel-body" }, (0, react.createElement)("div", {
				className: "dst-source",
				"data-expanded": expanded ? "true" : "false"
			}, (0, react.createElement)("span", { className: "dst-source-label" }, locale === "zh" ? "原文" : "SOURCE"), (0, react.createElement)("div", { className: "dst-source-text" }, panel.source), panel.source.length > 80 || panel.source.split("\n").length > 3 ? (0, react.createElement)("button", {
				type: "button",
				className: "dst-source-toggle",
				onClick: () => setExpanded((value) => !value)
			}, expanded ? copy.collapse : copy.expand) : null), (0, react.createElement)("div", { className: "dst-answer" }, panel.text === "" ? panel.status === "running" ? (0, react.createElement)("span", { className: "dst-caret" }) : (0, react.createElement)("span", { className: "dst-empty" }, copy.empty) : renderMarkdown(panel.text, panel.status === "running", locale))), (0, react.createElement)("footer", {
				className: "dst-panel-foot",
				role: "status",
				"aria-live": "polite"
			}, (0, react.createElement)("span", {
				className: "dst-dot",
				"data-state": panel.status
			}), (0, react.createElement)("span", { className: panel.status === "error" ? "dst-error" : "" }, statusText), panel.status === "error" && panel.error !== "" ? (0, react.createElement)("span", { className: "dst-error" }, panel.error) : null, (0, react.createElement)("span", { className: "dst-foot-spacer" }), panel.status === "running" ? (0, react.createElement)("button", {
				type: "button",
				className: "dst-link",
				onClick: onStop
			}, copy.stop) : null), ...[
				"n",
				"s",
				"e",
				"w",
				"ne",
				"nw",
				"se",
				"sw"
			].map((edge) => (0, react.createElement)("div", {
				key: edge,
				className: "dst-resize dst-resize-" + edge,
				onPointerDown: beginResize(edge),
				onPointerMove: onDragMove,
				onPointerUp: onDragEnd,
				onPointerCancel: onDragEnd
			})));
			return (0, react.createElement)("div", {
				ref: rootRef,
				className: "dst-root"
			}, menuNode, panelNode);
		}
		//#endregion
		//#region src/client/settings.tsx
		/**
		* 设置页里的「划词工具」一页（settings.section）。
		*
		* 数据流：宿主半边持有设置文件（dsh-selection-tools.json）与 HTTP 路由，
		* 这里只用同源 fetch 读写——不依赖官方 settings 服务，插件在任何 profile 下都能用。
		*
		* 模型下拉的候选来自官方 \`ctx.modelDirectories\`（与输入框的模型座位同一份目录），
		* 目录读不到时退化成手填 provider / model。
		*/
		/** 文案。 */
		const COPY = {
			zh: {
				title: "划词工具",
				hint: "让每一次划词，都更懂你的意思。",
				autoSave: "自动保存",
				languageTitle: "翻译偏好",
				languageDescription: "选择你习惯阅读的语言。",
				modelTitle: "模型配置",
				modelDescription: "为翻译、解释与总结分别选择合适的模型。",
				rulesTitle: "回答规则",
				rulesDescription: "微调语气、格式与内容，让回答更合心意。",
				stepSelect: "选中文字",
				stepAction: "解释、总结或翻译",
				stepRead: "即刻阅读",
				explainShort: "解释规则",
				summarizeShort: "总结规则",
				translateShort: "翻译规则",
				customRules: "自定义",
				defaultRules: "默认规则",
				targetLabel: "默认翻译至",
				targetHint: "自动模式下，中文译为英文，其他语言译为中文。",
				fallbackLabel: "反向目标语言",
				fallbackHint: "原文与目标语言相同时，使用此语言；自动模式下中英互译。",
				explainRulesLabel: "解释规则（交给模型的要求）",
				explainRulesHint: "每行一条要求，将直接用于生成解释。",
				summarizeRulesLabel: "总结规则（交给模型的要求）",
				summarizeRulesHint: "每行一条要求，将直接用于生成总结。",
				translateRulesLabel: "翻译规则（交给模型的要求）",
				translateRulesHint: "每行一条要求，将直接用于生成翻译。",
				restore: "恢复默认",
				translateModelLabel: "翻译使用的模型",
				explainModelLabel: "解释使用的模型",
				summarizeModelLabel: "总结使用的模型",
				modelHint: "「跟随当前会话」= 用你当前对话正在用的模型。",
				effortLabel: "推理等级",
				effortDefault: "适配器默认",
				followSession: "跟随当前会话",
				auto: "跟随原文自动（中 ↔ 英）",
				autoMirror: "自动（镜像）",
				manualHint: "暂时读不到模型目录，可直接填写 provider / model。",
				provider: "provider",
				model: "model",
				saved: "已保存",
				saving: "保存中…",
				failed: "保存失败",
				loading: "读取设置中…",
				loadFailed: "读取设置失败",
				retry: "重试"
			},
			en: {
				title: "Selection tools",
				hint: "A little more understanding, with every selection.",
				autoSave: "Auto-save on",
				languageTitle: "Translation preferences",
				languageDescription: "Read in the language that feels like home.",
				modelTitle: "Model preferences",
				modelDescription: "Choose the right model for each task.",
				rulesTitle: "Response rules",
				rulesDescription: "Fine-tune the tone, format, and level of detail.",
				stepSelect: "Select text",
				stepAction: "Explain, summarize, or translate",
				stepRead: "Keep reading",
				explainShort: "Explanation rules",
				summarizeShort: "Summary rules",
				translateShort: "Translation rules",
				customRules: "Custom",
				defaultRules: "Default rules",
				targetLabel: "Translate into",
				targetHint: "\"Follow the source\" keeps the original behaviour: Chinese → English, anything else → Chinese.",
				fallbackLabel: "Fallback target",
				fallbackHint: "Used when the selection is already in the primary target language.",
				explainRulesLabel: "Explain rules (given to the model)",
				explainRulesHint: "Sent verbatim as the \"Requirements\" block of the explain prompt, one rule per line.",
				summarizeRulesLabel: "Summary rules (given to the model)",
				summarizeRulesHint: "Sent verbatim as the \"Requirements\" block of the summary prompt, one rule per line.",
				translateRulesLabel: "Translate rules (given to the model)",
				translateRulesHint: "Sent verbatim as the \"Requirements\" block of the translate prompt, one rule per line.",
				restore: "Restore default",
				translateModelLabel: "Model for translation",
				explainModelLabel: "Model for explanation",
				summarizeModelLabel: "Model for summarization",
				modelHint: "\"Follow the current session\" uses whatever model your conversation uses.",
				effortLabel: "Reasoning effort",
				effortDefault: "Adapter default",
				followSession: "Follow current session",
				auto: "Follow the source (zh ↔ en)",
				autoMirror: "Automatic (mirror)",
				manualHint: "The model catalog is not available yet — type provider / model directly.",
				provider: "provider",
				model: "model",
				saved: "Saved",
				saving: "Saving…",
				failed: "Save failed",
				loading: "Loading…",
				loadFailed: "Could not load settings",
				retry: "Retry"
			}
		};
		/** 语言下拉的选项（含"自动"）。 */
		function languageOptions(autoLabel) {
			return [{
				id: AUTO_LANGUAGE_ID,
				label: autoLabel
			}, ...LANGUAGES.map((item) => ({
				id: item.id,
				label: item.label + " (" + item.prompt + ")"
			}))];
		}
		/**
		* 读模型目录。
		*
		* 两个来源，按优先级用：
		* 1. 当前会话的模型座位目录（`modelDirectories.directoryFor(sessionId)`）——与输入框同一份，
		*    但**只有存在当前会话时才有**；
		* 2. 全局模型目录（`modelDirectories.catalog`）——设置页常常在"还没开会话"时被打开，
		*    这时只能用它（它是一次 host RPC，不依赖会话）。
		*/
		function useModelCatalog(ctx) {
			const [groups, setGroups] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				const directories = ctx.get?.("modelDirectories");
				if (directories === void 0 || directories === null) return void 0;
				let directory;
				try {
					const sessionId = ctx.get?.("sessions")?.list?.getSnapshot?.()?.current;
					directory = sessionId === void 0 ? void 0 : directories.directoryFor?.(sessionId);
				} catch {
					directory = void 0;
				}
				const catalog = directories.catalog;
				const read = () => {
					const fromDirectory = directory?.store?.getSnapshot?.();
					const fromCatalog = catalog?.store?.getSnapshot?.();
					const directoryGroups = Array.isArray(fromDirectory?.groups) ? fromDirectory.groups : [];
					const catalogGroups = Array.isArray(fromCatalog?.value?.groups) ? fromCatalog.value.groups : [];
					setGroups(directoryGroups.length > 0 ? directoryGroups : catalogGroups);
				};
				const stops = [];
				for (const store of [directory?.store, catalog?.store]) {
					if (typeof store?.subscribe !== "function") continue;
					const stop = store.subscribe(read);
					if (typeof stop === "function") stops.push(stop);
				}
				try {
					catalog?.load?.().catch?.(() => void 0);
				} catch {}
				read();
				return () => {
					for (const stop of stops) stop();
				};
			}, [ctx]);
			return {
				groups,
				ready: groups.length > 0
			};
		}
		/** 一个模型座位选择器（模型 + 推理等级）。 */
		function ModelSeatField(props) {
			const { label, hint, copy, seat, groups, catalogsReady, onChange } = props;
			const flat = (0, react.useMemo)(() => groups.flatMap((group) => (group.models ?? []).map((model) => ({
				key: group.id + "/" + model.id,
				provider: group.id,
				providerLabel: group.name ?? group.label ?? group.id,
				model
			}))), [groups]);
			const current = seat === null ? "" : seat.provider + "/" + seat.model;
			const efforts = (0, react.useMemo)(() => {
				if (seat === null) return [];
				return flat.find((item) => item.provider === seat.provider && item.model.id === seat.model)?.model.reasoning?.efforts ?? [];
			}, [flat, seat]);
			const pickModel = (value) => {
				if (value === "") {
					onChange(null);
					return;
				}
				const found = flat.find((item) => item.key === value);
				if (found === void 0) return;
				const defaultEffort = found.model.reasoning?.defaultEffort;
				onChange({
					provider: found.provider,
					model: found.model.id,
					...defaultEffort === void 0 ? {} : { reasoningEffort: defaultEffort }
				});
			};
			const rows = [];
			rows.push((0, react.createElement)("span", { className: "dst-set-label" }, label), catalogsReady ? (0, react.createElement)("select", {
				className: "dst-set-input",
				"aria-label": label,
				value: current,
				onChange: (event) => pickModel(String(event.target.value))
			}, [(0, react.createElement)("option", {
				key: "",
				value: ""
			}, copy.followSession), ...flat.map((item) => (0, react.createElement)("option", {
				key: item.key,
				value: item.key
			}, item.providerLabel + " · " + (item.model.name ?? item.model.id)))]) : (0, react.createElement)("div", { className: "dst-set-row" }, (0, react.createElement)("input", {
				className: "dst-set-input",
				placeholder: copy.provider,
				"aria-label": label + " · " + copy.provider,
				value: seat?.provider ?? "",
				onChange: (event) => onChange({
					provider: String(event.target.value),
					model: seat?.model ?? ""
				})
			}), (0, react.createElement)("input", {
				className: "dst-set-input",
				placeholder: copy.model,
				"aria-label": label + " · " + copy.model,
				value: seat?.model ?? "",
				onChange: (event) => onChange({
					provider: seat?.provider ?? "",
					model: String(event.target.value)
				})
			})));
			if (catalogsReady && seat !== null && efforts.length > 0) rows.push((0, react.createElement)("div", { className: "dst-set-row" }, (0, react.createElement)("span", { className: "dst-set-sub" }, copy.effortLabel), (0, react.createElement)("select", {
				className: "dst-set-input",
				"aria-label": label + " · " + copy.effortLabel,
				value: seat.reasoningEffort ?? "",
				onChange: (event) => {
					const effort = String(event.target.value);
					onChange({
						provider: seat.provider,
						model: seat.model,
						...effort === "" ? {} : { reasoningEffort: effort }
					});
				}
			}, [(0, react.createElement)("option", {
				key: "",
				value: ""
			}, copy.effortDefault), ...efforts.map((effort) => (0, react.createElement)("option", {
				key: effort.id,
				value: effort.id
			}, effort.name ?? effort.id))])));
			rows.push((0, react.createElement)("span", { className: "dst-set-hint" }, catalogsReady ? hint : copy.manualHint));
			return (0, react.createElement)("div", { className: "dst-set-field" }, ...rows);
		}
		/**
		* 「划词工具」设置页。
		* @param props.ctx - 客户端 Cordis 上下文。
		*/
		function SettingsSection(props) {
			const { ctx } = props;
			const locale = detectLocale();
			const copy = COPY[locale];
			const [settings, setSettings] = (0, react.useState)(null);
			const [status, setStatus] = (0, react.useState)("loading");
			const [error, setError] = (0, react.useState)("");
			const timer = (0, react.useRef)(null);
			const { groups, ready: catalogsReady } = useModelCatalog(ctx);
			const load = (0, react.useCallback)(() => {
				setStatus("loading");
				fetch(API_PREFIX + "/settings").then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error("HTTP " + response.status))).then((payload) => {
					setSettings(normalizeSettings(payload.settings));
					setStatus("ready");
					setError("");
				}).catch((cause) => {
					setStatus("error");
					setError(cause instanceof Error ? cause.message : String(cause));
				});
			}, []);
			(0, react.useEffect)(() => {
				load();
				return () => {
					if (timer.current !== null) window.clearTimeout(timer.current);
				};
			}, [load]);
			/** 改一项 → 立刻本地生效 + 防抖落盘。 */
			const update = (0, react.useCallback)((patch) => {
				setSettings((current) => {
					if (current === null) return current;
					const next = normalizeSettings({
						...current,
						...patch
					});
					setStatus("saving");
					if (timer.current !== null) window.clearTimeout(timer.current);
					timer.current = window.setTimeout(() => {
						timer.current = null;
						fetch(API_PREFIX + "/settings", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(next)
						}).then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error("HTTP " + response.status))).then((payload) => {
							setSettings(normalizeSettings(payload.settings));
							setStatus("saved");
							setError("");
						}).catch((cause) => {
							setStatus("error");
							setError(cause instanceof Error ? cause.message : String(cause));
						});
					}, 220);
					return next;
				});
			}, []);
			if (settings === null) return (0, react.createElement)("div", { className: "dst-set-section" }, (0, react.createElement)("h2", { className: "dst-set-title" }, copy.title), (0, react.createElement)("div", { className: "dst-set-status" }, (0, react.createElement)("span", { className: status === "error" ? "dst-set-error" : "" }, status === "error" ? copy.loadFailed + "：" + error : copy.loading), status === "error" ? (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				onClick: load
			}, copy.retry) : null));
			const statusText = status === "saving" ? copy.saving : status === "saved" ? copy.saved : status === "error" ? copy.failed : copy.autoSave;
			const languageField = (label, hint, value, autoLabel, key) => (0, react.createElement)("div", {
				className: "dst-set-field",
				key
			}, (0, react.createElement)("label", {
				className: "dst-set-label",
				htmlFor: "dst-" + key
			}, label), (0, react.createElement)("select", {
				id: "dst-" + key,
				className: "dst-set-input",
				value,
				onChange: (event) => update({ [key]: String(event.target.value) })
			}, languageOptions(autoLabel).map((option) => (0, react.createElement)("option", {
				key: option.id,
				value: option.id
			}, option.label))), (0, react.createElement)("span", { className: "dst-set-hint" }, hint));
			const rulesField = (key, label, hint, value, fallback) => (0, react.createElement)("details", {
				className: "dst-set-rule",
				key
			}, (0, react.createElement)("summary", { className: "dst-set-rule-summary" }, (0, react.createElement)(ToolIcon, {
				name: key === "explainRules" ? "sparkle" : key === "summarizeRules" ? "list" : "language",
				size: 18
			}), (0, react.createElement)("span", { className: "dst-set-rule-name" }, label), (0, react.createElement)("span", {
				className: "dst-set-rule-badge",
				"data-custom": value !== fallback
			}, value === fallback ? copy.defaultRules : copy.customRules), (0, react.createElement)("span", { className: "dst-set-rule-chevron" }, (0, react.createElement)(ToolIcon, {
				name: "chevron",
				size: 16
			}))), (0, react.createElement)("div", { className: "dst-set-rule-body" }, (0, react.createElement)("textarea", {
				className: "dst-set-textarea",
				"aria-label": label,
				rows: 6,
				spellCheck: false,
				value,
				onChange: (event) => update({ [key]: String(event.target.value) })
			}), (0, react.createElement)("div", { className: "dst-set-labelrow" }, (0, react.createElement)("span", { className: "dst-set-hint" }, hint), (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				disabled: value === fallback,
				onClick: () => update({ [key]: fallback })
			}, copy.restore))));
			const group = (icon, title, description, content) => (0, react.createElement)("section", {
				className: "dst-set-card",
				"aria-label": title
			}, (0, react.createElement)("div", { className: "dst-set-card-heading" }, (0, react.createElement)("span", { className: "dst-set-card-icon" }, (0, react.createElement)(ToolIcon, { name: icon })), (0, react.createElement)("div", null, (0, react.createElement)("h3", { className: "dst-set-card-title" }, title), (0, react.createElement)("p", { className: "dst-set-hint" }, description))), content);
			return (0, react.createElement)("div", { className: "dst-set-section" }, (0, react.createElement)("header", { className: "dst-set-header" }, (0, react.createElement)("span", { className: "dst-set-brand" }, (0, react.createElement)(ToolIcon, {
				name: "selection",
				size: 26
			})), (0, react.createElement)("div", { className: "dst-set-heading" }, (0, react.createElement)("h2", { className: "dst-set-title" }, copy.title), (0, react.createElement)("p", { className: "dst-set-hint dst-set-intro" }, copy.hint)), (0, react.createElement)("span", {
				className: "dst-set-save",
				"data-state": status,
				role: "status",
				"aria-live": "polite"
			}, status === "saving" ? (0, react.createElement)("span", {
				className: "dst-set-spinner",
				"aria-hidden": true
			}) : (0, react.createElement)(ToolIcon, {
				name: "check",
				size: 14
			}), statusText)), (0, react.createElement)("div", {
				className: "dst-set-workflow",
				"aria-label": copy.hint
			}, (0, react.createElement)("span", { className: "dst-set-step" }, (0, react.createElement)(ToolIcon, {
				name: "selection",
				size: 16
			}), copy.stepSelect), (0, react.createElement)(ToolIcon, {
				name: "arrow",
				size: 14
			}), (0, react.createElement)("span", { className: "dst-set-step" }, (0, react.createElement)(ToolIcon, {
				name: "sparkle",
				size: 16
			}), copy.stepAction), (0, react.createElement)(ToolIcon, {
				name: "arrow",
				size: 14
			}), (0, react.createElement)("span", { className: "dst-set-step" }, (0, react.createElement)(ToolIcon, {
				name: "check",
				size: 16
			}), copy.stepRead)), status === "error" ? (0, react.createElement)("div", {
				className: "dst-set-error-banner",
				role: "alert"
			}, copy.failed + "：" + error, (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				onClick: () => update({})
			}, copy.retry)) : null, group("language", copy.languageTitle, copy.languageDescription, (0, react.createElement)("div", { className: "dst-set-grid" }, languageField(copy.targetLabel, copy.targetHint, settings.targetLanguage, copy.auto, "targetLanguage"), languageField(copy.fallbackLabel, copy.fallbackHint, settings.fallbackLanguage, copy.autoMirror, "fallbackLanguage"))), group("model", copy.modelTitle, copy.modelDescription, (0, react.createElement)("div", { className: "dst-set-grid" }, (0, react.createElement)(ModelSeatField, {
				label: copy.translateModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.translateModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ translateModel: seat })
			}), (0, react.createElement)(ModelSeatField, {
				label: copy.explainModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.explainModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ explainModel: seat })
			}), (0, react.createElement)(ModelSeatField, {
				label: copy.summarizeModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.summarizeModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ summarizeModel: seat })
			}))), group("rules", copy.rulesTitle, copy.rulesDescription, (0, react.createElement)("div", { className: "dst-set-rules" }, rulesField("explainRules", copy.explainShort, copy.explainRulesHint, settings.explainRules, DEFAULT_EXPLAIN_RULES), rulesField("summarizeRules", copy.summarizeShort, copy.summarizeRulesHint, settings.summarizeRules, DEFAULT_SUMMARIZE_RULES), rulesField("translateRules", copy.translateShort, copy.translateRulesHint, settings.translateRules, DEFAULT_TRANSLATE_RULES))));
		}
		//#endregion
		//#region src/client/styles.ts
		/** 插件样式：局部令牌、轻量卡片与浮层，深浅色跟随宿主。 */
		const STYLE_TAG_ID = "dsh-selection-tools/client.css";
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
`;
		/** 注入一次；沿用宿主 HMR 的样式标签身份，卸载时可回收。 */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify("dsh-selection-tools/client.css") + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-selection-tools";
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-selection-tools —— 浏览器半边入口。
		*
		* 两处注册：
		* - \`shell.overlay\`：页内划词菜单 + 回答窗口（系统级伴生进程在跑时它让位）；
		* - \`settings.section\`：设置页里的「划词工具」一页（语言、规则、模型）。
		*/
		/** 硬依赖：槽位注册表。其余服务一律经 ctx.get 可选读取。 */
		const inject = ["slots"];
		/**
		* 挂载浏览器半边。
		* @param ctx - 客户端 Cordis 上下文。
		*/
		function apply(ctx) {
			ensureStyles();
			const slots = ctx.get?.("slots");
			if (slots === void 0) return;
			slots.inject("shell.overlay", () => slots.register({
				name: "shell.overlay",
				id: "dsh-selection-tools",
				order: 60
			}, () => (0, react.createElement)(Overlay, { ctx })));
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "dsh-selection-tools",
				order: 40,
				label: () => detectLocale() === "zh" ? "划词工具" : "Selection tools"
			}, () => (0, react.createElement)(SettingsSection, { ctx })));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map