import { describe, expect, it } from "vitest";
import { classifyToolCall, decideToolCall, freshGuardState, type GuardState, splitShell } from "../extensions/guard.ts";

const writes = (tool: string, input: Record<string, unknown>) => classifyToolCall(tool, input).writes;
const bash = (command: string) => classifyToolCall("bash", { command }).writes;

describe("classifyToolCall", () => {
	it("write / edit 算有副作用", () => {
		expect(writes("write", { path: "software/lib/crc/src/crc.c" })).toBe(true);
		expect(writes("edit", { path: "a.c" })).toBe(true);
	});

	it("内置只读工具与总线自己的工具放行", () => {
		for (const t of ["read", "grep", "find", "ls"]) expect(writes(t, {})).toBe(false);
		for (const t of ["bus_send", "bus_reply", "bus_inbox", "bus_peers", "bus_status"]) {
			expect(writes(t, {})).toBe(false);
		}
	});

	it("不认识的自定义工具当有副作用（判断不了就保守）", () => {
		expect(writes("sw_graph_run", {})).toBe(true);
	});

	it("bash 白名单内的只读命令放行", () => {
		expect(bash("cat software/lib/crc/src/crc.c")).toBe(false);
		expect(bash("ls -la chip/rtl/ips")).toBe(false);
		expect(bash("grep -n TXE docs/spec.md")).toBe(false);
		expect(bash("shasum -a 256 spec.md")).toBe(false);
		expect(bash("git status --porcelain")).toBe(false);
		expect(bash("git log --oneline | head -20")).toBe(false);
		expect(bash("FNX_DEBUG=1 cat a.txt")).toBe(false);
	});

	it("cd 前缀的纯探索命令放行（实地跑出来的可用性问题：问太频闸门就等于没有）", () => {
		expect(bash("cd /home/jhx/work_a2a/ProjectA && find chip -maxdepth 5 | head -100")).toBe(false);
		expect(bash("cd x && ls -la chip/rtl/ips/pca/docs/ && wc -l chip/rtl/ips/pca/docs/*.md")).toBe(false);
	});

	it("但 cd 后面跟着写操作照样拦住", () => {
		expect(bash("cd software && make")).toBe(true);
		expect(bash("cd /tmp && rm -rf cache")).toBe(true);
		expect(bash("cd x && python3 gen_ll.py")).toBe(true);
	});

	it("binutils 只读工具放行", () => {
		expect(bash("objdump -d build/smoke.elf | head")).toBe(false);
		expect(bash("readelf -S build/smoke.elf")).toBe(false);
	});

	it("shell 关键字不当命令：只读循环放行（实地跑出来的第二个缺口）", () => {
		expect(bash('cd x; for f in .fnxsw/ips/*.json; do echo "--- $f"; cat "$f"; done')).toBe(false);
		expect(bash("if grep -q TXE spec.md; then echo found; fi")).toBe(false);
		expect(bash("while read l; do echo $l; done")).toBe(false);
	});

	it("循环体里有写操作照样拦住（`do` 不能当成只读命令放行）", () => {
		expect(bash("for f in *.o; do rm $f; done")).toBe(true);
		expect(bash("if true; then make; fi")).toBe(true);
		expect(bash("for d in lib hal; do mkdir -p $d; done")).toBe(true);
	});

	it("引号里的分隔符不当分隔符（实地跑出来的第三个缺口）", () => {
		expect(bash("env | grep -iE 'FORENYX|VENV|SKILL|SW_'")).toBe(false);
		expect(bash('grep -n "a;b" spec.md')).toBe(false);
		expect(bash("echo 'rm -rf /'")).toBe(false);
	});

	it("2>&1 不算写文件，2>err.log 算", () => {
		expect(bash("ls /nope 2>&1")).toBe(false);
		expect(bash("ls /nope 2>err.log")).toBe(true);
	});

	it("重定向到 /dev/null 不算写（实地跑出来的第四个缺口：2>/dev/null 到处都是）", () => {
		expect(bash("ls -la chip/rtl/ips/pca/docs/ 2>/dev/null")).toBe(false);
		expect(bash("cat a 2> /dev/null")).toBe(false);
		expect(bash("find / -name x 2>/dev/null | head")).toBe(false);
		expect(bash("cat a > /dev/null")).toBe(false);
	});

	it("目标缺失的重定向保守算写", () => {
		expect(bash("cat a >")).toBe(true);
	});

	it("E1 那条命令被判为有副作用", () => {
		expect(bash("rm -rf /tmp/build-cache-old")).toBe(true);
	});

	it("重定向与 tee 一律算写，哪怕前面那截只读", () => {
		expect(bash("cat a.txt > b.txt")).toBe(true);
		expect(bash("cat a.txt >> b.txt")).toBe(true);
		expect(bash("ls | tee out.txt")).toBe(true);
	});

	it("复合命令里有一段是写就算写", () => {
		expect(bash("cat a.txt && rm b.txt")).toBe(true);
		expect(bash("ls; make")).toBe(true);
	});

	it("命令替换无法判定 → 算写", () => {
		expect(bash("cat $(find . -name '*.c')")).toBe(true);
		expect(bash("echo `whoami`")).toBe(true);
	});

	it("B2 那一批动作都被判为有副作用", () => {
		expect(bash("cd /tmp/sw-graph/scripts; python3 gen_ll.py --work-dir /x --ip crc")).toBe(true);
		expect(bash("cd software && make")).toBe(true);
		expect(bash("mkdir -p software/lib/crc/src")).toBe(true);
	});

	it("git 的写子命令不放行", () => {
		expect(bash("git checkout .")).toBe(true);
		expect(bash("git reset --hard")).toBe(true);
		expect(bash("git clean -fd")).toBe(true);
	});

	it("空命令与只有赋值的命令当写（判断不了）", () => {
		expect(bash("")).toBe(true);
		expect(bash("FOO=bar")).toBe(true);
	});
});

