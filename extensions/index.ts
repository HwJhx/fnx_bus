/**
 * fnxbus —— 多 agent 消息总线（阶段一→二的过渡实现）
 *
 * 设计：`docs/claude/多agent互通-设计.md`　实测依据：`docs/claude/多agent互通-阶段一实测.md`
 *
 * 这个版本**只解决阶段一实测里那四条致命失败**（B2 / E1 / D3 / G4），
 * 传输故意用最笨的文件队列（见 store.ts 文件头）。
 * 投递语义那一层实测证明不是风险，不值得现在自研 daemon。
 *
 * 四层处理（设计 14.2）：
 *
 * ```
 * ①校验     contract.ts  结构、版本、路径形状
 *          gate.ts      幂等、摘要实算、文件归属、订阅
 * ②闸门     guard.ts     消息触发的轮里，有副作用的工具调用要先过人
 * ③注入     gate.ts      renderInjection：结论由总线给，不让 LLM 重新解析正文
 * ④记账     store.ts     seen.jsonl（只增）+ log.jsonl（状态变迁）
 * ```
 *
 * **一个必须说清的局限**：文件队列**没有**解决 E8（身份伪造）。
 * 任何能写 inbox 目录的本机进程都能伪造 `from`。它只是把攻击面从
 * 「网络 + 全员共用的明文 secret」缩到「本机文件系统权限」。
 * 真正的身份认定要等第三步的 daemon（设计 4.5：每 agent 独立 token，服务端认定）。
 *
 * 用法：
 *   pi -e ./packages/coding-agent/examples/extensions/fnxbus/index.ts
 * 环境变量：
 *   FNXBUS_AGENT    本端角色名，缺省取 FORENYX_AGENT_NAME
 *   FNXBUS_PROJECT  项目根，缺省按 store.ts 的 resolveProjectRoot 查找
 */

import { existsSync, type FSWatcher, mkdirSync, readFileSync, renameSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONTRACT, PROTO, parseMessage } from "./contract.ts";
import { decide, type GateContext, globMatch, renderInjection } from "./gate.ts";
import { classifyToolCall, decideToolCall, freshGuardState } from "./guard.ts";
import { findOwnsOverlaps, parseRolesFile, type Role, rolesTemplate, validateAgentName } from "./roles.ts";
import {
	acquireLock,
	appendLog,
	appendSeen,
	appendSent,
	BusRootNotFound,
	busDir,
	fingerprint,
	listInbox,
	loadSeen,
	loadSentIds,
	newId,
	putMessage,
	readCards,
	releaseLock,
	removeCard,
	removeFromInbox,
	resolveProjectRoot,
	type SeenIndex,
	shaOf,
	shaOfOrThrow,
	writeCard,
} from "./store.ts";

/**
 * 兜底角色表，对应设计 13.1。项目里放 `<项目根>/.fnxbus/roles.json` 就能覆盖它，
 * 加角色也只改那个文件——**代码里除了这张兜底表，没有任何地方写死角色名**
 * （路由、扇出、单实例锁、inbox/seen/sent 目录全按角色表的键来）。
 *
 * `owns` 一律相对项目根（4.3.2）：项目根共享只读，每个 agent 只写自己那个目录。
 * 阶段一实测 4.5 的「越界写」就是这条没定清的后果。
 */
const DEFAULT_ROLES: Record<string, Role> = {
	fnx_sw: {
		subscribe: ["ip_verified", "spec_updated"],
		owns: ["sw/**", "software/**"],
	},
	fnx_dv: {
		subscribe: ["build_failed", "need_input"],
		owns: ["dv/**", "verification/**", "chip/rtl/ips/*/docs/**"],
	},
};

/** 兜底扫描间隔。fs.watch 在某些文件系统上不可靠，不能只靠它。 */
const SCAN_INTERVAL_MS = 5000;

