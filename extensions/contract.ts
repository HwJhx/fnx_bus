/**
 * fnxbus —— 消息契约与结构校验
 *
 * 契约定义见 `docs/claude/多agent互通-设计.md` 13.3。这里是它的可执行版本。
 *
 * 两条不对称的规则，都是阶段一实测逼出来的：
 *
 * 1. **`type` 与 `role` 开放，`verdict` 闭合。**
 *    G1 实测：新类型要能加而不改基础设施代码，所以 `type` 不是枚举。
 *    G4 实测：`verdict: "CONDITIONAL_PASS"` 被接收方当成通过直接开跑，
 *    session 全文只出现过一次（消息原文本身）——它根本没看见。
 *    所以 `verdict` 必须闭合，不在枚举里的值由 gate.ts 按最保守处理。
 *
 * 2. **不认识的字段要记账，不能静默吞掉。**
 *    G2 实测：`coverage: 92.5` / `waivers: 3` 一路原文带到接收方，
 *    接收方一次都没提。「没被吃掉」和「被看见」是两件事，
 *    所以解析时把未知 key 列出来，由调用方写进日志。
 *
 * 本文件是纯函数，不碰 IO、不依赖 pi API，可单测。
 */

/** 传输协议版本。与契约版本分开——G6 实测：pi-a2a 只有一个协议名，升级只能硬切。 */
export const PROTO = 1;

/** 消息契约版本，对应 13.3 的 `schema` 字段。 */
export const CONTRACT = 1;

/**
 * 一条消息的体积上限。
 *
 * 比 pi-a2a 的 512KB 小一半：我们的 `files` 走路径引用，`payload` 是结构化字段，
 * 本来就不该有大块内容。超限时要报**准确的原因**——pi-a2a 的 D5 虽然拦住了，
 * 但把「体积超限」报成了 `-32700 Invalid JSON payload`，发送方会去查 JSON 格式。
 */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** 闭合枚举。见文件头规则 1。 */