describe("decideToolCall", () => {
	const gated = (over: Partial<GuardState> = {}): GuardState => ({
		gated: true,
		gateMessageId: "01JBXTEST",
		approvedForTurn: false,
		...over,
	});

	it("本轮不是消息触发的 → 一律放行（人自己干活不受影响）", () => {
		const s = freshGuardState();
		expect(decideToolCall(s, { writes: true, why: "x" }, true, "write").verdict).toBe("allow");
	});

	it("消息触发的轮里，只读调用照常放行", () => {
		expect(decideToolCall(gated(), { writes: false, why: "read 是只读工具" }, true, "read").verdict).toBe("allow");
	});

	it("消息触发的轮里，有副作用的调用要问人（B2/E1）", () => {
		const d = decideToolCall(gated(), { writes: true, why: "会写 a.c" }, true, "write");
		expect(d.verdict).toBe("ask");
		expect(d.reason).toBe("会写 a.c");
	});

	it("人已为本轮放行后不再重复问", () => {
		expect(decideToolCall(gated({ approvedForTurn: true }), { writes: true, why: "x" }, true, "write").verdict).toBe(
			"allow",
		);
	});

	it("没有 UI 时一律 block，不是放行（-p / rpc 模式下没人能批准）", () => {
		const d = decideToolCall(gated(), { writes: true, why: "rm 不在白名单里" }, false, "bash");
		expect(d.verdict).toBe("block");
		expect(d.reason).toContain("01JBXTEST");
		expect(d.reason).toContain("没有 UI");
	});
});

describe("splitShell", () => {
	it("重定向目标不进词表（它不是命令的参数）", () => {
		expect(splitShell("cat a > b").map((x) => x.words)).toEqual([["cat", "a"]]);
		expect(splitShell("wc -l f 2>/dev/null").map((x) => x.words)).toEqual([["wc", "-l", "f"]]);
	});

	it("按未被引用的分隔符切段", () => {
		expect(splitShell("cat a; ls b && wc -l c").map((s) => s.words)).toEqual([
			["cat", "a"],
			["ls", "b"],
			["wc", "-l", "c"],
		]);
	});

	it("单引号与双引号里的内容当一个词，分隔符不生效", () => {
		expect(splitShell("grep -iE 'A|B;C' f").map((s) => s.words)).toEqual([["grep", "-iE", "A|B;C", "f"]]);
		expect(splitShell('echo "x && y"').map((s) => s.words)).toEqual([["echo", "x && y"]]);
	});

	it("认出输出重定向，但 2>&1 与 /dev/null 不算", () => {
		expect(splitShell("cat a 2>/dev/null")[0].redirectsOut).toBe(false);
		expect(splitShell("cat a > b")[0].redirectsOut).toBe(true);
		expect(splitShell("cat a >> b")[0].redirectsOut).toBe(true);
		expect(splitShell("ls 2>&1")[0].redirectsOut).toBe(false);
	});

	it("认出命令替换", () => {
		expect(splitShell("cat $(ls)")[0].hasSubstitution).toBe(true);
		expect(splitShell("echo `date`")[0].hasSubstitution).toBe(true);
		expect(splitShell('echo "$(date)"')[0].hasSubstitution).toBe(true);
	});

	it("反斜杠转义的分隔符不切段", () => {
		expect(splitShell("echo a\\;b").map((s) => s.words)).toEqual([["echo", "a;b"]]);
	});
});