/**
 * 文件「写完了」要过多久才算稳。
 *
 * `fs.watch` 在文件**创建时**就触发，此时外部写入者可能还在往里写。
 * 我们自己的 `putMessage` 是原子写（temp → rename）不会有这问题，但别的写入者
 * （脚本、将来的工具）不一定守这个约定。实地跑就撞上了：一个 300KB 的消息
 * 被读到半截，报成「不是合法 JSON」并隔离——而这正是我批评 pi-a2a 的那条
 * （把体积超限报成 JSON 解析失败，原因说错了）。
 *
 * 所以解析失败时先看文件有多新：太新的跳过，等下一轮再看。
 */
const WRITE_SETTLE_MS = 2000;

export default function fnxbus(pi: ExtensionAPI) {
	let projectRoot = "";
	let agent = "";
	let roles = DEFAULT_ROLES;
	let seen: SeenIndex = { ids: new Set<string>(), recent: [] };
	let extraReadonly: ReadonlySet<string> = new Set<string>();
	let sentIds = new Set<string>();
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** 初始化失败的原因。失败时扩展不工作，但要让人看得见，不能静默。 */
	let initError = "";
	let draining = false;
	const guard = freshGuardState();
	/** 闸门打开的时刻，用于算「从注入到处理完」的耗时（F4）。 */
	let gateInjectedAt = 0;
	/** 本条消息的 `handled` 是否已记过。一条消息可能跨多轮，只在第一轮结束时记一次。 */
	let gateHandledLogged = true;

	/**
	 * 初始化失败的统一出口。
	 *
	 * 三个去处都必要：`notify` 给当场看着的人，`setStatus` 让状态栏常驻（notify 一闪而过，
	 * A3 实测时第二个实例的拒绝原因就这么错过了），`stderr` 给非交互模式
	 * （I1 实测：`-p` 模式下拒绝注册完全静默，「总线为什么没工作」无从查）。
	 */
	const failInit = (ctx: ExtensionContext, why: string): void => {
		initError = why;
		ctx.ui.notify(`fnxbus 未启用：${why}`, "warning");
		ctx.ui.setStatus("fnxbus", "🚌✗ 未接入");
		process.stderr.write(`fnxbus 未启用：${why}\n`);
	};

	const gateContextFor = (from: string, type: string, fp: string): GateContext => ({
		seen: seen.ids,
		recent: seen.recent,
		fingerprint: fp,
		now: Date.now(),
		shaOf: (p) => shaOf(projectRoot, p),
		senderOwns: roles[from.split("#")[0]]?.owns ?? [],
		subscribers: (roles[agent]?.subscribe ?? []).includes(type) ? [agent] : [],
		sentIds,
	});

	/** 我们自己发出的消息也走同一套校验——发送侧和接收侧共用一套规则才不会各说各话。 */
	function buildOutgoing(
		to: string,
		type: string,
		text: string,
		payload: Record<string, unknown>,
		files: { role: string; path: string }[],
		fanout = false,
		replyTo: string | null = null,
		threadId?: string,
	) {
		const id = newId();
		return {
			id,
			proto: PROTO,
			schema: CONTRACT,
			from: agent,
			to,
			type,
			text,
			payload,
			files: files.map((f) => ({ role: f.role, path: f.path, sha256: shaOfOrThrow(projectRoot, f.path) })),
			fanout,
			thread_id: threadId ?? id,
			reply_to: replyTo,
			ts: Date.now(),
		};
	}

	/** 把一条拒收结果回给发送方。发送方必须知道它的消息没被接受，以及为什么（H5/F3 的教训）。 */
	function replyRejected(to: string, originalId: string, reasons: string[]): void {
		try {
			const msg = buildOutgoing(
				to,
				"rejected",
				`你的消息 ${originalId} 未被接受：\n${reasons.map((r) => `  - ${r}`).join("\n")}`,
				{ verdict: "FAILED", message: reasons.join("; ") },
				[],
				false,
				originalId,
			);
			putMessage(projectRoot, to, msg.id, JSON.stringify(msg, null, 2));
			appendLog(projectRoot, { ts: Date.now(), event: "rejected_notified", id: originalId, to });
		} catch (e) {
			appendLog(projectRoot, {
				ts: Date.now(),
				event: "persist_failed",
				id: originalId,
				to,
				note: `回拒收通知失败：${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	/** 坏消息挪进 `inbox/<agent>/.bad/`，不静默删——删了就再也查不出当时收到了什么。 */
	function quarantine(path: string, id: string, why: string): void {
		const badDir = join(busDir(projectRoot), "inbox", agent, ".bad");
		try {
			mkdirSync(badDir, { recursive: true });
			renameSync(path, join(badDir, `${id}.json`));
		} catch {
			/* 挪不动就留在原地，下面的 appendSeen 会让它不再被处理 */
		}
		appendSeen(projectRoot, agent, { id, fp: "", from: "", thread: id, ts: Date.now() }, `quarantined: ${why}`);
		appendLog(projectRoot, { ts: Date.now(), event: "quarantined", id, note: why });
		seen.ids.add(id);
	}

	function drain(): void {
		if (draining || initError.length > 0) return;
		draining = true;
		try {
			for (const item of listInbox(projectRoot, agent)) {
				if (seen.ids.has(item.id)) {
					removeFromInbox(item.path);
					continue;
				}
				if (item.error !== undefined) {
					quarantine(item.path, item.id, item.error);
					continue;
				}

				let raw: unknown;
				try {
					raw = JSON.parse(item.raw);
				} catch (e) {
					if (Date.now() - item.mtimeMs < WRITE_SETTLE_MS) continue; // 可能还在写，下一轮再看
					quarantine(item.path, item.id, `不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
					continue;
				}

				const parsed = parseMessage(raw);
				const from = parsed.ok ? parsed.message.from : "";
				const type = parsed.ok ? parsed.message.type : "";
				const fp = parsed.ok ? fingerprint(type, from, parsed.message.payload) : "";
				const d = decide(parsed, gateContextFor(from, type, fp));

				appendLog(projectRoot, {
					ts: Date.now(),
					event: d.action,
					id: item.id,
					from,
					to: agent,
					type,
					reasons: d.reasons.length > 0 ? d.reasons : undefined,
					warnings: d.warnings.length > 0 ? d.warnings : undefined,
					unknownPayloadKeys: d.unknownPayloadKeys.length > 0 ? d.unknownPayloadKeys : undefined,
				});

				// 先记账再删文件再注入：崩在任何一步都不会导致重复执行（H5 实测的反面）
				const rec = {
					id: item.id,
					fp,
					from,
					thread: parsed.ok ? parsed.message.thread_id : item.id,
					ts: Date.now(),
				};
				appendSeen(projectRoot, agent, rec, d.action);
				seen.ids.add(item.id);
				seen.recent.push(rec);
				removeFromInbox(item.path);

				if (d.action === "reject" && from.length > 0) replyRejected(from.split("#")[0], item.id, d.reasons);
				if (d.action !== "inject" || !parsed.ok) continue;

				guard.gated = true;
				guard.gateMessageId = item.id;
				guard.approvedForTurn = false;
				gateInjectedAt = Date.now();
				gateHandledLogged = false;
				const suspicious = d.warnings.some((w) => w.includes("对不上号"));
				pi.sendUserMessage(renderInjection(parsed.message, d.verdict ?? "FAILED", suspicious), {
					deliverAs: "followUp",
				});
			}
		} finally {
			draining = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		agent = process.env.FNXBUS_AGENT ?? process.env.FORENYX_AGENT_NAME ?? "";
		if (agent.length === 0) {
			failInit(ctx, "未能确定本端角色名。请设 FNXBUS_AGENT=<角色名>（如 fnx_sw）。");
			return;
		}
		// 角色名直接当目录名和文件名用，不校验的话 `../..` 就是路径穿越
		const nameErr = validateAgentName(agent);
		if (nameErr !== undefined) {
			failInit(ctx, nameErr);
			return;
		}
		try {
			projectRoot = resolveProjectRoot(ctx.cwd, process.env);
		} catch (e) {
			// 4.3.1 第 4 条：找不到项目根就拒绝注册，不自动建。报错里直接写怎么办。
			failInit(
				ctx,
				e instanceof BusRootNotFound ? e.message : `解析项目根失败：${e instanceof Error ? e.message : String(e)}`,
			);
			return;
		}

		const rolesPath = join(busDir(projectRoot), "roles.json");
		if (existsSync(rolesPath)) {
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(rolesPath, "utf8"));
			} catch (e) {
				// 配置文件坏了要拒绝启动，不能默默退回默认表——那样人会以为配置生效了
				failInit(ctx, `roles.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
				return;
			}
			const { config, errors } = parseRolesFile(raw);
			if (errors.length > 0) {
				failInit(ctx, `roles.json 有 ${errors.length} 处问题：\n${errors.map((x) => `  - ${x}`).join("\n")}`);
				return;
			}
			roles = config.roles;
			extraReadonly = config.readonlyTools;
		}
		if (roles[agent] === undefined) {
			failInit(ctx, `角色表里没有 ${agent}。\n${rolesTemplate(agent, rolesPath)}`);
			return;
		}

		// owns 重叠不拒绝启动，但要说出来：两个角色都能写同一片路径时，「文件归属」就没意义了
		const overlaps = findOwnsOverlaps(roles);
		if (overlaps.length > 0) {
			const lines = overlaps.slice(0, 5).map((o) => `  ${o.a} 的 ${o.pattern} 与 ${o.b} 的 ${o.otherPattern}`);
			ctx.ui.notify(`fnxbus：角色表里有 ${overlaps.length} 处 owns 重叠\n${lines.join("\n")}`, "warning");
			appendLog(projectRoot, {
				ts: Date.now(),
				event: "owns_overlap",
				from: agent,
				note: overlaps.map((o) => `${o.a}:${o.pattern} ~ ${o.b}:${o.otherPattern}`).join("; "),
			});
		}

		const holder = acquireLock(projectRoot, agent);
		if (holder !== undefined) {
			// A3：同一个角色只允许一个实例接总线。两个实例抢同一个 inbox 会重复处理
			// （pi-a2a 的症状是状态文件乒乓覆盖丢消息，我们的症状是重复执行，都不对）。
			failInit(ctx, `${agent} 在这个项目里已经有一个实例在运行（pid ${holder}）。总线只允许一个，本会话不接入。`);
			return;
		}

		seen = loadSeen(projectRoot, agent);
		sentIds = loadSentIds(projectRoot, agent);
		const inboxDir = join(busDir(projectRoot), "inbox", agent);
		mkdirSync(inboxDir, { recursive: true });

		try {
			writeCard(projectRoot, {
				agent,
				instance: `${agent}#${process.pid}`,
				cwd: ctx.cwd,
				pid: process.pid,
				subscribe: roles[agent].subscribe,
				owns: roles[agent].owns,
				ts: Date.now(),
			});
		} catch (e) {
			// 落盘失败必须可见（H5 规矩 1），不能像 pi-a2a 那样一个空 catch 吞掉
			failInit(ctx, `写名片失败：${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		watcher = watch(inboxDir, () => drain());
		timer = setInterval(() => drain(), SCAN_INTERVAL_MS);
		timer.unref();
		appendLog(projectRoot, { ts: Date.now(), event: "registered", from: agent, note: projectRoot });
		ctx.ui.setStatus("fnxbus", `🚌 ${agent}`);
		drain();
	});

	pi.on("session_shutdown", () => {
		watcher?.close();
		if (timer !== undefined) clearInterval(timer);
		if (initError.length === 0 && projectRoot.length > 0) {
			releaseLock(projectRoot, agent);
			removeCard(projectRoot, agent);
			appendLog(projectRoot, { ts: Date.now(), event: "unregistered", from: agent });
		}
	});

	/**
	 * 人在终端里主动说话 → 这一轮是人发起的，解除闸门。
	 * `InputEvent.source` 已经把「人敲的」和「扩展注入的」分开了，不需要猜时机。
	 * `rpc` 不解除：那种场景下没有人在场，而「没人能批准」不等于「不需要批准」。
	 */
	pi.on("input", (event) => {
		if (event.source === "interactive" && guard.gated) {
			guard.gated = false;
			guard.approvedForTurn = false;
			if (projectRoot.length > 0) {
				appendLog(projectRoot, {
					ts: Date.now(),
					event: "gate_released",
					id: guard.gateMessageId,
					note: "人主动输入",
				});
				// 每条注入的消息都要有终态，否则 F2 的「处理完没」对它答不上来。
				// 被人接管（或中途 Escape）的轮走不到 agent_end 的 handled，这里补一笔。
				if (!gateHandledLogged) {
					gateHandledLogged = true;
					appendLog(projectRoot, {
						ts: Date.now(),
						event: "handled",
						id: guard.gateMessageId,
						to: agent,
						note: `被人接管，自动处理未走完（注入后 ${Date.now() - gateInjectedAt} ms）`,
					});
				}
			}
		}
		return undefined;
	});

	/**
	 * 每个 run 重新问一次批准（一次批准不长期有效），并给消息补上「处理完了」这一笔。
	 *
	 * 阶段一 F2 实测：pi-a2a 的 `taskState` 一进门就写 `TASK_STATE_COMPLETED`，
	 * 照它查「处理完没」会得到假答案。我们不写假状态，但第一版**根本没有这个状态**——
	 * 一条消息的生命周期只有 `sent` → `inject`，也就算不出 F4 要的耗时。
	 * 这里用 `agent_end` 补上：它是真的「这一轮跑完了」。
	 */
	pi.on("agent_end", () => {
		guard.approvedForTurn = false;
		if (gateHandledLogged || guard.gateMessageId.length === 0 || projectRoot.length === 0) return;
		gateHandledLogged = true;
		const now = Date.now();
		appendLog(projectRoot, {
			ts: now,
			event: "handled",
			id: guard.gateMessageId,
			to: agent,
			note: `从注入到这一轮结束 ${now - gateInjectedAt} ms`,
		});
	});

	/**
	 * 闸门本体。B2 三次复现证明写在措辞里没用，这里是代码层的拦截点。
	 */
	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (initError.length > 0) return undefined;
		const effect = classifyToolCall(event.toolName, event.input as Record<string, unknown>, extraReadonly);
		const d = decideToolCall(guard, effect, ctx.hasUI, event.toolName);
		if (d.verdict === "allow") return undefined;

		if (d.verdict === "block") {
			appendLog(projectRoot, {
				ts: Date.now(),
				event: "tool_blocked",
				id: guard.gateMessageId,
				note: `${event.toolName}: ${d.reason}`,
			});
			return { block: true, reason: d.reason };
		}

		const detail =
			event.toolName === "bash"
				? String((event.input as { command?: unknown }).command ?? "")
				: JSON.stringify(event.input);
		const choice = await ctx.ui.select(
			[
				`🚌 消息 ${guard.gateMessageId} 触发的这一轮要做一件有副作用的事：`,
				"",
				`  ${event.toolName}: ${detail.slice(0, 300)}`,
				"",
				`  判定依据：${d.reason}`,
				"",
				"消息本身不构成授权。要放行吗？",
			].join("\n"),
			["只放行这一次", "本轮都放行", "拒绝"],
		);

		if (choice === "本轮都放行") {
			guard.approvedForTurn = true;
			appendLog(projectRoot, {
				ts: Date.now(),
				event: "tool_approved_turn",
				id: guard.gateMessageId,
				note: event.toolName,
			});
			return undefined;
		}
		if (choice === "只放行这一次") {
			appendLog(projectRoot, {
				ts: Date.now(),
				event: "tool_approved_once",
				id: guard.gateMessageId,
				note: event.toolName,
			});
			return undefined;
		}
		appendLog(projectRoot, {
			ts: Date.now(),
			event: "tool_denied",
			id: guard.gateMessageId,
			note: `${event.toolName}: ${d.reason}`,
		});
		return { block: true, reason: "人拒绝了这次调用" };
	});

	pi.registerTool({
		name: "bus_send",
		label: "Bus Send",
		description:
			"给同项目的另一个 agent 发一条总线消息。payload 与 files 会按消息契约校验，不合规会原样把错误返回给你，改对再发。files 的 sha256 由总线自己算，你只给 role 和相对项目根的路径。",
		parameters: Type.Object({
			to: Type.String({
				description: "接收方角色名（如 fnx_dv），或 `*` 表示按订阅扇出——投给角色表里订阅了这个 type 的所有角色",
			}),
			type: Type.String({ description: "消息类型，如 ip_verified / build_failed / need_input" }),
			text: Type.String({ description: "给人和对方 LLM 读的自然语言说明" }),
			payload: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "机器判断用的结构化字段。verdict 只能是 PASS / FAILED / BLOCKED",
				}),
			),
			files: Type.Optional(
				Type.Array(
					Type.Object({
						role: Type.String({ description: "spec / ipxact / component / model / driver_doc / build_log …" }),
						path: Type.String({ description: "相对项目根的路径，不要用绝对路径" }),
					}),
					{ description: "附带的文件。接收方按 role 取，不按顺序" },
				),
			),
		}),
		async execute(_id, params) {
			if (initError.length > 0) {
				return { content: [{ type: "text", text: `总线未启用：${initError}` }], isError: true, details: undefined };
			}
			/**
			 * `to: "*"` 不是全广播，是**按订阅扇出**：查角色表里谁订阅了这个 type。
			 *
			 * 用 `roles`（静态配置）而不是在线名片，离线的订阅者也要投——文件留在它的 inbox，
			 * 它上线后自己会处理。pi-a2a 的 `*` 是投给所有在线 peer，会打扰不相关的 agent，
			 * 而且离线的收不到（G5 实测 ✗）。
			 */
			if (params.to !== "*" && roles[params.to] === undefined) {
				// 不校验的话 putMessage 会建一个 `inbox/<不存在的角色>/` 目录把消息写进去，
				// 谁也不会来取——静默黑洞。发送方必须当场知道这个名字不存在。
				appendLog(projectRoot, {
					ts: Date.now(),
					event: "unknown_target",
					from: agent,
					to: params.to,
					type: params.type,
				});
				return {
					content: [
						{
							type: "text",
							text: `角色表里没有 ${params.to}。已知角色：${Object.keys(roles).join(", ")}。消息没有发出。`,
						},
					],
					isError: true,
					details: undefined,
				};
			}

			const targets =
				params.to === "*"
					? Object.keys(roles).filter((n) => n !== agent && (roles[n]?.subscribe ?? []).includes(params.type))
					: [params.to];
			if (targets.length === 0) {
				// B5：无订阅者只记日志、不投递，并且明确告诉发送方，不静默丢
				appendLog(projectRoot, {
					ts: Date.now(),
					event: "no_subscriber",
					from: agent,
					type: params.type,
					note: "按订阅扇出但没有角色订阅它，只记日志",
				});
				return {
					content: [{ type: "text", text: `角色表里没有任何角色订阅 ${params.type}，只记了日志，没有投递。` }],
					isError: false,
					details: undefined,
				};
			}

			let msg: ReturnType<typeof buildOutgoing>;
			try {
				msg = buildOutgoing(
					params.to,
					params.type,
					params.text,
					params.payload ?? {},
					params.files ?? [],
					params.to === "*",
				);
			} catch (e) {
				return {
					content: [{ type: "text", text: `发送前算摘要失败：${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
					details: undefined,
				};
			}

			const selfCheck = parseMessage(msg);
			if (!selfCheck.ok) {
				return {
					content: [
						{
							type: "text",
							text: `这条消息不合契约，没有发出：\n${selfCheck.errors.map((e) => `  - ${e}`).join("\n")}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			const myOwns = roles[agent]?.owns ?? [];
			// 用 gate.ts 的 globMatch，不要在这里另写一份——第一次实地跑就是因为
			// 这里手写了个只认前缀的劣化版，把 `chip/rtl/ips/*/docs/**` 中间那个通配符判错了，
			// 结果发送方明明有权限却被自己的工具挡住。
			const notMine = msg.files.filter((f) => !myOwns.some((pattern) => globMatch(pattern, f.path)));
			if (notMine.length > 0) {
				// 提前挡住：否则对方的 gate 会以「不在你的 owns 范围内」拒收，白跑一趟
				return {
					content: [
						{
							type: "text",
							text: `以下文件不在 ${agent} 的 owns 范围（${myOwns.join(", ")}）内，对方会拒收：\n${notMine.map((f) => `  - ${f.path}`).join("\n")}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}

			try {
				for (const t of targets) putMessage(projectRoot, t, msg.id, JSON.stringify({ ...msg, to: t }, null, 2));
			} catch (e) {
				appendLog(projectRoot, {
					ts: Date.now(),
					event: "persist_failed",
					id: msg.id,
					to: targets.join(","),
					note: String(e),
				});
				return {
					content: [
						{
							type: "text",
							text: `写入 inbox 失败，消息没有发出：${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			appendSent(projectRoot, agent, msg.id, targets.join(","));
			sentIds.add(msg.id);
			for (const t of targets) {
				appendLog(projectRoot, {
					ts: Date.now(),
					event: "sent",
					id: msg.id,
					from: agent,
					to: t,
					type: params.type,
				});
			}
			const warn =
				selfCheck.warnings.length > 0 ? `\n提醒：\n${selfCheck.warnings.map((w) => `  - ${w}`).join("\n")}` : "";
			const how = params.to === "*" ? `（按订阅扇出到 ${targets.length} 个角色）` : "";
			return {
				content: [{ type: "text", text: `已投入 ${targets.join(", ")} 的 inbox${how}，消息 id ${msg.id}${warn}` }],
				details: { id: msg.id, to: targets.join(","), type: params.type },
			};
		},
	});

	pi.registerTool({
		name: "bus_reply",
		label: "Bus Reply",
		description:
			"回复一条收到的总线消息。`reply_to` 与线程由总线自己填，对方那边能对上号——不要用 bus_send 手工回复，那样对不上。",
		parameters: Type.Object({
			message_id: Type.String({ description: "要回复的那条消息的 id（注入文本里写着）" }),
			type: Type.String({ description: "回复的消息类型，如 build_failed / need_input / ack" }),
			text: Type.String({ description: "给人和对方 LLM 读的自然语言说明" }),
			payload: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "机器判断用的结构化字段。verdict 只能是 PASS / FAILED / BLOCKED",
				}),
			),
			files: Type.Optional(
				Type.Array(Type.Object({ role: Type.String(), path: Type.String() }), {
					description: "附带的文件，路径相对项目根",
				}),
			),
		}),
		async execute(_id, params) {
			if (initError.length > 0) {
				return { content: [{ type: "text", text: `总线未启用：${initError}` }], isError: true, details: undefined };
			}
			const orig = seen.recent.find((r) => r.id === params.message_id);
			if (orig === undefined) {
				return {
					content: [
						{
							type: "text",
							text: `没有处理过 ${params.message_id} 这条消息，无法回复它。最近处理过的：${seen.recent
								.slice(-5)
								.map((r) => r.id)
								.join(", ")}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			const to = orig.from.split("#")[0];
			if (roles[to] === undefined) {
				return {
					content: [{ type: "text", text: `原消息声称来自 ${orig.from}，但角色表里没有 ${to}，无法回复。` }],
					isError: true,
					details: undefined,
				};
			}

			let msg: ReturnType<typeof buildOutgoing>;
			try {
				msg = buildOutgoing(
					to,
					params.type,
					params.text,
					params.payload ?? {},
					params.files ?? [],
					false,
					params.message_id,
					orig.thread,
				);
			} catch (e) {
				return {
					content: [{ type: "text", text: `发送前算摘要失败：${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
					details: undefined,
				};
			}
			const selfCheck = parseMessage(msg);
			if (!selfCheck.ok) {
				return {
					content: [
						{
							type: "text",
							text: `这条回复不合契约，没有发出：\n${selfCheck.errors.map((e) => `  - ${e}`).join("\n")}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			try {
				putMessage(projectRoot, to, msg.id, JSON.stringify(msg, null, 2));
			} catch (e) {
				appendLog(projectRoot, { ts: Date.now(), event: "persist_failed", id: msg.id, to, note: String(e) });
				return {
					content: [
						{
							type: "text",
							text: `写入 ${to} 的 inbox 失败，回复没有发出：${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			appendSent(projectRoot, agent, msg.id, to);
			sentIds.add(msg.id);
			appendLog(projectRoot, {
				ts: Date.now(),
				event: "sent",
				id: msg.id,
				from: agent,
				to,
				type: params.type,
				note: `回复 ${params.message_id}（线程 ${orig.thread}）`,
			});
			return {
				content: [{ type: "text", text: `已回复 ${to}，消息 id ${msg.id}，线程 ${orig.thread}` }],
				details: { id: msg.id, to, type: params.type },
			};
		},
	});

	pi.registerTool({
		name: "bus_peers",
		label: "Bus Peers",
		description: "看同项目里有哪些 agent 注册过、各自订阅什么、可写哪些路径。",
		parameters: Type.Object({}),
		async execute() {
			if (initError.length > 0) {
				return { content: [{ type: "text", text: `总线未启用：${initError}` }], isError: true, details: undefined };
			}
			const { cards, broken, stale } = readCards(projectRoot);
			const lines = [`项目根：${projectRoot}`, `本端：${agent}`, ""];
			for (const c of cards) {
				// 文件队列的一个好处：别人的积压也看得见，不用问它
				const backlog = listInbox(projectRoot, c.agent).length;
				lines.push(`${c.agent === agent ? "→" : " "} ${c.instance}  cwd=${c.cwd}  待处理 ${backlog} 条`);
				lines.push(`    订阅 ${c.subscribe.join(", ") || "(无)"}`);
				lines.push(`    可写 ${c.owns.join(", ") || "(无)"}`);
			}
			const offline = Object.keys(roles).filter((n) => !cards.some((c) => c.agent === n));
			for (const n of offline) {
				lines.push(`  ${n}  (离线)  待处理 ${listInbox(projectRoot, n).length} 条`);
			}
			if (cards.length === 0) lines.push("(没有名片。对方没起来，或者它的项目根不是这个)");
			if (broken.length > 0) lines.push(`坏名片：${broken.join(", ")}`);
			if (stale.length > 0) lines.push(`刚清掉的陈旧名片（进程已死）：${stale.join(", ")}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: cards.length } };
		},
	});

	pi.registerCommand("bus-status", {
		description: "fnxbus：项目根、角色、闸门状态、积压",
		handler: async (_args, ctx) => {
			if (initError.length > 0) {
				ctx.ui.notify(`fnxbus 未启用：\n${initError}`, "error");
				return;
			}
			const { cards } = readCards(projectRoot);
			const backlog = listInbox(projectRoot, agent).length;
			ctx.ui.notify(
				[
					`项目根 ${projectRoot}`,
					`本端 ${agent}　订阅 ${roles[agent].subscribe.join(", ")}`,
					`可写 ${roles[agent].owns.join(", ")}`,
					`已处理 ${seen.ids.size} 条　待处理 ${backlog} 条`,
					`注册在案 ${cards.map((c) => c.instance).join(", ") || "(无)"}`,
					guard.gated
						? `闸门：开（消息 ${guard.gateMessageId} 触发，${guard.approvedForTurn ? "人已为本轮放行" : "有副作用的调用会先问人"}）`
						: "闸门：关（本轮不是消息触发的）",
				].join("\n"),
				"info",
			);
		},
	});
}