export const VERDICTS = ["PASS", "FAILED", "BLOCKED"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * 已知类型，仅用于「是不是眼熟」的提示，**不用于拒收**。
 * 收到表外的类型照常投递，只在日志里标 `unknown_type`。
 */
export const KNOWN_TYPES = ["ip_verified", "driver_ready", "build_failed", "need_input", "rejected"] as const;

/**
 * 系统类型：**不走订阅表，一律投递**。
 *
 * 只有 `rejected` 一个。第一次实地跑时它走了订阅表，结果 DV 的角色没订阅 `rejected`，
 * 拒收通知被自己的 gate 判成 `log_only` 吞掉了——发送方完全不知道消息被拒。
 * 这跟 pi-a2a 让发送方收到「已送达」而一个字节都没写（H5）是同一类错误，
 * 所以单独列出来：**告诉你「你那条没被接受」的消息，不能因为你没订阅它就不送。**
 */
export const SYSTEM_TYPES = ["rejected"] as const;

/** 同上，已知 role 只是提示。按 role 取文件（13.4），不按下标。 */
export const KNOWN_ROLES = ["spec", "ipxact", "component", "model", "driver_doc", "build_log"] as const;

export interface BusFile {
	role: string;
	/** 相对项目根。绝对路径一律拒收——两个 agent 的 cwd 不同，相对 cwd 的路径会解析错（I1 实测）。 */
	path: string;
	/** 发送方声称的摘要。gate.ts 会实算比对，不一致不放行（D3 实测）。 */
	sha256: string;
}

export interface BusPayload {
	ip?: string;
	verdict?: string;
	message?: string;
	missing?: string[];
	[key: string]: unknown;
}

export interface BusMessage {
	id: string;
	proto: number;
	/** 契约版本，13.3 的 `schema`。 */
	schema: number;
	/** 发送方身份。**由接收侧的传输层填，不采信发送方自称**（E8 实测）。 */
	from: string;
	to: string;
	type: string;
	/** 给人和 LLM 读的自然语言。机器判断一律走 payload。 */
	text: string;
	payload: BusPayload;
	files: BusFile[];
	/**
	 * 这条是**按订阅扇出**来的（发送方写了 `to: "*"`），不是指名发给你的。
	 *
	 * 区别在于订阅表怎么用：扇出时订阅表决定「该投给谁」，所以没订阅就不该收到；
	 * 而**指名**的消息（包括回复、拒收通知）一律要送到——否则对方怎么回复你？
	 * 第一次实地跑时没区分，结果 SW 回的 `ack` 被 DV 自己的订阅表吞掉了。
	 */
	fanout?: boolean;
	/**
	 * 线程 id。一条新消息的线程就是它自己的 id；回复沿用被回复方的线程。
	 * 没有它，「这条回复对应哪条请求」只能靠正文里写——B6 实测就是这么勉强对上的。
	 */
	thread_id: string;
	/**
	 * 这条是对哪条消息的回复（对方的消息 id），不是回复就是 null。
	 *
	 * 除了对得上号，它还是 E8（身份伪造）在没有 daemon 之前**唯一的补偿手段**：
	 * 阶段一里 DV 之所以察觉自己被冒充，就是因为收到一堆 `Re:` 某条它从没发过的消息。
	 * gate.ts 会拿它跟本机「发出过的 id」比对，对不上就标可疑并记日志——
	 * 不靠 LLM 自己察觉。
	 */
	reply_to: string | null;
	/** 发出时刻，毫秒。 */
	ts: number;
}

export interface ParseOk {
	ok: true;
	message: BusMessage;
	/** payload 里本版本不认识的 key，调用方要写进日志（规则 2）。 */
	unknownPayloadKeys: string[];
	/** 结构合法但值得留一句的地方：未知 type、未知 role、未知 verdict。 */
	warnings: string[];
}

export interface ParseErr {
	ok: false;
	/** 每条都指明是哪个字段、错在哪。拒收原因必须能直接照着改。 */
	errors: string[];
}

export type ParseResult = ParseOk | ParseErr;

/** payload 里本版本认识的 key。其余进 `unknownPayloadKeys`。 */
const KNOWN_PAYLOAD_KEYS = new Set(["ip", "verdict", "message", "missing"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 解析并校验一条消息。
 *
 * 只做「结构对不对」，不做「内容可不可信」——后者是 gate.ts 的事
 * （幂等、sha256 实算、owns 归属、授权）。分开是因为结构校验是纯的、
 * 可单测，而内容校验要碰磁盘。
 */
export function parseMessage(raw: unknown): ParseResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!isRecord(raw)) {
		return { ok: false, errors: ["顶层不是对象"] };
	}

	const str = (key: string, required: boolean): string => {
		const v = raw[key];
		if (typeof v === "string" && v.length > 0) return v;
		if (required) errors.push(`${key}: 必须是非空字符串，收到 ${JSON.stringify(v)}`);
		return "";
	};

	const id = str("id", true);
	const from = str("from", true);
	const to = str("to", true);
	const type = str("type", true);
	const text = str("text", false);

	const num = (key: string, expect: number | undefined): number => {
		const v = raw[key];
		if (typeof v !== "number" || !Number.isFinite(v)) {
			errors.push(`${key}: 必须是数字，收到 ${JSON.stringify(v)}`);
			return 0;
		}
		if (expect !== undefined && v !== expect) {
			// 版本不匹配是拒收原因，且必须说明该升哪一边（H4b 实测：pi-a2a 静默忽略，
			// 表现是「对方明明开着就是发现不了」，最难查）。
			errors.push(`${key}: 本端是 ${expect}，收到 ${v}。${v > expect ? "请升级本端" : "请升级发送端"}`);
		}
		return v;
	};

	const proto = num("proto", PROTO);
	const schema = num("schema", CONTRACT);
	const ts = num("ts", undefined);

	if (!KNOWN_TYPES.includes(type as (typeof KNOWN_TYPES)[number]) && type.length > 0) {
		warnings.push(`type "${type}" 不在已知列表里，照常投递（类型是开放的）`);
	}

	const payload: BusPayload = {};
	const unknownPayloadKeys: string[] = [];
	if (!isRecord(raw.payload)) {
		errors.push(`payload: 必须是对象，收到 ${JSON.stringify(raw.payload)}`);
	} else {
		for (const [k, v] of Object.entries(raw.payload)) {
			payload[k] = v;
			if (!KNOWN_PAYLOAD_KEYS.has(k)) unknownPayloadKeys.push(k);
		}
		const verdict = payload.verdict;
		if (verdict !== undefined) {
			if (typeof verdict !== "string") {
				errors.push(`payload.verdict: 必须是字符串，收到 ${JSON.stringify(verdict)}`);
			} else if (!VERDICTS.includes(verdict as Verdict)) {
				// 不拒收，交给 gate.ts 按最保守处理——拒收会让发送方以为消息丢了，
				// 而「按最保守处理 + 留 warning」既安全又可查。
				warnings.push(`payload.verdict "${verdict}" 不在 ${VERDICTS.join("/")} 里，按最保守处理（等同 FAILED）`);
			}
		}
		if (payload.missing !== undefined && !Array.isArray(payload.missing)) {
			errors.push(`payload.missing: 必须是数组，收到 ${JSON.stringify(payload.missing)}`);
		}
	}

	const fanout = raw.fanout === true;
	// thread_id 缺省就是自己的 id：一条新消息自己就是一个线程的开头
	const threadId = typeof raw.thread_id === "string" && raw.thread_id.length > 0 ? raw.thread_id : id;
	let replyTo: string | null = null;
	if (raw.reply_to !== undefined && raw.reply_to !== null) {
		if (typeof raw.reply_to === "string" && raw.reply_to.length > 0) replyTo = raw.reply_to;
		else errors.push(`reply_to: 必须是非空字符串或 null，收到 ${JSON.stringify(raw.reply_to)}`);
	}

	const files: BusFile[] = [];
	if (raw.files !== undefined) {
		if (!Array.isArray(raw.files)) {
			errors.push(`files: 必须是数组，收到 ${JSON.stringify(raw.files)}`);
		} else {
			raw.files.forEach((f, i) => {
				if (!isRecord(f)) {
					errors.push(`files[${i}]: 必须是对象`);
					return;
				}
				const role = typeof f.role === "string" ? f.role : "";
				const path = typeof f.path === "string" ? f.path : "";
				const sha256 = typeof f.sha256 === "string" ? f.sha256 : "";
				if (role.length === 0) errors.push(`files[${i}].role: 必须是非空字符串（按 role 取文件，不按下标）`);
				if (path.length === 0) errors.push(`files[${i}].path: 必须是非空字符串`);
				else if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
					errors.push(`files[${i}].path: 必须相对项目根，收到绝对路径 ${path}`);
				} else if (path.split(/[\\/]/).includes("..")) {
					errors.push(`files[${i}].path: 不许含 ".."，收到 ${path}`);
				}
				if (!/^[0-9a-f]{64}$/.test(sha256)) {
					errors.push(`files[${i}].sha256: 必须是 64 位小写十六进制，收到 ${JSON.stringify(f.sha256)}`);
				}
				if (!KNOWN_ROLES.includes(role as (typeof KNOWN_ROLES)[number]) && role.length > 0) {
					warnings.push(`files[${i}].role "${role}" 不在已知列表里，照常投递（role 是开放的）`);
				}
				files.push({ role, path, sha256 });
			});
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		message: {
			id,
			proto,
			schema,
			from,
			to,
			type,
			text,
			payload,
			files,
			fanout,
			thread_id: threadId,
			reply_to: replyTo,
			ts,
		},
		unknownPayloadKeys,
		warnings,
	};
}

/**
 * `verdict` 的最保守解读。表外的值一律等同 `FAILED`（G4 实测）。
 * 缺失也算 FAILED——「没说通过」不等于「通过」。
 */
export function effectiveVerdict(payload: BusPayload): Verdict {
	const v = payload.verdict;
	if (typeof v === "string" && VERDICTS.includes(v as Verdict)) return v as Verdict;
	return "FAILED";
}

/** 按 role 取文件，取不到返回 undefined。13.4：不许按下标取。 */
export function fileByRole(files: BusFile[], role: string): BusFile | undefined {
	return files.find((f) => f.role === role);
}
