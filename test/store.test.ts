import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireLock,
	appendSeen,
	appendSent,
	BusRootNotFound,
	busDir,
	findInitializedRoot,
	fingerprint,
	listInbox,
	loadSeen,
	loadSentIds,
	MAX_INBOX_FILES,
	newId,
	putMessage,
	readCards,
	releaseLock,
	removeCard,
	removeFromInbox,
	resolveProjectRoot,
	shaOf,
	shaOfOrThrow,
	writeAtomic,
	writeCard,
} from "../extensions/store.ts";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fnxbus-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
	it("FNXBUS_PROJECT 优先级最高", () => {
		expect(resolveProjectRoot(join(root, "sw"), { FNXBUS_PROJECT: root })).toBe(root);
	});

	it("FNXBUS_PROJECT 指向不存在的目录 → 抛错，不静默回退", () => {
		expect(() => resolveProjectRoot(root, { FNXBUS_PROJECT: join(root, "nope") })).toThrow(BusRootNotFound);
	});

	it("取最近的带 .fnxbus/project.json 的祖先", () => {
		const inner = join(root, "a", "b");
		mkdirSync(join(inner, "sw"), { recursive: true });
		mkdirSync(join(root, ".fnxbus"), { recursive: true });
		writeFileSync(join(root, ".fnxbus", "project.json"), "{}");
		mkdirSync(join(inner, ".fnxbus"), { recursive: true });
		writeFileSync(join(inner, ".fnxbus", "project.json"), "{}");
		expect(resolveProjectRoot(join(inner, "sw"), {})).toBe(inner);
	});

	it("退到 git 根", () => {
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, "sw"), { recursive: true });
		expect(resolveProjectRoot(join(root, "sw"), {})).toBe(root);
	});

	it("都找不到 → 抛错，报错里写清怎么办（4.3.1 第 4 条：不自动建）", () => {
		// tmp 目录本身不在 git 仓库里，向上也不会撞到 project.json
		let msg = "";
		try {
			resolveProjectRoot(root, {});
		} catch (e) {
			msg = e instanceof Error ? e.message : String(e);
		}
		expect(msg).toContain("拒绝注册");
		expect(msg).toContain("FNXBUS_PROJECT");
	});
});

describe("writeAtomic", () => {
	it("写完内容正确且不留 .tmp 残留", () => {
		const path = join(root, "sub", "a.json");
		writeAtomic(path, '{"x":1}');
		expect(readFileSync(path, "utf8")).toBe('{"x":1}');
		expect(readdirSync(join(root, "sub")).filter((f) => f.includes(".tmp."))).toEqual([]);
	});

	it("覆盖已有文件", () => {
		const path = join(root, "a.json");
		writeAtomic(path, "old");
		writeAtomic(path, "new");
		expect(readFileSync(path, "utf8")).toBe("new");
	});

	it("写不进去就抛，不静默（H5 规矩 1）", () => {
		// 用一个已存在的普通文件当目录，mkdirSync 会失败
		writeFileSync(join(root, "blocker"), "x");
		expect(() => writeAtomic(join(root, "blocker", "a.json"), "x")).toThrow();
	});
});

describe("名片", () => {
	it("写入、读出、删除", () => {
		writeCard(root, {
			agent: "fnx_sw",
			instance: "fnx_sw#123",
			cwd: join(root, "sw"),
			pid: process.pid,
			subscribe: ["ip_verified"],
			owns: ["sw/**"],
			ts: 1,
		});
		expect(readCards(root).cards.map((c) => c.agent)).toEqual(["fnx_sw"]);
		removeCard(root, "fnx_sw");
		expect(readCards(root).cards).toEqual([]);
	});

	it("进程已死的名片被清掉，不报假在线（kill -9 走不到清理）", () => {
		writeCard(root, {
			agent: "fnx_ghost",
			instance: "fnx_ghost#999999",
			cwd: root,
			pid: 999999,
			subscribe: [],
			owns: [],
			ts: 1,
		});
		const { cards, stale } = readCards(root);
		expect(cards).toEqual([]);
		expect(stale).toEqual(["fnx_ghost"]);
		// 清掉了，再读一次也没有
		expect(readCards(root).stale).toEqual([]);
	});

	it("自己的名片（pid 活着）不会被当成陈旧", () => {
		writeCard(root, {
			agent: "fnx_sw",
			instance: `fnx_sw#${process.pid}`,
			cwd: root,
			pid: process.pid,
			subscribe: [],
			owns: [],
			ts: 1,
		});
		expect(readCards(root).cards.map((c) => c.agent)).toEqual(["fnx_sw"]);
	});

	it("坏名片被单独列出，不挡住其他名片", () => {
		writeCard(root, {
			agent: "fnx_dv",
			instance: `fnx_dv#${process.pid}`,
			cwd: root,
			pid: process.pid,
			subscribe: [],
			owns: [],
			ts: 1,
		});
		writeFileSync(join(busDir(root), "agents", "broken.json"), "{ not json");
		const { cards, broken } = readCards(root);
		expect(cards.map((c) => c.agent)).toEqual(["fnx_dv"]);
		expect(broken).toEqual(["broken.json"]);
	});
});

