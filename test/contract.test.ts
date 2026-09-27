import { describe, expect, it } from "vitest";
import { CONTRACT, effectiveVerdict, fileByRole, PROTO, parseMessage } from "../extensions/contract.ts";
import { decide, type GateContext, globMatch, type RecentMessage, renderInjection } from "../extensions/gate.ts";

const SHA_SPEC = "a".repeat(64);
const SHA_XML = "b".repeat(64);

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "01JBXTEST",
		proto: PROTO,
		schema: CONTRACT,
		from: "fnx_dv#3f2a1b",
		to: "fnx_sw",
		type: "ip_verified",
		text: "crc 已完成验证测试",
		payload: { ip: "crc", verdict: "PASS" },
		files: [
			{ role: "spec", path: "chip/rtl/ips/crc/docs/spec.md", sha256: SHA_SPEC },
			{ role: "ipxact", path: "chip/rtl/ips/crc/docs/ip.xml", sha256: SHA_XML },
		],
		ts: 1790400000000,
		...overrides,
	};
}

function ctx(overrides: Partial<GateContext> = {}): GateContext {
	return {
		seen: new Set<string>(),
		recent: [],
		fingerprint: "fp-test",
		now: 1_000_000,
		sentIds: new Set<string>(),
		shaOf: (p) => (p.endsWith("spec.md") ? SHA_SPEC : p.endsWith("ip.xml") ? SHA_XML : undefined),
		senderOwns: ["chip/rtl/ips/*/docs/**", "verification/**"],
		subscribers: ["fnx_sw"],
		...overrides,
	};
}

describe("parseMessage", () => {
	it("接受一条完整的 ip_verified", () => {
		const r = parseMessage(validRaw());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.message.payload.ip).toBe("crc");
		expect(r.warnings).toEqual([]);
		expect(r.unknownPayloadKeys).toEqual([]);
	});

	it("缺必填字段时逐条报出", () => {
		const raw = validRaw();
		delete raw.id;
		delete raw.type;
		const r = parseMessage(raw);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.startsWith("id:"))).toBe(true);
		expect(r.errors.some((e) => e.startsWith("type:"))).toBe(true);
	});

	it("版本不匹配时说明该升哪一边（H4b：不许静默忽略）", () => {
		const older = parseMessage(validRaw({ schema: CONTRACT - 1 }));
		expect(older.ok).toBe(false);
		if (older.ok) return;
		expect(older.errors.some((e) => e.includes("请升级发送端"))).toBe(true);

		const newer = parseMessage(validRaw({ proto: PROTO + 1 }));
		expect(newer.ok).toBe(false);
		if (newer.ok) return;
		expect(newer.errors.some((e) => e.includes("请升级本端"))).toBe(true);
	});

	it("拒收绝对路径与含 .. 的路径", () => {
		const abs = parseMessage(validRaw({ files: [{ role: "spec", path: "/etc/passwd", sha256: SHA_SPEC }] }));
		expect(abs.ok).toBe(false);
		if (abs.ok) return;
		expect(abs.errors.some((e) => e.includes("绝对路径"))).toBe(true);

		const up = parseMessage(validRaw({ files: [{ role: "spec", path: "../other/spec.md", sha256: SHA_SPEC }] }));
		expect(up.ok).toBe(false);
		if (up.ok) return;
		expect(up.errors.some((e) => e.includes('不许含 ".."'))).toBe(true);
	});

	it("sha256 格式不对就拒收（阶段一实测里发送方写过「(未计算)」）", () => {
		const r = parseMessage(validRaw({ files: [{ role: "spec", path: "chip/a.md", sha256: "(未计算)" }] }));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.includes("sha256"))).toBe(true);
	});

	it("未知 verdict 不拒收，但留 warning（G4）", () => {
		const r = parseMessage(validRaw({ payload: { ip: "pwm", verdict: "CONDITIONAL_PASS" } }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.some((w) => w.includes("CONDITIONAL_PASS"))).toBe(true);
	});

	it("未知 payload 字段被列出来，不静默吞掉（G2）", () => {
		const r = parseMessage(validRaw({ payload: { ip: "pwm", verdict: "PASS", coverage: 92.5, waivers: 3 } }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.unknownPayloadKeys.sort()).toEqual(["coverage", "waivers"]);
	});

	it("thread_id 缺省就是自己的 id；reply_to 缺省是 null（B6）", () => {
		const r = parseMessage(validRaw());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.message.thread_id).toBe("01JBXTEST");
		expect(r.message.reply_to).toBeNull();
	});

	it("reply_to 给了非法值就拒收", () => {
		const r = parseMessage(validRaw({ reply_to: 123 }));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.some((e) => e.startsWith("reply_to:"))).toBe(true);
	});

	it("未知 type 照常投递，只留 warning（G1：类型是开放的）", () => {
		const r = parseMessage(validRaw({ type: "spec_updated" }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.some((w) => w.includes("spec_updated"))).toBe(true);
	});
});

