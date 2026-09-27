import { describe, expect, it } from "vitest";
import { findOwnsOverlaps, parseRolesFile, type Role, rolesTemplate, validateAgentName } from "../extensions/roles.ts";

describe("validateAgentName", () => {
	it("接受正常的角色名", () => {
		for (const n of ["fnx_sw", "fnx_dv", "fnx-pd", "a", "a1_b-c"]) {
			expect(validateAgentName(n)).toBeUndefined();
		}
	});

	it("拒绝会造成路径穿越的名字（角色名直接当目录名用）", () => {
		for (const n of ["../../etc", "a/b", "..", "./x", "a\\b"]) {
			expect(validateAgentName(n)).toMatch(/不合规/);
		}
	});

	it("拒绝空名、大写开头、超长", () => {
		expect(validateAgentName("")).toBe("角色名为空");
		expect(validateAgentName("FNX_SW")).toMatch(/不合规/);
		expect(validateAgentName("1abc")).toMatch(/不合规/);
		expect(validateAgentName("a".repeat(33))).toMatch(/不合规/);
	});
});

describe("parseRolesFile", () => {
	const newShape = {
		roles: {
			fnx_sw: { subscribe: ["ip_verified"], owns: ["sw/**"] },
			fnx_dv: { subscribe: ["build_failed"], owns: ["dv/**"] },
		},
		readonlyTools: ["a2a_inbox"],
	};

	it("新写法：roles + readonlyTools", () => {
		const { config, errors } = parseRolesFile(newShape);
		expect(errors).toEqual([]);
		expect(Object.keys(config.roles).sort()).toEqual(["fnx_dv", "fnx_sw"]);
		expect(config.readonlyTools.has("a2a_inbox")).toBe(true);
	});

	it("旧写法：整个文件就是角色表", () => {
		const { config, errors } = parseRolesFile({
			fnx_sw: { subscribe: ["ip_verified"], owns: ["sw/**"] },
		});
		expect(errors).toEqual([]);
		expect(Object.keys(config.roles)).toEqual(["fnx_sw"]);
	});

	it("加第三个角色不需要改代码，解析出来就是三个", () => {
		const { config, errors } = parseRolesFile({
			roles: {
				...newShape.roles,
				fnx_pd: { subscribe: ["ip_verified", "driver_ready"], owns: ["pd/**"] },
			},
		});
		expect(errors).toEqual([]);
		expect(Object.keys(config.roles).sort()).toEqual(["fnx_dv", "fnx_pd", "fnx_sw"]);
		expect(config.roles.fnx_pd.subscribe).toEqual(["ip_verified", "driver_ready"]);
	});

	it("owns 写成字符串而不是数组 → 当场报，不默默当空", () => {
		const { errors } = parseRolesFile({ roles: { fnx_sw: { subscribe: [], owns: "sw/**" } } });
		expect(errors.some((e) => e.includes("roles.fnx_sw.owns"))).toBe(true);
	});

	it("角色名不合规 → 报错并跳过这个角色", () => {
		const { config, errors } = parseRolesFile({ roles: { "../evil": { subscribe: [], owns: [] } } });
		expect(errors.some((e) => e.includes("不合规"))).toBe(true);
		expect(Object.keys(config.roles)).toEqual([]);
	});

	it("owns 写绝对路径或含 .. → 报错", () => {
		const abs = parseRolesFile({ roles: { fnx_sw: { subscribe: [], owns: ["/etc/**"] } } });
		expect(abs.errors.some((e) => e.includes("相对项目根"))).toBe(true);
		const up = parseRolesFile({ roles: { fnx_sw: { subscribe: [], owns: ["../other/**"] } } });
		expect(up.errors.some((e) => e.includes("相对项目根"))).toBe(true);
	});

	it("顶层不是对象 → 报错", () => {
		expect(parseRolesFile([]).errors.length).toBeGreaterThan(0);
		expect(parseRolesFile("x").errors.length).toBeGreaterThan(0);
	});
});

describe("findOwnsOverlaps", () => {
	const of = (m: Record<string, string[]>): Record<string, Role> =>
		Object.fromEntries(Object.entries(m).map(([k, owns]) => [k, { subscribe: [], owns }]));

	it("完全相同的 owns 算重叠", () => {
		const o = findOwnsOverlaps(of({ a: ["software/**"], b: ["software/**"] }));
		expect(o.length).toBe(1);
		expect([o[0].a, o[0].b]).toEqual(["a", "b"]);
	});

	it("一个包住另一个算重叠", () => {
		expect(findOwnsOverlaps(of({ a: ["software/**"], b: ["software/lib/**"] })).length).toBe(1);
		expect(findOwnsOverlaps(of({ a: ["chip/rtl/**"], b: ["chip/rtl/ips/*/docs/**"] })).length).toBe(1);
	});

	it("并列的兄弟目录不算重叠（别字面比前缀，会误报）", () => {
		expect(findOwnsOverlaps(of({ a: ["sw/**"], b: ["dv/**"] }))).toEqual([]);
		expect(findOwnsOverlaps(of({ a: ["chip/rtl/ips/*/docs/**"], b: ["chip/rtl/ips/*/model/**"] }))).toEqual([]);
	});

	it("当前两个角色的真实配置没有重叠", () => {
		expect(
			findOwnsOverlaps(
				of({
					fnx_sw: ["sw/**", "software/**"],
					fnx_dv: ["dv/**", "verification/**", "chip/rtl/ips/*/docs/**"],
				}),
			),
		).toEqual([]);
	});

	it("加一个 owns 撞车的新角色会被查出来", () => {
		const o = findOwnsOverlaps(
			of({
				fnx_sw: ["sw/**", "software/**"],
				fnx_pd: ["software/bsp/**"],
			}),
		);
		expect(o.length).toBe(1);
		// 角色名排序后 fnx_pd 在前，所以 a/pattern 是它那一侧
		expect([o[0].a, o[0].b]).toEqual(["fnx_pd", "fnx_sw"]);
		expect([o[0].pattern, o[0].otherPattern].sort()).toEqual(["software/**", "software/bsp/**"]);
	});
});

describe("rolesTemplate", () => {
	it("给出可以直接粘贴的片段", () => {
		const t = rolesTemplate("fnx_pd", "/p/.fnxbus/roles.json");
		expect(t).toContain("/p/.fnxbus/roles.json");
		expect(t).toContain('"fnx_pd": {');
		expect(t).toContain('"subscribe"');
		expect(t).toContain('"owns"');
	});
});