describe("inbox", () => {
	it("投递、列出、删除", () => {
		putMessage(root, "fnx_sw", "01A", '{"id":"01A"}');
		putMessage(root, "fnx_sw", "01B", '{"id":"01B"}');
		const items = listInbox(root, "fnx_sw");
		expect(items.map((i) => i.id).sort()).toEqual(["01A", "01B"]);
		removeFromInbox(items[0].path);
		expect(listInbox(root, "fnx_sw").length).toBe(1);
	});

	it("读不出来的条目也返回，带 error，不静默跳过", () => {
		const dir = join(busDir(root), "inbox", "fnx_sw");
		mkdirSync(dir, { recursive: true });
		mkdirSync(join(dir, "01BAD.json")); // 目录冒充消息文件 → readFileSync 报 EISDIR
		const items = listInbox(root, "fnx_sw");
		expect(items.length).toBe(1);
		expect(items[0].error).toBeDefined();
	});

	it("不把 .tmp 中间文件当消息", () => {
		const dir = join(busDir(root), "inbox", "fnx_sw");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "01C.json.tmp.1.2"), "{}");
		expect(listInbox(root, "fnx_sw")).toEqual([]);
	});

	it("目标目录不存在时返回空而不是抛", () => {
		expect(listInbox(root, "nobody")).toEqual([]);
	});
});

describe("幂等表", () => {
	it("往返，且独立于消息本体（H5 规矩 3）", () => {
		appendSeen(root, "fnx_sw", { id: "01A", fp: "aa", from: "fnx_dv", thread: "01A", ts: 1 }, "inject");
		appendSeen(root, "fnx_sw", { id: "01B", fp: "bb", from: "fnx_dv", thread: "01B", ts: 2 }, "reject");
		const seen = loadSeen(root, "fnx_sw");
		expect(seen.ids.has("01A")).toBe(true);
		expect(seen.ids.has("01B")).toBe(true);
		// 消息本体删干净了，幂等表照旧
		rmSync(join(busDir(root), "inbox"), { recursive: true, force: true });
		expect(loadSeen(root, "fnx_sw").ids.size).toBe(2);
	});

	it("recent 带上指纹与发送方，供内容去重与速率上限用", () => {
		appendSeen(root, "fnx_sw", { id: "01A", fp: "aa", from: "fnx_dv", thread: "01A", ts: 1000 }, "inject");
		const { recent } = loadSeen(root, "fnx_sw");
		expect(recent).toEqual([{ id: "01A", fp: "aa", from: "fnx_dv", thread: "01A", ts: 1000 }]);
	});

	it("坏行跳过，不让整表读不出来", () => {
		appendSeen(root, "fnx_sw", { id: "01A", fp: "aa", from: "fnx_dv", thread: "01A", ts: 1 }, "inject");
		writeFileSync(join(busDir(root), "seen", "fnx_sw.jsonl"), `{"id":"01A"}\n{ 坏行\n{"id":"01C"}\n`);
		const seen = loadSeen(root, "fnx_sw");
		expect(seen.ids.has("01A")).toBe(true);
		expect(seen.ids.has("01C")).toBe(true);
	});

	it("表不存在时返回空集", () => {
		expect(loadSeen(root, "fnx_sw").ids.size).toBe(0);
	});
});

describe("fingerprint", () => {
	it("同类型同发送方同 payload → 同指纹；键顺序不影响", () => {
		const a = fingerprint("ip_verified", "fnx_dv", { ip: "crc", verdict: "PASS" });
		const b = fingerprint("ip_verified", "fnx_dv", { verdict: "PASS", ip: "crc" });
		expect(a).toBe(b);
	});

	it("换发送方、换类型、换 payload 都换指纹", () => {
		const base = fingerprint("ip_verified", "fnx_dv", { ip: "crc" });
		expect(fingerprint("ip_verified", "fnx_xx", { ip: "crc" })).not.toBe(base);
		expect(fingerprint("build_failed", "fnx_dv", { ip: "crc" })).not.toBe(base);
		expect(fingerprint("ip_verified", "fnx_dv", { ip: "pwm" })).not.toBe(base);
	});
});