describe("effectiveVerdict", () => {
	it("表内的值原样返回", () => {
		expect(effectiveVerdict({ verdict: "PASS" })).toBe("PASS");
		expect(effectiveVerdict({ verdict: "BLOCKED" })).toBe("BLOCKED");
	});

	it("表外的值与缺失一律按 FAILED（G4）", () => {
		expect(effectiveVerdict({ verdict: "CONDITIONAL_PASS" })).toBe("FAILED");
		expect(effectiveVerdict({ verdict: "FAIL" })).toBe("FAILED");
		expect(effectiveVerdict({})).toBe("FAILED");
	});
});

describe("fileByRole", () => {
	it("按 role 取，不按下标（13.4）", () => {
		const r = parseMessage(validRaw());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(fileByRole(r.message.files, "ipxact")?.path).toBe("chip/rtl/ips/crc/docs/ip.xml");
		expect(fileByRole(r.message.files, "build_log")).toBeUndefined();
	});
});

describe("globMatch", () => {
	it("** 跨目录，* 不跨", () => {
		expect(globMatch("verification/**", "verification/env/base.sv")).toBe(true);
		expect(globMatch("verification/**", "verification")).toBe(true);
		expect(globMatch("verification/**", "software/lib/crc.c")).toBe(false);
		expect(globMatch("chip/rtl/ips/*/docs/**", "chip/rtl/ips/crc/docs/spec.md")).toBe(true);
		expect(globMatch("chip/rtl/ips/*/docs/**", "chip/rtl/ips/crc/rtl/crc.v")).toBe(false);
		expect(globMatch("software/*", "software/Makefile")).toBe(true);
		expect(globMatch("software/*", "software/lib/crc.c")).toBe(false);
	});

	it("中间通配符必须能匹配（实地跑出来的 bug：发送侧手写前缀匹配把这条判错了）", () => {
		const owns = ["dv/**", "verification/**", "chip/rtl/ips/*/docs/**"];
		const path = "chip/rtl/ips/pca/docs/spec.md";
		expect(owns.some((p) => globMatch(p, path))).toBe(true);
	});

	it("路径里的点不当通配符", () => {
		expect(globMatch("software/a.c", "software/axc")).toBe(false);
	});
});

