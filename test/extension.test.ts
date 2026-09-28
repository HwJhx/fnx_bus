/**
 * `index.ts`（扩展入口）的单测。
 *
 * ## 这些测试保护什么、不保护什么
 *
 * `index.ts` 是「接线的那一层」：注册工具、监听 pi 的事件、把消息递给模型、弹框问人。
 * 它不是纯函数，所以这里用一个**假 pi** 来驱动它。
 *
 * 由此而来的边界必须写清楚：
 *
 * - **这些测试保护「我们自己的逻辑不退化」** ——改 `drain` 时不会把守卫弄丢。
 * - **它们不能证明「我们对 pi 行为的假设仍然成立」** ——那只有真机能验。
 *   假 pi 的行为是我们照实测结果**假造**的；pi 升级后行为若变了，这里照样全绿，
 *   真机却会失败。
 *
 * 所以：**假 pi 不是真理，是「我们对 pi 行为的假设」的显式记录。** 每条关键假设在下面
 * 标了依据哪次实测。哪天真机验证失败，先回来看这些假设是不是过期了。
 *
 * 假设一览（依据 `fnx-sw/docs/claude/fnxbus-测试全景.md` 层 4、层 7 的实测）：
 *
 * | 假设 | 依据 |
 * |---|---|
 * | `ctx.isIdle()` 为假表示 agent 正在跑，此时投递会排到当前轮之后 | 层 4 采样表：投递后 20 个写操作照常放行，inbox 保持 1 条 125 秒 |
 * | `ctx.hasUI` 在 `-p`/`json` 模式为假 | 类型定义「true in TUI and RPC modes」+ 层 7 实测 `-p` 下 `decideToolCall` 走 block 分支 |
 * | `session_start` 末尾会同步跑一次 `drain` | 层 4 判定 7：离线消息在 agent 启动后被处理 |
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fnxbus from "../extensions/index.ts";

/** 假 ctx。只造 `index.ts` 真正用到的那几个成员（`pi.*` 四个方法、`ctx` 七个成员）。 */
interface FakeCtx {
	cwd: string;
	hasUI: boolean;
	isIdle(): boolean;
	ui: {
		notify(message: string, level?: string): void;
		setStatus(key: string, value: string): void;
		select(message: string, options: string[]): Promise<string>;
		input(message: string, initial?: string): Promise<string>;
	};
}

type Handler = (event: unknown, ctx: FakeCtx) => unknown;

/** 注册进来的工具，只留测试用得到的部分。 */
interface FakeTool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
	): Promise<{
		content: { type: string; text: string }[];
		isError?: boolean;
		details?: unknown;
	}>;
}

interface FakePi {
	/** 注册进来的事件处理器，按事件名存。 */
	handlers: Map<string, Handler>;
	/** 注册进来的工具，按名字存。 */
	tools: Map<string, FakeTool>;
	/** 注册进来的命令名。 */
	commands: string[];
	/** `sendUserMessage` 的调用记录——「投递了几次、投了什么」。 */
	delivered: { content: string; deliverAs?: string }[];
	/** 让下一次 `sendUserMessage` 抛这个错，用来测「投递失败时记账已经落盘了没」。 */
	deliverThrows?: Error;
	notified: string[];
	status: Map<string, string>;
	/** 闸门弹框时点哪个选项。默认点最后一个（「拒绝」）。 */
	selectAnswer?: string;
	/** 闸门弹框的记录：问了几次、问的什么。 */
	selected: { message: string; options: string[] }[];
	/** 触发某个事件；没注册就返回 undefined。 */
	fire(event: string, payload?: unknown): unknown;
	api: ExtensionAPI;
	ctx: FakeCtx;
}

/** 触发一次 `tool_call` 并等它给出裁决。 */
type ToolVerdict = { block?: boolean; reason?: string } | undefined;
const callTool = (pi: FakePi, toolName: string, input: Record<string, unknown>): Promise<ToolVerdict> =>
	pi.fire("tool_call", { toolName, input }) as Promise<ToolVerdict>;

