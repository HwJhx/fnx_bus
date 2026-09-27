/**
 * fnxbus —— 文件队列（阶段一→二的过渡传输层）
 *
 * 为什么先用文件而不是 socket + daemon：阶段一实测证明**投递语义不是风险**
 * （C1 不打断 / C2 空闲即投 / C3+H2 离线补投 / D1 幂等 / H3 崩溃隔离都能做对），
 * 真正的风险在契约校验和授权闸门。所以先用最笨的传输把那两件事跑起来，
 * 第三步再决定换 socket + daemon（设计四~八节）还是 fork pi-a2a。
 *
 * 文件队列顺带绕开了 pi-a2a 的四条安全硬伤：不过网（E5/E7）、
 * 没有全员共用的明文凭据（E8：身份就是目录和文件的所有者）、没有免鉴权端点（E9）。
 * 代价是「拉起离线 agent」（C4）做不到——那本来就是第三步的事。
 *
 * 落盘的三条硬规矩，全部来自 H5 实测：
 *
 * 1. **写失败必须抛**，不许 `catch {}` 吞掉。pi-a2a 那个空 catch 让
 *    发送方收到「已送达」而一个字节都没写。
 * 2. **原子写**：`temp → fsync → rename`。`writeFileSync` 不是原子的，
 *    写一半崩了就是半截 JSON。
 * 3. **幂等表独立于消息本体且只增不减**。pi-a2a 的幂等就是「消息列表里有没有这个 id」，
 *    落盘失败、被另一个实例覆盖、或归档搬走之后，同 id 重投会**重新执行一遍**。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MAX_MESSAGE_BYTES } from "./contract.ts";

/** 名片：agent 在线时写，退出时删。 */
export interface AgentCard {
	agent: string;
	/** daemon 时代会由服务端分配；文件队列时期用 `<agent>#<pid>`。 */
	instance: string;
	cwd: string;
	pid: number;
	/** 订阅的消息类型（设计 5.2 声明式订阅）。 */
	subscribe: string[];
	/** 可写路径，相对项目根（设计 13.1 的 owns）。 */
	owns: string[];
	ts: number;
}

export interface LogEntry {
	ts: number;
	/** sent / delivered / injected / rejected / log_only / seen_hit / persist_failed … */
	event: string;
	id?: string;
	from?: string;
	to?: string;
	type?: string;
	reasons?: string[];
	warnings?: string[];
	unknownPayloadKeys?: string[];
	note?: string;
}

/** 项目根定位失败时抛这个，消息里直接写清怎么办（4.3.1 第 4 条：拒绝注册，不自动建）。 */
export class BusRootNotFound extends Error {}

/**
 * 总线状态目录名。
 *
 * **刻意不用任何 agent 的 `piConfig.configDir`**（`.forenyx` 之类）。
 * 那个值是每个 agent 自己定的：两个 agent 的 configDir 不一致时，它们会各找一个 bus 目录、
 * 谁也收不到谁的消息，而且不报错——是最难查的那种故障。现在两个 agent 恰好都是 `.forenyx`，
 * 但那是巧合，不是保证。
 *
 * 用一个与 agent 配置无关的固定名，总线的状态目录就只由**项目**决定，不由装了哪个 agent 决定。
 */
const BUS_DIR = ".fnxbus";

/**
 * 定位项目根，优先级见设计 4.3.1：
 *
 * 1. 人显式指定（`FNXBUS_PROJECT`）
 * 2. cwd 或任一祖先有 `.fnxbus/project.json`，取最近的
 * 3. 向上走到 git 仓库根
 * 4. 都找不到 → **抛错，不自动建**
 *
 * 第 4 条不自动建的理由：一旦建错，两个 agent 会落到不同的「项目」里，
 * 表现是「消息发了但对方收不到」，是最难查的一类故障。
 */
export function resolveProjectRoot(cwd: string, env: Record<string, string | undefined>): string {
	const explicit = env.FNXBUS_PROJECT;
	if (explicit !== undefined && explicit.length > 0) {
		const root = resolve(explicit);
		if (!existsSync(root)) throw new BusRootNotFound(`FNXBUS_PROJECT 指向的目录不存在：${root}`);
		return root;
	}

	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, BUS_DIR, "project.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	throw new BusRootNotFound(
		[
			"无法确定项目根，拒绝注册。",
			`  当前目录：${cwd}`,
			`  已向上查找 ${join(BUS_DIR, "project.json")} 与 .git，均未找到。`,
			"  请显式指定：FNXBUS_PROJECT=<项目根路径>",
			"  或在项目根执行：mkdir -p .fnxbus && echo '{}' > .fnxbus/project.json",
		].join("\n"),
	);
}