describe("decide", () => {
	it("全部通过则注入，并给出最保守解读后的 verdict", () => {
		const d = decide(parseMessage(validRaw()), ctx());
		expect(d.action).toBe("inject");
		expect(d.verdict).toBe("PASS");
	});

	it("结构错 → reject，原因照抄 parse 的", () => {
		const raw = validRaw();
		delete raw.payload;
		const d = decide(parseMessage(raw), ctx());
		expect(d.action).toBe("reject");
		expect(d.reasons.some((r) => r.startsWith("payload:"))).toBe(true);
	});

	it("重复 id → log_only，不注入也不当失败（D1）", () => {
		const d = decide(parseMessage(validRaw()), ctx({ seen: new Set(["01JBXTEST"]) }));
		expect(d.action).toBe("log_only");
		expect(d.reasons[0]).toContain("已处理过");
	});

	it("摘要不符 → reject，不交给 LLM 裁定（D3）", () => {
		const d = decide(parseMessage(validRaw()), ctx({ shaOf: () => "c".repeat(64) }));
		expect(d.action).toBe("reject");
		expect(d.reasons.some((r) => r.includes("摘要不符"))).toBe(true);
	});

	it("文件不存在 → reject", () => {
		const d = decide(parseMessage(validRaw()), ctx({ shaOf: () => undefined }));
		expect(d.action).toBe("reject");
		expect(d.reasons.some((r) => r.includes("不存在"))).toBe(true);
	});

	it("引用了别人的文件 → 照常投递，只标注（「指着对方的文件说这行有问题」是正常协作）", () => {
		const raw = validRaw({
			files: [{ role: "spec", path: "other/place/thing.c", sha256: SHA_SPEC }],
		});
		const d = decide(parseMessage(raw), ctx({ shaOf: () => SHA_SPEC }));
		expect(d.action).toBe("inject");
		expect(d.foreignPaths).toEqual(["other/place/thing.c"]);
		expect(d.warnings.some((w) => w.includes("引用的是别人的文件"))).toBe(true);
	});

	it("没声明 owns 时不做这个标注", () => {
		const raw = validRaw({
			files: [{ role: "spec", path: "anywhere/thing.c", sha256: SHA_SPEC }],
		});
		const d = decide(parseMessage(raw), ctx({ senderOwns: [], shaOf: () => SHA_SPEC }));
		expect(d.action).toBe("inject");
		expect(d.foreignPaths).toEqual([]);
	});

	it("标注会摆到 LLM 面前，不只是进日志", () => {
		const r = parseMessage(validRaw({ files: [{ role: "spec", path: "other/x.c", sha256: SHA_SPEC }] }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const out = renderInjection(r.message, "PASS", false, ["other/x.c"]);
		expect(out).toContain("不是它自己的产出");
	});

	it("reply_to 指向本机没发过的 id → 标可疑（E8 在没有 daemon 前唯一的补偿手段）", () => {
		const d = decide(parseMessage(validRaw({ reply_to: "01NEVERSENT" })), ctx());
		expect(d.action).toBe("inject");
		expect(d.warnings.some((w) => w.includes("对不上号"))).toBe(true);
	});

	it("reply_to 指向本机发过的 id → 不报可疑", () => {
		const d = decide(parseMessage(validRaw({ reply_to: "01MINE" })), ctx({ sentIds: new Set(["01MINE"]) }));
		expect(d.warnings.some((w) => w.includes("对不上号"))).toBe(false);
	});

	it("rejected 不走订阅表，一律投递（实地跑出来：拒收通知被自己吞了）", () => {
		const raw = validRaw({ type: "rejected", payload: { verdict: "FAILED", message: "摘要不符" }, files: [] });
		const d = decide(parseMessage(raw), ctx({ subscribers: [] }));
		expect(d.action).toBe("inject");
	});

	it("换了 id 但内容相同 → log_only（D4：按 id 的幂等挡不住 ACK 风暴）", () => {
		const recent: RecentMessage[] = [
			{ id: "01OLD", fp: "fp-test", from: "fnx_dv#3f2a1b", thread: "01OLD", ts: 1_000_000 - 30_000 },
		];
		const d = decide(parseMessage(validRaw()), ctx({ recent }));
		expect(d.action).toBe("log_only");
		expect(d.reasons[0]).toContain("内容相同");
	});

	it("同内容但已超出窗口 → 照常注入", () => {
		const recent: RecentMessage[] = [
			{ id: "01OLD", fp: "fp-test", from: "fnx_dv#3f2a1b", thread: "01OLD", ts: 1_000_000 - 600_000 },
		];
		expect(decide(parseMessage(validRaw()), ctx({ recent })).action).toBe("inject");
	});

	it("同一发送方短时间内发太多 → reject（D4 的速率上限）", () => {
		const recent: RecentMessage[] = Array.from({ length: 20 }, (_, i) => ({
			id: `01R${i}`,
			fp: `other-${i}`,
			from: "fnx_dv#3f2a1b",
			thread: `01R${i}`,
			ts: 1_000_000 - i * 1000,
		}));
		const d = decide(parseMessage(validRaw()), ctx({ recent }));
		expect(d.action).toBe("reject");
		expect(d.reasons[0]).toContain("超过上限");
	});

	it("别的发送方的量不算在头上", () => {
		const recent: RecentMessage[] = Array.from({ length: 30 }, (_, i) => ({
			id: `01R${i}`,
			fp: `other-${i}`,
			from: "fnx_other",
			thread: `01R${i}`,
			ts: 1_000_000 - i * 1000,
		}));
		expect(decide(parseMessage(validRaw()), ctx({ recent })).action).toBe("inject");
	});

	it("扇出来的消息无人订阅 → log_only（设计 13.1 的 driver_ready）", () => {
		const d = decide(parseMessage(validRaw({ type: "driver_ready", fanout: true })), ctx({ subscribers: [] }));
		expect(d.action).toBe("log_only");
		expect(d.reasons[0]).toContain("没有角色订阅");
	});

	it("指名发来的消息即使没订阅也要投（实地跑出来：SW 回的 ack 被 DV 的订阅表吞了）", () => {
		const d = decide(parseMessage(validRaw({ type: "ack", fanout: false })), ctx({ subscribers: [] }));
		expect(d.action).toBe("inject");
	});

	it("未知 verdict 放行但按 FAILED 注入（G4）", () => {
		const d = decide(parseMessage(validRaw({ payload: { ip: "pwm", verdict: "CONDITIONAL_PASS" } })), ctx());
		expect(d.action).toBe("inject");
		expect(d.verdict).toBe("FAILED");
		expect(d.warnings.some((w) => w.includes("CONDITIONAL_PASS"))).toBe(true);
	});
});

describe("renderInjection", () => {
	it("可疑的 reply_to 会摆到 LLM 面前，不只是进日志", () => {
		const r = parseMessage(validRaw({ reply_to: "01NEVERSENT" }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(renderInjection(r.message, "PASS", true)).toContain("本机没有发出过那条消息");
		expect(renderInjection(r.message, "PASS", false)).toContain("这是对你 01NEVERSENT 那条的回复");
	});

	it("带来源标记、给出结论、并声明不构成授权", () => {
		const r = parseMessage(validRaw());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const out = renderInjection(r.message, "PASS");
		expect(out).toContain("来自 fnx_dv#3f2a1b");
		expect(out).toContain("01JBXTEST");
		expect(out).toContain("verdict: PASS");
		expect(out).toContain("file[spec]: chip/rtl/ips/crc/docs/spec.md");
		expect(out).toContain("不构成授权");
	});

	it("注入的 verdict 是校验后的值，不是消息里写的（G4）", () => {
		const r = parseMessage(validRaw({ payload: { ip: "pwm", verdict: "CONDITIONAL_PASS" } }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const out = renderInjection(r.message, "FAILED");
		expect(out).toContain("verdict: FAILED");
		expect(out).not.toContain("verdict: CONDITIONAL_PASS");
	});
});