function makeFakePi(root: string, opts: { hasUI?: boolean; idle?: boolean } = {}): FakePi {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, FakeTool>();
	const commands: string[] = [];
	const delivered: { content: string; deliverAs?: string }[] = [];
	const notified: string[] = [];
	const status = new Map<string, string>();
	const selected: { message: string; options: string[] }[] = [];

	const ctx: FakeCtx = {
		cwd: root,
		hasUI: opts.hasUI ?? true,
		isIdle: () => opts.idle ?? true,
		ui: {
			notify: (m) => notified.push(m),
			setStatus: (k, v) => status.set(k, v),
			select: async (message, options) => {
				selected.push({ message, options });
				return fake.selectAnswer ?? options[options.length - 1];
			},
			input: async (_m, initial) => initial ?? "",
		},
	};

	const fake: FakePi = {
		handlers,
		tools,
		commands,
		delivered,
		notified,
		status,
		selected,
		ctx,
		fire: (event, payload) => handlers.get(event)?.(payload ?? {}, ctx),
		api: {
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
			registerTool: (tool: FakeTool) => {
				tools.set(tool.name, tool);
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
				if (fake.deliverThrows !== undefined) throw fake.deliverThrows;
				delivered.push({ content, deliverAs: options?.deliverAs });
			},
			// ExtensionAPI 有几十个 on 重载和别的方法，测试只需要这四个。
		} as unknown as ExtensionAPI,
	};
	return fake;
}

let root = "";
const savedAgent = process.env.FNXBUS_AGENT;
const savedProject = process.env.FNXBUS_PROJECT;
/**
 * `failInit` 会往 stderr 写一份（刻意的：I1 实测发现 `-p` 模式下拒绝注册完全静默，
 * 「总线为什么没工作」无从查）。测试里把它静音，否则几屏噪音会盖住真正的失败信息。
 */
const realStderrWrite = process.stderr.write.bind(process.stderr);

/** 建一个已初始化的项目根：`.fnxbus/` 下有 project.json 与 roles.json。 */
function initProject(roles?: unknown): void {
	const bus = join(root, ".fnxbus");
	mkdirSync(bus, { recursive: true });
	writeFileSync(join(bus, "project.json"), JSON.stringify({ root }), "utf8");
	writeFileSync(
		join(bus, "roles.json"),
		JSON.stringify(
			roles ?? {
				roles: {
					fnx_sw: { subscribe: ["ip_verified"], owns: ["sw/**"] },
					fnx_dv: { subscribe: ["build_failed"], owns: ["dv/**"] },
				},
			},
		),
		"utf8",
	);
}

/**
 * 往 fnx_sw 的 inbox 放一条合法消息。
 *
 * `proto`/`schema` 必须是**数字** 1 —— 写成 `"fnxbus/1"` 这类字符串会被契约层 reject，
 * 那就测不到 drain 的投递路径了（层 7 的步骤书里踩过这个坑，第一次跑整个废掉）。
 */
function putInbox(id: string, extra: Record<string, unknown> = {}): string {
	const dir = join(root, ".fnxbus", "inbox", "fnx_sw");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			id,
			proto: 1,
			schema: 1,
			from: "fnx_dv",
			to: "fnx_sw",
			type: "ip_verified",
			text: `测试消息 ${id}`,
			payload: { ip: "crc", verdict: "PASS" },
			files: [],
			fanout: false,
			thread_id: id,
			reply_to: null,
			ts: Date.now(),
			...extra,
		}),
		"utf8",
	);
	return path;
}

const inboxFiles = (): string[] => {
	const dir = join(root, ".fnxbus", "inbox", "fnx_sw");
	return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
};

