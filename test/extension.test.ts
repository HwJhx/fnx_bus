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

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface FakePi {
	/** 注册进来的事件处理器，按事件名存。 */
	handlers: Map<string, Handler>;
	/** `sendUserMessage` 的调用记录——「投递了几次、投了什么」。 */
	delivered: { content: string; deliverAs?: string }[];
	/** 让下一次 `sendUserMessage` 抛这个错，用来测「投递失败时记账已经落盘了没」。 */
	deliverThrows?: Error;
	notified: string[];
	status: Map<string, string>;
	/** 触发某个事件；没注册就返回 undefined。 */
	fire(event: string, payload?: unknown): unknown;
	api: ExtensionAPI;
	ctx: FakeCtx;
}

function makeFakePi(root: string, opts: { hasUI?: boolean; idle?: boolean } = {}): FakePi {
	const handlers = new Map<string, Handler>();
	const delivered: { content: string; deliverAs?: string }[] = [];
	const notified: string[] = [];
	const status = new Map<string, string>();

	const ctx: FakeCtx = {
		cwd: root,
		hasUI: opts.hasUI ?? true,
		isIdle: () => opts.idle ?? true,
		ui: {
			notify: (m) => notified.push(m),
			setStatus: (k, v) => status.set(k, v),
			select: async (_m, options) => options[options.length - 1],
			input: async (_m, initial) => initial ?? "",
		},
	};

	const fake: FakePi = {
		handlers,
		delivered,
		notified,
		status,
		ctx,
		fire: (event, payload) => handlers.get(event)?.(payload ?? {}, ctx),
		api: {
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
			registerTool: () => {},
			registerCommand: () => {},
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
