/**
 * fnxbus —— 角色表的解析与校验
 *
 * 总线现在只有 `fnx_sw` / `fnx_dv` 两个角色，但产品要上 5 个，而且以后还会加。
 * 所以路由、扇出、单实例锁、inbox/seen/sent 目录**一律按角色表的键来**，
 * 代码里没有任何地方写死角色名（`DEFAULT_ROLES` 只是「开箱可用」的兜底）。
 *
 * 加第 N 个角色要做的事只有一件：往 `<项目根>/.fnxbus/roles.json` 里加一段。
 * 这个文件存在的意义就是把「加一个角色」这件事该校验的都校验掉：
 *
 * | 校验 | 为什么 |
 * |---|---|
 * | 角色名字符集 | 角色名会当**文件名和目录名**用（`inbox/<agent>/`、`locks/<agent>.lock`）。不校验的话 `FNXBUS_AGENT=../../etc` 就是路径穿越 |
 * | roles.json 结构 | 5 个角色的配置是手写的，`owns` 写成字符串而不是数组这种错要当场报，不能默默当成空 |
 * | `owns` 重叠 | 两个角色都声称能写 `software/**` 时，「文件归属」这条硬要求就失效了。设计里提过 `fnxbus doctor` 要查这个 |
 *
 * 纯函数，可单测。
 */

import { globMatch } from "./gate.ts";

export interface Role {
	subscribe: string[];
	owns: string[];
}

export interface RolesConfig {
	roles: Record<string, Role>;
	/** 别的扩展的只读工具，报备了就不会被闸门白问一次。 */
	readonlyTools: Set<string>;
}

/**
 * 角色名：小写字母开头，只允许小写字母、数字、下划线、连字符，最长 32。
 *
 * 卡得这么死是因为它直接当文件名用。宁可让人改名，也不要去做路径转义。
 */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 角色名合法吗。返回 undefined 表示合法，否则是给人看的原因。 */
export function validateAgentName(name: string): string | undefined {
	if (name.length === 0) return "角色名为空";
	if (!AGENT_NAME_RE.test(name)) {
		return `角色名 ${JSON.stringify(name)} 不合规。角色名会当目录名和文件名用，只允许小写字母开头、由小写字母/数字/下划线/连字符组成、不超过 32 个字符`;
	}
	return undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const strArray = (v: unknown, where: string, errors: string[]): string[] => {
	if (v === undefined) return [];
	if (!Array.isArray(v)) {
		errors.push(`${where}: 必须是字符串数组，收到 ${JSON.stringify(v)}`);
		return [];
	}
	const out: string[] = [];
	v.forEach((x, i) => {
		if (typeof x === "string" && x.length > 0) out.push(x);
		else errors.push(`${where}[${i}]: 必须是非空字符串，收到 ${JSON.stringify(x)}`);
	});
	return out;
};

/**
 * 解析 roles.json。两种写法都支持：
 *
 * - 旧：整个文件就是 `{ "<角色>": { subscribe, owns } }`
 * - 新：`{ "roles": { … }, "readonlyTools": [ … ] }`
 *
 * 有错就返回错（连同已经解析出来的部分），由调用方决定是拒绝启动还是退回默认。
 */
export function parseRolesFile(raw: unknown): { config: RolesConfig; errors: string[] } {
	const errors: string[] = [];
	const config: RolesConfig = { roles: {}, readonlyTools: new Set() };

	if (!isRecord(raw)) {
		return { config, errors: ["roles.json 顶层不是对象"] };
	}

	const hasNewShape = isRecord(raw.roles);
	if (raw.roles !== undefined && !hasNewShape) {
		errors.push(`roles: 必须是对象，收到 ${JSON.stringify(raw.roles)}`);
	}
	const rolesRaw = hasNewShape ? (raw.roles as Record<string, unknown>) : raw;

	for (const [name, body] of Object.entries(rolesRaw)) {
		// 旧写法下，顶层的 readonlyTools 会混进来，跳过它
		if (!hasNewShape && name === "readonlyTools") continue;
		const nameErr = validateAgentName(name);
		if (nameErr !== undefined) {
			errors.push(`roles 里的键：${nameErr}`);
			continue;
		}
		if (!isRecord(body)) {
			errors.push(`roles.${name}: 必须是对象，收到 ${JSON.stringify(body)}`);
			continue;
		}
		const subscribe = strArray(body.subscribe, `roles.${name}.subscribe`, errors);
		const owns = strArray(body.owns, `roles.${name}.owns`, errors);
		for (const p of owns) {
			if (p.startsWith("/") || p.split(/[\\/]/).includes("..")) {
				errors.push(`roles.${name}.owns: ${p} 必须是相对项目根的路径，且不含 ".."`);
			}
		}
		config.roles[name] = { subscribe, owns };
	}

	for (const t of strArray(raw.readonlyTools, "readonlyTools", errors)) config.readonlyTools.add(t);

	return { config, errors };
}

/**
 * 从一个 owns 模式造一条「代表性路径」，用来判两个模式会不会撞。
 *
 * 直接比字面前缀会误报：`chip/rtl/ips/*​/docs/**` 和 `chip/rtl/ips/*​/model/**`
 * 截断到第一个通配符都是 `chip/rtl/ips/`，但它们其实碰不到一起。
 * 用代表路径 + `globMatch` 双向试就准得多。
 */
function representativePath(pattern: string): string {
	return pattern
		.split("/")
		.map((seg) => {
			if (seg === "**") return "__x/__y";
			if (seg.includes("*") || seg.includes("?")) return "__z";
			return seg;
		})
		.join("/");
}

export interface OwnsOverlap {
	a: string;
	b: string;
	pattern: string;
	otherPattern: string;
}

/**
 * 找出 owns 有重叠的角色对。
 *
 * 这是个 warning 而不是拒绝：重叠有时是刻意的（比如一个角色只读另一个的产出），
 * 但那种情况该在角色表里写清，而不是靠两边都声称 owns。
 */
export function findOwnsOverlaps(roles: Record<string, Role>): OwnsOverlap[] {
	const out: OwnsOverlap[] = [];
	const names = Object.keys(roles).sort();
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			for (const pa of roles[names[i]].owns) {
				for (const pb of roles[names[j]].owns) {
					if (globMatch(pb, representativePath(pa)) || globMatch(pa, representativePath(pb))) {
						out.push({ a: names[i], b: names[j], pattern: pa, otherPattern: pb });
					}
				}
			}
		}
	}
	return out;
}

/**
 * 给人一段可以直接粘进 roles.json 的模板。
 *
 * 「加一个角色」不该需要去翻文档或读源码——报错里就把该填的东西给出来。
 */
export function rolesTemplate(agent: string, rolesPath: string): string {
	return [
		`请在 ${rolesPath} 的 "roles" 里加一段，例如：`,
		"",
		`  "${agent}": {`,
		`    "subscribe": ["<这个角色要处理的消息类型>"],`,
		`    "owns": ["${agent.replace(/^fnx_/, "")}/**"]`,
		"  }",
		"",
		"subscribe 决定它能收到哪些扇出消息（指名发给它的一律能收到）；",
		"owns 是它可写的路径，相对项目根，不要和别的角色重叠。",
	].join("\n");
}