const seenLines = (): string[] => {
	const p = join(root, ".fnxbus", "seen", "fnx_sw.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
};

const logEvents = (): string[] => {
	const p = join(root, ".fnxbus", "log.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l).event as string);
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fnxbus-ext-"));
	process.env.FNXBUS_AGENT = "fnx_sw";
	// 项目根一律显式指定：否则会向上找 .git，在仓库里跑测试时会认到仓库根上去
	process.env.FNXBUS_PROJECT = root;
	process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	if (savedAgent === undefined) delete process.env.FNXBUS_AGENT;
	else process.env.FNXBUS_AGENT = savedAgent;
	if (savedProject === undefined) delete process.env.FNXBUS_PROJECT;
	else process.env.FNXBUS_PROJECT = savedProject;
	rmSync(root, { recursive: true, force: true });
});

/** 起一个扩展实例并跑完 session_start。返回假 pi 以便断言。 */
function boot(opts: { hasUI?: boolean; idle?: boolean } = {}): FakePi {
	const pi = makeFakePi(root, opts);
	fnxbus(pi.api);
	pi.fire("session_start");
	return pi;
}

describe("drain 的两道守卫", () => {
	it("没有 UI 时只发不收：消息留在 inbox，一次都不投递", () => {
		// 层 7：-p 启动时 inbox 有积压 → 注入撞 `Agent is already processing`，
		// 整个调用退出码 1、消息还被记账删掉。所以这种模式根本不取消息。
		initProject();
		putInbox("01NOUI0001");

		const pi = boot({ hasUI: false });

		expect(inboxFiles()).toEqual(["01NOUI0001.json"]);
		expect(pi.delivered).toHaveLength(0);
		expect(seenLines()).toHaveLength(0);
		// 但注册本身要成功——它还得能发消息
		expect(logEvents()).toContain("registered");
		expect(logEvents()).not.toContain("inject");

		pi.fire("session_shutdown");
	});

	it("agent 正在干活时不取消息：消息留在 inbox", () => {
		// 层 4：gated 是同步置位的，而投递是排队的。忙时就取消息会让长流程被
		// 一条还没投递的消息拦住（交互模式弹框、-p 直接 block）。
		initProject();
		putInbox("01BUSY0001");

		const pi = boot({ idle: false });

		expect(inboxFiles()).toEqual(["01BUSY0001.json"]);
		expect(pi.delivered).toHaveLength(0);
		expect(seenLines()).toHaveLength(0);
		expect(logEvents()).toContain("registered");

		pi.fire("session_shutdown");
	});

	it("有 UI 且空闲：取走消息、记账、投递一次", () => {
		initProject();
		putInbox("01OK000001");

		const pi = boot();

		expect(inboxFiles()).toEqual([]);
		expect(pi.delivered).toHaveLength(1);
		expect(pi.delivered[0].deliverAs).toBe("followUp");
		expect(pi.delivered[0].content).toContain("fnx_dv");
		expect(seenLines()).toHaveLength(1);
		expect(JSON.parse(seenLines()[0]).id).toBe("01OK000001");
		expect(logEvents()).toContain("inject");

		pi.fire("session_shutdown");
	});

	it("两道守卫都放开后，之前留下的积压会被处理（启动补投）", () => {
		initProject();
		putInbox("01BACKLOG01");

		// 先用没有 UI 的实例起一次：消息该原地不动
		const first = boot({ hasUI: false });
		expect(inboxFiles()).toEqual(["01BACKLOG01.json"]);
		first.fire("session_shutdown");

		// 再用正常实例起：这次该被取走
		const second = boot();
		expect(inboxFiles()).toEqual([]);
		expect(second.delivered).toHaveLength(1);
		second.fire("session_shutdown");
	});
});

describe("消息丢失窗口（记录当前的取舍，不是主张它对）", () => {
	/**
	 * `drain` 的顺序是：记账 → 删 inbox 文件 → **最后**才排队投递。
	 *
	 * 所以投递这一步失败（或进程在模型读到之前退出），这条消息就是
	 * 「seen 里有、inbox 里没有、模型没看过」——**永久丢失且静默**。
	 *
	 * 这是刻意的取舍：宁可丢，不重复执行（源码注释写在 `drain` 里）。
	 * 这个测试把当前行为钉住：**哪天改成「宁可重复」，它会红**，而不是悄悄改掉。
	 */
	it("投递失败时，记账和删文件已经做完了 —— 消息丢了且无从恢复", () => {
		initProject();
		putInbox("01LOST00001");

		const pi = makeFakePi(root);
		pi.deliverThrows = new Error("投递失败（模拟进程在模型读到之前退出）");
		fnxbus(pi.api);

		// 投递抛错会一路传上来：session_start 里的 drain() 没有 try/catch。
		// 这一点本身值得记着——投递失败会让启动流程抛异常。
		expect(() => pi.fire("session_start")).toThrow("投递失败");

		// 消息的下场：账记了、文件删了、模型一个字没看到
		expect(seenLines()).toHaveLength(1);
		expect(JSON.parse(seenLines()[0]).id).toBe("01LOST00001");
		expect(inboxFiles()).toEqual([]);
		expect(pi.delivered).toHaveLength(0);
		expect(logEvents()).toContain("inject");
	});

	it("丢掉的消息重启也不会重来：seen 里有它，再 drain 直接跳过", () => {
		initProject();
		putInbox("01LOST00002");

		const first = makeFakePi(root);
		first.deliverThrows = new Error("投递失败");
		fnxbus(first.api);
		expect(() => first.fire("session_start")).toThrow();
		expect(inboxFiles()).toEqual([]);

		// 把文件放回去，模拟发送方重投同一个 id
		putInbox("01LOST00002");
		const second = boot();
		// seen 里已经有它，所以被跳过并删掉，不会再投递给模型
		expect(second.delivered).toHaveLength(0);
		expect(inboxFiles()).toEqual([]);
		second.fire("session_shutdown");
	});
});

describe("起不来的时候要说清原因", () => {
	it("没有角色表：不注册、状态栏标未接入、notify 给出出路", () => {
		const bus = join(root, ".fnxbus");
		mkdirSync(bus, { recursive: true });
		writeFileSync(join(bus, "project.json"), JSON.stringify({ root }), "utf8");

		const pi = boot();

		expect(pi.status.get("fnxbus")).toContain("未接入");
		expect(pi.notified.join("\n")).toContain("roles.json");
		expect(pi.notified.join("\n")).toContain("/bus-setup");
		expect(logEvents()).not.toContain("registered");
	});

	it("角色表里没有本端角色：指名说缺谁", () => {
		initProject({ roles: { fnx_dv: { subscribe: [], owns: [] } } });

		const pi = boot();

		expect(pi.status.get("fnxbus")).toContain("未接入");
		expect(pi.notified.join("\n")).toContain("fnx_sw");
		expect(logEvents()).not.toContain("registered");
	});

	it("角色名不合规就拒绝启动（它要当目录名用）", () => {
		initProject();
		process.env.FNXBUS_AGENT = "../../etc";

		const pi = boot();

		expect(pi.status.get("fnxbus")).toContain("未接入");
		expect(pi.notified.join("\n")).toContain("不合规");
	});

	it("初始化失败后 drain 不工作：消息原地不动", () => {
		// 没有角色表 → initError 非空 → drain 开头就返回
		const bus = join(root, ".fnxbus");
		mkdirSync(bus, { recursive: true });
		writeFileSync(join(bus, "project.json"), JSON.stringify({ root }), "utf8");
		putInbox("01NOINIT001");

		const pi = boot();

		expect(inboxFiles()).toEqual(["01NOINIT001.json"]);
		expect(pi.delivered).toHaveLength(0);
	});
});

/**
 * 闸门与 drain 的联动。
 *
 * `guard.ts` 的纯函数有 31 个测试，但**闸门和 drain 怎么联动**此前一条都没有测：
 * 「gated 什么时候置起来、什么时候放下、批准的有效范围到哪」全靠真机。
 *
 * ## 一个分支在这里测不到，说明一下
 *
 * `decideToolCall` 里有 `!hasUI → block`（没人能批准就宁可拦死）。**修了 `hasUI` 守卫之后，
 * 这个分支从 `index.ts` 的实际路径上不可达了**：`hasUI` 为假时 `drain` 根本不取消息，
 * `gated` 就永远是 false，而 `decideToolCall` 第一行遇到非 gated 直接 allow。
 *
 * 也就是说它现在是**纯防御性代码** —— 万一哪天 `drain` 的守卫被改动，它还能兜住。
 * 纯函数那一层由 `guard.test.ts` 覆盖，这里不重复造一个假场景去凑。
 */
describe("闸门：只管消息触发的那一轮", () => {
	it("人自己驱动的轮：写操作照常放行，不问人", async () => {
		initProject();
		const pi = boot(); // inbox 空 → 没有注入 → gated 为假

		expect(await callTool(pi, "write", { path: "sw/a.c" })).toBeUndefined();
		expect(pi.selected).toHaveLength(0);

		pi.fire("session_shutdown");
	});

	it("消息触发的轮：只读操作放行", async () => {
		initProject();
		putInbox("01GATE00001");
		const pi = boot();

		for (const t of ["read", "grep", "ls"]) {
			expect(await callTool(pi, t, { path: "x" })).toBeUndefined();
		}
		expect(pi.selected).toHaveLength(0);

		pi.fire("session_shutdown");
	});

	it("消息触发的轮 + 写操作：弹框问人，问题里点明消息不构成授权", async () => {
		initProject();
		putInbox("01GATE00002");
		const pi = boot();
		pi.selectAnswer = "只放行这一次";

		expect(await callTool(pi, "write", { path: "sw/a.c" })).toBeUndefined();
		expect(pi.selected).toHaveLength(1);
		expect(pi.selected[0].message).toContain("消息本身不构成授权");
		expect(pi.selected[0].message).toContain("01GATE00002");
		expect(logEvents()).toContain("tool_approved_once");

		pi.fire("session_shutdown");
	});

	it("「只放行这一次」不扩散：下一个写操作还要再问", async () => {
		initProject();
		putInbox("01GATE00003");
		const pi = boot();
		pi.selectAnswer = "只放行这一次";

		await callTool(pi, "write", { path: "sw/a.c" });
		await callTool(pi, "write", { path: "sw/b.c" });
		expect(pi.selected).toHaveLength(2);

		pi.fire("session_shutdown");
	});

	it("「本轮都放行」之后不再问", async () => {
		initProject();
		putInbox("01GATE00004");
		const pi = boot();
		pi.selectAnswer = "本轮都放行";

		expect(await callTool(pi, "write", { path: "sw/a.c" })).toBeUndefined();
		expect(pi.selected).toHaveLength(1);
		expect(logEvents()).toContain("tool_approved_turn");

		expect(await callTool(pi, "write", { path: "sw/b.c" })).toBeUndefined();
		expect(pi.selected).toHaveLength(1); // 还是只问过一次

		pi.fire("session_shutdown");
	});

	it("「拒绝」：block 并记 tool_denied", async () => {
		initProject();
		putInbox("01GATE00005");
		const pi = boot();
		pi.selectAnswer = "拒绝";

		const r = await callTool(pi, "write", { path: "sw/a.c" });
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("人拒绝");
		expect(logEvents()).toContain("tool_denied");

		pi.fire("session_shutdown");
	});

	it("bash 按命令内容判：只读的放行，写的要问", async () => {
		initProject();
		putInbox("01GATE00006");
		const pi = boot();
		pi.selectAnswer = "拒绝";

		// 这两条是实测踩过的形态（cd 串联、输出丢弃），必须放行
		expect(await callTool(pi, "bash", { command: "cd sw && find . -name '*.c'" })).toBeUndefined();
		expect(await callTool(pi, "bash", { command: "ls 2>/dev/null" })).toBeUndefined();
		expect(pi.selected).toHaveLength(0);

		const r = await callTool(pi, "bash", { command: "rm -rf sw/x" });
		expect(r?.block).toBe(true);

		pi.fire("session_shutdown");
	});
});

describe("闸门的开合与终态记账", () => {
	it("人主动输入释放闸门，并补记 handled", () => {
		initProject();
		putInbox("01REL00001");
		const pi = boot();
		expect(logEvents()).toContain("inject");

		pi.fire("input", { source: "interactive" });

		expect(logEvents()).toContain("gate_released");
		// 被人接管的轮走不到 agent_end，这里要补一笔终态，否则「处理完没」答不上来
		expect(logEvents()).toContain("handled");

		pi.fire("session_shutdown");
	});

	it("释放之后写操作不再问人", async () => {
		initProject();
		putInbox("01REL00002");
		const pi = boot();

		pi.fire("input", { source: "interactive" });

		expect(await callTool(pi, "write", { path: "sw/a.c" })).toBeUndefined();
		expect(pi.selected).toHaveLength(0);

		pi.fire("session_shutdown");
	});

	it("rpc 输入不释放闸门（那种场景下没有人在场）", async () => {
		initProject();
		putInbox("01REL00003");
		const pi = boot();
		pi.selectAnswer = "拒绝";

		pi.fire("input", { source: "rpc" });

		expect(logEvents()).not.toContain("gate_released");
		const r = await callTool(pi, "write", { path: "sw/a.c" });
		expect(r?.block).toBe(true); // 闸门还关着

		pi.fire("session_shutdown");
	});

	it("extension 来源的输入也不释放闸门（那是注入自己）", async () => {
		initProject();
		putInbox("01REL00004");
		const pi = boot();
		pi.selectAnswer = "拒绝";

		pi.fire("input", { source: "extension" });

		expect(logEvents()).not.toContain("gate_released");
		expect((await callTool(pi, "write", { path: "sw/a.c" }))?.block).toBe(true);

		pi.fire("session_shutdown");
	});

	it("agent_end 记 handled，并把「本轮都放行」收回", async () => {
		initProject();
		putInbox("01END00001");
		const pi = boot();
		pi.selectAnswer = "本轮都放行";

		await callTool(pi, "write", { path: "sw/a.c" });
		expect(pi.selected).toHaveLength(1);

		pi.fire("agent_end");
		expect(logEvents()).toContain("handled");

		// 一次批准不长期有效：下一轮的写操作要重新问
		await callTool(pi, "write", { path: "sw/b.c" });
		expect(pi.selected).toHaveLength(2);

		pi.fire("session_shutdown");
	});

	it("handled 只记一次（一条消息可能跨多轮）", () => {
		initProject();
		putInbox("01END00002");
		const pi = boot();

		pi.fire("agent_end");
		const once = logEvents().filter((e) => e === "handled").length;
		expect(once).toBe(1);

		pi.fire("agent_end");
		expect(logEvents().filter((e) => e === "handled").length).toBe(once);

		pi.fire("session_shutdown");
	});

	it("没有消息注入过就不会凭空记 handled", () => {
		initProject();
		const pi = boot(); // inbox 空

		pi.fire("agent_end");

		expect(logEvents()).not.toContain("handled");

		pi.fire("session_shutdown");
	});
});

/**
 * drain 的其余路径：去重、隔离、拒收回执。
 */
describe("drain：坏消息的下场", () => {
	/** 往 inbox 写一个原始字符串（不保证是合法 JSON），可选把 mtime 推到过去。 */
	function putRaw(id: string, raw: string, ageMs = 0): string {
		const dir = join(root, ".fnxbus", "inbox", "fnx_sw");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${id}.json`);
		writeFileSync(path, raw, "utf8");
		if (ageMs > 0) {
			const t = (Date.now() - ageMs) / 1000;
			utimesSync(path, t, t);
		}
		return path;
	}

	const badFiles = (): string[] => {
		const dir = join(root, ".fnxbus", "inbox", "fnx_sw", ".bad");
		return existsSync(dir) ? readdirSync(dir) : [];
	};

	it("刚写下的坏 JSON 先跳过，不当场判死", () => {
		// 实测踩过：fs.watch 在文件创建时就触发，一个 300KB 的消息被读到半截，
		// 报成「不是合法 JSON」并隔离 —— 原因说错了。所以太新的解析失败要等下一轮。
		initProject();
		putRaw("01HALF00001", '{"id":"01HALF00001","pro');

		const pi = boot();

		expect(inboxFiles()).toEqual(["01HALF00001.json"]); // 还在原地
		expect(badFiles()).toEqual([]); // 没被隔离
		expect(pi.delivered).toHaveLength(0);

		pi.fire("session_shutdown");
	});

	it("够旧的坏 JSON 才隔离到 .bad/，并且不静默删", () => {
		initProject();
		putRaw("01BAD000001", '{"id":"01BAD000001","pro', 5000);

		const pi = boot();

		expect(inboxFiles()).toEqual([]);
		expect(badFiles()).toEqual(["01BAD000001.json"]); // 留着原件，能查当时收到了什么
		expect(logEvents()).toContain("quarantined");
		expect(seenLines()).toHaveLength(1); // 记了账，不会再处理它
		expect(pi.delivered).toHaveLength(0);

		pi.fire("session_shutdown");
	});

	it("契约不过（schema 对不上）：拒收、不注入，但回不了通知", () => {
		initProject();
		putInbox("01REJ000001", { schema: 0 });

		const pi = boot();

		expect(pi.delivered).toHaveLength(0);
		expect(logEvents()).toContain("reject");
		/**
		 * 这里**没有** `rejected_notified`，是刻意的：`from` 取自解析后的消息
		 * （`parsed.ok ? parsed.message.from : ""`），契约不过就拿不到发送方是谁。
		 * 消息整体不可信时，里面的 `from` 也不可信，不能拿它当回信地址。
		 *
		 * 代价是这一类拒收发送方当场收不到回执，只能靠自己 `sent` 里那条久久没有回应
		 * 来发现。要改得先解决「怎么在不信任消息的前提下确定发送方」——那是 daemon 的事。
		 */
		expect(logEvents()).not.toContain("rejected_notified");
		expect(existsSync(join(root, ".fnxbus", "inbox", "fnx_dv"))).toBe(false);

		pi.fire("session_shutdown");
	});

	it("契约过了但 gate 层拒收：回通知给发送方，带上具体原因", () => {
		initProject();
		// 引用一个不存在的文件：结构合法，但摘要核对过不去
		putInbox("01REJ000002", {
			files: [{ role: "spec", path: "dv/nonexistent.md", sha256: "0".repeat(64) }],
		});

		const pi = boot();

		expect(pi.delivered).toHaveLength(0);
		expect(logEvents()).toContain("reject");
		expect(logEvents()).toContain("rejected_notified");

		const dvDir = join(root, ".fnxbus", "inbox", "fnx_dv");
		const replies = readdirSync(dvDir).filter((f) => f.endsWith(".json"));
		expect(replies).toHaveLength(1);
		const reply = JSON.parse(readFileSync(join(dvDir, replies[0]), "utf8"));
		expect(reply.type).toBe("rejected");
		expect(reply.reply_to).toBe("01REJ000002");
		expect(reply.payload.verdict).toBe("FAILED");
		expect(JSON.stringify(reply)).toContain("dv/nonexistent.md");

		pi.fire("session_shutdown");
	});

	it("seen 里已有的消息：直接删掉不再处理", () => {
		initProject();
		putInbox("01DUP000001");
		const first = boot();
		expect(first.delivered).toHaveLength(1);
		first.fire("session_shutdown");

		// 同一个 id 再投一次
		putInbox("01DUP000001");
		const second = boot();
		expect(second.delivered).toHaveLength(0);
		expect(inboxFiles()).toEqual([]);
		second.fire("session_shutdown");
	});
});

describe("bus_send：投给谁、不投给谁", () => {
	const fourRoles = {
		roles: {
			fnx_sw: { subscribe: ["ip_verified"], owns: ["sw/**"] },
			fnx_dv: { subscribe: ["build_failed"], owns: ["dv/**"] },
			fnx_pd: { subscribe: ["ip_verified"], owns: ["pd/**"] },
			fnx_ts: { subscribe: ["ip_verified"], owns: ["ts/**"] },
		},
	};

	const send = (pi: FakePi, params: Record<string, unknown>) => {
		const tool = pi.tools.get("bus_send");
		if (tool === undefined) throw new Error("bus_send 没注册");
		return tool.execute("call-1", params);
	};

	const inboxOf = (role: string): string[] => {
		const dir = join(root, ".fnxbus", "inbox", role);
		return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
	};

	it("三个工具和两个命令都注册上了", () => {
		initProject();
		const pi = boot();

		expect([...pi.tools.keys()].sort()).toEqual(["bus_peers", "bus_reply", "bus_send"]);
		expect(pi.commands.sort()).toEqual(["bus-setup", "bus-status"]);

		pi.fire("session_shutdown");
	});

	it("角色名不存在：当场报错，不写出一个没人取的 inbox 目录", async () => {
		initProject();
		const pi = boot();

		const r = await send(pi, { to: "fnx_nobody", type: "ip_verified", text: "x" });

		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("角色表里没有 fnx_nobody");
		expect(r.content[0].text).toContain("已知角色");
		expect(logEvents()).toContain("unknown_target");
		expect(existsSync(join(root, ".fnxbus", "inbox", "fnx_nobody"))).toBe(false);

		pi.fire("session_shutdown");
	});

	it("扇出：投给订阅了这个类型的角色，发送方自己不算", async () => {
		initProject(fourRoles);
		const pi = boot();

		const r = await send(pi, { to: "*", type: "ip_verified", text: "扇出测试" });

		expect(r.isError).toBeFalsy();
		// fnx_sw 自己订阅了 ip_verified，但它是发送方，要排除
		expect(inboxOf("fnx_sw")).toHaveLength(0);
		expect(inboxOf("fnx_pd")).toHaveLength(1);
		expect(inboxOf("fnx_ts")).toHaveLength(1);
		// fnx_dv 没订阅 ip_verified
		expect(inboxOf("fnx_dv")).toHaveLength(0);
		expect(r.content[0].text).toContain("2 个角色");

		pi.fire("session_shutdown");
	});

	it("扇出的每一份都是独立副本：to 改写成具体角色，fanout 为真", async () => {
		initProject(fourRoles);
		const pi = boot();

		await send(pi, { to: "*", type: "ip_verified", text: "副本测试" });

		const f = inboxOf("fnx_pd")[0];
		const m = JSON.parse(readFileSync(join(root, ".fnxbus", "inbox", "fnx_pd", f), "utf8"));
		expect(m.to).toBe("fnx_pd"); // 不是 "*"
		expect(m.fanout).toBe(true);
		expect(m.from).toBe("fnx_sw");

		pi.fire("session_shutdown");
	});

	it("扇出但没人订阅：算成功、只记日志、不投递（B5）", async () => {
		initProject(fourRoles);
		const pi = boot();

		const r = await send(pi, { to: "*", type: "driver_ready", text: "没人订阅这个" });

		expect(r.isError).toBe(false); // 是成功，不是错误
		expect(r.content[0].text).toContain("只记了日志");
		expect(logEvents()).toContain("no_subscriber");
		for (const role of ["fnx_dv", "fnx_pd", "fnx_ts"]) expect(inboxOf(role)).toHaveLength(0);

		pi.fire("session_shutdown");
	});

	it("带的文件不在自己 owns 范围内：提前挡住，别等对方拒收", async () => {
		initProject(fourRoles);
		mkdirSync(join(root, "pd"), { recursive: true });
		writeFileSync(join(root, "pd", "theirs.txt"), "不是我的产出", "utf8");
		const pi = boot();

		const r = await send(pi, {
			to: "fnx_dv",
			type: "ip_verified",
			text: "x",
			files: [{ role: "spec", path: "pd/theirs.txt" }],
		});

		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("不在 fnx_sw 的 owns 范围");
		expect(inboxOf("fnx_dv")).toHaveLength(0);

		pi.fire("session_shutdown");
	});

	it("带自己产出的文件：正常发出，摘要由总线算", async () => {
		initProject(fourRoles);
		mkdirSync(join(root, "sw"), { recursive: true });
		writeFileSync(join(root, "sw", "mine.c"), "int main(void){return 0;}", "utf8");
		const pi = boot();

		const r = await send(pi, {
			to: "fnx_dv",
			type: "ip_verified",
			text: "x",
			files: [{ role: "driver", path: "sw/mine.c" }],
		});

		expect(r.isError).toBeFalsy();
		const m = JSON.parse(readFileSync(join(root, ".fnxbus", "inbox", "fnx_dv", inboxOf("fnx_dv")[0]), "utf8"));
		expect(m.files).toHaveLength(1);
		expect(m.files[0].role).toBe("driver");
		expect(m.files[0].sha256).toMatch(/^[0-9a-f]{64}$/); // 总线自己算的
		expect(logEvents()).toContain("sent");

		pi.fire("session_shutdown");
	});

	it("总线没启用时，工具明确报未启用而不是假装成功", async () => {
		// 没有角色表 → initError 非空
		const bus = join(root, ".fnxbus");
		mkdirSync(bus, { recursive: true });
		writeFileSync(join(bus, "project.json"), JSON.stringify({ root }), "utf8");
		const pi = boot();

		const r = await send(pi, { to: "fnx_dv", type: "ip_verified", text: "x" });

		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("总线未启用");
	});
});