describe("摘要", () => {
	it("算出的值与已知 sha256 一致", () => {
		writeFileSync(join(root, "a.txt"), "hello");
		// echo -n hello | shasum -a 256
		expect(shaOf(root, "a.txt")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	});

	it("文件不存在返回 undefined，shaOfOrThrow 抛", () => {
		expect(shaOf(root, "nope.txt")).toBeUndefined();
		expect(() => shaOfOrThrow(root, "nope.txt")).toThrow(/算不了摘要/);
	});
});

describe("newId", () => {
	it("不重复且按时间可排序", () => {
		const ids = Array.from({ length: 50 }, () => newId());
		expect(new Set(ids).size).toBe(50);
		expect(ids.every((i) => i.startsWith("01"))).toBe(true);
		expect([...ids].sort()).toEqual(ids.map((x) => x).sort());
	});
});

describe("busDir", () => {
	it("布局是 <项目根>/.fnxbus，与任何 agent 的 configDir 无关", () => {
		expect(busDir("/p")).toBe(join("/p", ".fnxbus"));
		expect(existsSync(root)).toBe(true);
	});
});

describe("体积与积压上限", () => {
	it("超过体积上限就抛，原因说的是体积不是 JSON（D5）", () => {
		const big = JSON.stringify({ x: "y".repeat(300 * 1024) });
		expect(() => putMessage(root, "fnx_sw", "01BIG", big)).toThrow(/超过上限/);
	});

	it("读取时也先量大小，不把超限的文件读进内存", () => {
		const dir = join(busDir(root), "inbox", "fnx_sw");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "01BIG.json"), "z".repeat(300 * 1024));
		const items = listInbox(root, "fnx_sw");
		expect(items.length).toBe(1);
		expect(items[0].error).toMatch(/体积/);
		expect(items[0].raw).toBe("");
		expect(items[0].mtimeMs).toBeGreaterThan(0);
	});

	it("积压到上限就拒绝新投递，不丢旧的（D6）", () => {
		const dir = join(busDir(root), "inbox", "fnx_sw");
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < MAX_INBOX_FILES; i++) writeFileSync(join(dir, `01Q${i}.json`), "{}");
		expect(() => putMessage(root, "fnx_sw", "01NEW", "{}")).toThrow(/已积压/);
		// 旧的一条都没少
		expect(readdirSync(dir).length).toBe(MAX_INBOX_FILES);
	});
});

describe("发出过的 id", () => {
	it("往返", () => {
		appendSent(root, "fnx_sw", "01S1", "fnx_dv");
		appendSent(root, "fnx_sw", "01S2", "fnx_dv");
		const ids = loadSentIds(root, "fnx_sw");
		expect(ids.has("01S1")).toBe(true);
		expect(ids.has("01S2")).toBe(true);
		expect(ids.has("01NOPE")).toBe(false);
	});
});

describe("单实例锁", () => {
	it("第一次抢到，第二次（同 pid）也算抢到", () => {
		expect(acquireLock(root, "fnx_sw")).toBeUndefined();
		expect(acquireLock(root, "fnx_sw")).toBeUndefined();
	});

	it("锁里是一个活着的别人的 pid → 抢不到，返回它", () => {
		const dir = join(busDir(root), "locks");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "fnx_sw.lock"), "1"); // pid 1 一定活着
		expect(acquireLock(root, "fnx_sw")).toBe(1);
	});

	it("锁里是个死 pid → 抢占（崩溃没删锁的情况）", () => {
		const dir = join(busDir(root), "locks");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "fnx_sw.lock"), "999999");
		expect(acquireLock(root, "fnx_sw")).toBeUndefined();
	});

	it("放锁之后能再抢", () => {
		expect(acquireLock(root, "fnx_dv")).toBeUndefined();
		releaseLock(root, "fnx_dv");
		writeFileSync(join(busDir(root), "locks", "fnx_dv.lock"), "1");
		expect(acquireLock(root, "fnx_dv")).toBe(1);
	});
});

describe("findInitializedRoot（/bus-setup 用它给候选排序）", () => {
	it("找得到最近的那个已初始化的祖先", () => {
		const inner = join(root, "a", "b");
		mkdirSync(join(inner, "sw"), { recursive: true });
		mkdirSync(join(root, ".fnxbus"), { recursive: true });
		writeFileSync(join(root, ".fnxbus", "project.json"), "{}");
		mkdirSync(join(inner, ".fnxbus"), { recursive: true });
		writeFileSync(join(inner, ".fnxbus", "project.json"), "{}");
		expect(findInitializedRoot(join(inner, "sw"))).toBe(inner);
	});

	it("从子目录往上找得到（第二个 agent 的场景）", () => {
		mkdirSync(join(root, ".fnxbus"), { recursive: true });
		writeFileSync(join(root, ".fnxbus", "project.json"), "{}");
		mkdirSync(join(root, "dv"), { recursive: true });
		expect(findInitializedRoot(join(root, "dv"))).toBe(root);
	});

	it("没初始化过就返回 undefined（新项目的正常情况）", () => {
		mkdirSync(join(root, "sw"), { recursive: true });
		expect(findInitializedRoot(join(root, "sw"))).toBeUndefined();
	});

	it("只有目录没有 project.json 不算初始化过", () => {
		mkdirSync(join(root, ".fnxbus"), { recursive: true });
		expect(findInitializedRoot(root)).toBeUndefined();
	});
});