export function busDir(projectRoot: string): string {
	return join(projectRoot, BUS_DIR);
}

/**
 * 原子写：同目录 temp → fsync → rename。
 * **不 catch**——写失败要让调用方知道（H5 规矩 1）。
 */
export function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

/** 追加一行并 fsync。丢一行 seen 的后果是重复执行一次，值得等这个 fsync。 */
function appendLine(path: string, line: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a");
	try {
		writeSync(fd, `${line}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function writeCard(projectRoot: string, card: AgentCard): void {
	writeAtomic(join(busDir(projectRoot), "agents", `${card.agent}.json`), JSON.stringify(card, null, 2));
}

export function removeCard(projectRoot: string, agent: string): void {
	rmSync(join(busDir(projectRoot), "agents", `${agent}.json`), { force: true });
}

/**
 * 进程还活着吗。
 *
 * `EPERM` 是「进程在、只是不属于我」，照样算活着——只有 `ESRCH` 才是真没了。
 * 这条在 `acquireLock` 里踩过一次：不区分的话会把别人的锁抢掉。
 */
function isAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 读所有名片。坏掉的名片跳过并在返回值里说明，不让一个坏文件挡住整条路。
 *
 * **顺手清掉进程已死的名片**（`kill -9` 走不到 `session_shutdown`，名片会残留）。
 * 本机方案在这里比 pi-a2a 干净：名片里有 pid，直接探活就行，
 * 不需要「定期刷时间戳 + TTL 判过期」那一套——阶段一 A2 实测里，
 * pi-a2a 的两级 TTL（presence 35s / peers 缓存 60s）造成了约一分钟的「假在线」窗口。
 */
export function readCards(projectRoot: string): { cards: AgentCard[]; broken: string[]; stale: string[] } {
	const dir = join(busDir(projectRoot), "agents");
	const cards: AgentCard[] = [];
	const broken: string[] = [];
	const stale: string[] = [];
	if (!existsSync(dir)) return { cards, broken, stale };
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		let card: AgentCard;
		try {
			card = JSON.parse(readFileSync(join(dir, f), "utf8")) as AgentCard;
		} catch {
			broken.push(f);
			continue;
		}
		if (!isAlive(card.pid)) {
			stale.push(card.agent);
			rmSync(join(dir, f), { force: true });
			continue;
		}
		cards.push(card);
	}
	return { cards, broken, stale };
}

/**
 * 投一条消息进对方的 inbox。
 *
 * 不判断对方在不在线：在线的话 watcher 立刻看到，不在线的话它下次启动会扫到。
 * 「离线补投」在文件队列里是天然的，不需要 outbox（对比 pi-a2a 要维护 outbox +
 * 先白等一次超时，见 A2 实测）。
 */
export function putMessage(projectRoot: string, to: string, id: string, raw: string): string {
	const bytes = Buffer.byteLength(raw, "utf8");
	if (bytes > MAX_MESSAGE_BYTES) {
		throw new Error(`消息体 ${bytes} 字节，超过上限 ${MAX_MESSAGE_BYTES}。把大块内容写成文件、用 files 引用它`);
	}
	const dir = join(busDir(projectRoot), "inbox", to);
	if (existsSync(dir)) {
		const pending = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp.")).length;
		if (pending >= MAX_INBOX_FILES) {
			throw new Error(
				`${to} 的 inbox 已积压 ${pending} 条（上限 ${MAX_INBOX_FILES}），它可能没在运行。先让它消化，或查 log.jsonl`,
			);
		}
	}
	const path = join(dir, `${id}.json`);
	writeAtomic(path, raw);
	return path;
}

export interface InboxItem {
	id: string;
	path: string;
	raw: string;
	/** 文件最后修改时间。太新的文件可能还在被写，见 index.ts 的 WRITE_SETTLE_MS。 */
	mtimeMs: number;
	/** 读不出来的（半截 JSON、权限不足）也返回，由调用方记日志——不能静默跳过。 */
	error?: string;
}

/** 列出待处理的消息，按文件 mtime 从旧到新——先到先处理。 */
export function listInbox(projectRoot: string, agent: string): InboxItem[] {
	const dir = join(busDir(projectRoot), "inbox", agent);
	if (!existsSync(dir)) return [];
	const items: { item: InboxItem; mtime: number }[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json") || f.includes(".tmp.")) continue;
		const path = join(dir, f);
		try {
			const st = statSync(path);
			if (st.size > MAX_MESSAGE_BYTES) {
				// 读之前先量大小：超限的不读进内存，而且原因要说准
				// （pi-a2a 的 D5 拦住了，但把「体积超限」报成了「JSON 解析失败」）
				items.push({
					item: {
						id: f.slice(0, -5),
						path,
						raw: "",
						mtimeMs: st.mtimeMs,
						error: `体积 ${st.size} 字节，超过上限 ${MAX_MESSAGE_BYTES}`,
					},
					mtime: st.mtimeMs,
				});
				continue;
			}
			items.push({
				item: { id: f.slice(0, -5), path, raw: readFileSync(path, "utf8"), mtimeMs: st.mtimeMs },
				mtime: st.mtimeMs,
			});
		} catch (e) {
			items.push({
				item: { id: f.slice(0, -5), path, raw: "", mtimeMs: 0, error: e instanceof Error ? e.message : String(e) },
				mtime: 0,
			});
		}
	}
	return items.sort((a, b) => a.mtime - b.mtime).map((x) => x.item);
}

export function removeFromInbox(path: string): void {
	rmSync(path, { force: true });
}

/** 幂等表里的一行。`fp` 是内容指纹，供 D4 的内容级去重用。 */
export interface SeenRecord {
	id: string;
	fp: string;
	from: string;
	/** 这条消息所属的线程，回复时沿用它（B6）。 */
	thread: string;
	ts: number;
}

export interface SeenIndex {
	ids: Set<string>;
	/** 最近若干条，按时间从旧到新。D4 的内容去重与速率上限都看这个。 */
	recent: SeenRecord[];
}

/** `recent` 只留这么多条。一天几十条的量级，留 200 条够覆盖任何合理的窗口。 */
const RECENT_KEEP = 200;

/**
 * 单个 inbox 的积压上限。
 *
 * 超了**拒绝新投递**，不像 pi-a2a 那样 FIFO 丢最旧——文件队列里旧消息是别人的数据，
 * 丢它更糟；拒绝新投递能让发送方当场知道。
 */
export const MAX_INBOX_FILES = 500;

/** 已处理的 id + 最近记录。独立文件、只增不减（H5 规矩 3）。 */
export function loadSeen(projectRoot: string, agent: string): SeenIndex {
	const path = join(busDir(projectRoot), "seen", `${agent}.jsonl`);
	const index: SeenIndex = { ids: new Set<string>(), recent: [] };
	if (!existsSync(path)) return index;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.length === 0) continue;
		try {
			const r = JSON.parse(line) as Partial<SeenRecord>;
			if (typeof r.id !== "string") continue;
			index.ids.add(r.id);
			index.recent.push({
				id: r.id,
				fp: typeof r.fp === "string" ? r.fp : "",
				from: typeof r.from === "string" ? r.from : "",
				thread: typeof r.thread === "string" ? r.thread : r.id,
				ts: typeof r.ts === "number" ? r.ts : 0,
			});
		} catch {
			// 坏行跳过：幂等表宁可漏一条（重复执行一次）也不能整表读不出来
		}
	}
	if (index.recent.length > RECENT_KEEP) index.recent = index.recent.slice(-RECENT_KEEP);
	return index;
}

export function appendSeen(projectRoot: string, agent: string, rec: SeenRecord, note: string): void {
	appendLine(join(busDir(projectRoot), "seen", `${agent}.jsonl`), JSON.stringify({ ...rec, note }));
}

/**
 * 内容指纹：同一个发送方、同一个类型、同样的 payload 就是同一条内容。
 *
 * D4 用它做内容级去重。按 `messageId` 的幂等对「换个 id 再发一遍同样的东西」无效，
 * 而实测里的 ACK 风暴正是这种形态。`text` 不进指纹——同一件事换句话说还是同一件事。
 */
export function fingerprint(type: string, from: string, payload: unknown): string {
	const stable = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(stable);
		if (v !== null && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v as Record<string, unknown>).sort()) {
				out[k] = stable((v as Record<string, unknown>)[k]);
			}
			return out;
		}
		return v;
	};
	return createHash("sha256")
		.update(JSON.stringify({ type, from, payload: stable(payload) }))
		.digest("hex")
		.slice(0, 16);
}

/**
 * 我发出过的消息 id。只增不减，供 gate.ts 校验 `reply_to`。
 *
 * 阶段一 E8：DV 察觉自己被冒充，靠的是「收到一堆 `Re:` 某条我没发过的消息」，
 * 但那只能靠 LLM 自己注意到。有了这份记录，对不上号就是可以程序判定的信号。
 */
export function appendSent(projectRoot: string, agent: string, id: string, to: string): void {
	appendLine(join(busDir(projectRoot), "sent", `${agent}.jsonl`), JSON.stringify({ id, to, ts: Date.now() }));
}

export function loadSentIds(projectRoot: string, agent: string): Set<string> {
	const path = join(busDir(projectRoot), "sent", `${agent}.jsonl`);
	const ids = new Set<string>();
	if (!existsSync(path)) return ids;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.length === 0) continue;
		try {
			const id = (JSON.parse(line) as { id?: unknown }).id;
			if (typeof id === "string") ids.add(id);
		} catch {
			/* 坏行跳过 */
		}
	}
	return ids;
}

/**
 * 抢一个 agent 的单实例锁。
 *
 * A3 实测（pi-a2a）：同一个目录起两个实例，投递静默挑一个、状态文件乒乓覆盖丢消息。
 * 文件队列里症状不同但同样错：两个实例抢同一个 inbox，都读到同一条、
 * 都不在自己的 seen 里，于是**重复处理**。
 *
 * 所以这里不去「支持」多实例，而是**只允许一个**：`O_EXCL` 抢锁，抢不到就看锁里的
 * pid 还活着没——活着则拒绝注册并指名它，死了（崩溃没删锁）才抢占。
 *
 * 返回 undefined 表示抢到了；否则返回占着锁的 pid。
 */
export function acquireLock(projectRoot: string, agent: string): number | undefined {
	const path = join(busDir(projectRoot), "locks", `${agent}.lock`);
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeSync(fd, String(process.pid));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return undefined;
		} catch {
			let holder = Number.NaN;
			try {
				holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
			} catch {
				/* 锁文件读不了，当成陈旧锁抢占 */
			}
			if (Number.isFinite(holder) && holder !== process.pid && isAlive(holder)) return holder;
			rmSync(path, { force: true });
		}
	}
	return undefined;
}

export function releaseLock(projectRoot: string, agent: string): void {
	rmSync(join(busDir(projectRoot), "locks", `${agent}.lock`), { force: true });
}

/**
 * 审计日志：每个状态变迁一行。
 *
 * F2/F3/F4 实测全部不达标，教训是三条：状态要是**真的**状态变迁（不能一进门就写
 * `COMPLETED`）、失败要有**准确原因**（不能把「体积超限」报成「JSON 解析失败」）、
 * 时间戳要够细（秒级算不出耗时）。
 */
export function appendLog(projectRoot: string, entry: LogEntry): void {
	appendLine(join(busDir(projectRoot), "log.jsonl"), JSON.stringify(entry));
}

/** 实算摘要，供 gate.ts 的 `shaOf`。文件不存在或读不了都返回 undefined。 */
export function shaOf(projectRoot: string, relPath: string): string | undefined {
	try {
		return createHash("sha256")
			.update(readFileSync(join(projectRoot, relPath)))
			.digest("hex");
	} catch {
		return undefined;
	}
}

/** 发消息时自己算一遍，免得手写摘要（B4 实测里发送方写过「(未计算)」）。 */
export function shaOfOrThrow(projectRoot: string, relPath: string): string {
	const s = shaOf(projectRoot, relPath);
	if (s === undefined) throw new Error(`算不了摘要：${relPath} 不存在或读不了（相对项目根 ${projectRoot}）`);
	return s;
}

/**
 * 单调递增的消息 id，形如 `01JBX…`（ULID 的简化版：时间前缀 + 随机后缀）。
 * 不引依赖——这里只需要「按时间可排序 + 不重复」。
 */
export function newId(): string {
	const t = Date.now().toString(36).toUpperCase().padStart(9, "0");
	const r = createHash("sha256")
		.update(`${process.pid}:${process.hrtime.bigint()}:${Math.random()}`)
		.digest("hex")
		.slice(0, 10)
		.toUpperCase();
	return `01${t}${r}`;
}

/** git 根，仅用于 `/bus-status` 显示，定位项目根用 `resolveProjectRoot`。 */
export function gitRoot(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}
