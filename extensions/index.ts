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
 *   FNXBUS_AGENT    本端角色名（要和 roles.json 里的键一致）。
 *                   没设时退而读宿主 agent 自己的名字（FORENYX_AGENT_NAME）
 *   FNXBUS_PROJECT  项目根，缺省按 store.ts 的 resolveProjectRoot 查找
 */

import { existsSync, type FSWatcher, mkdirSync, readFileSync, renameSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONTRACT, PROTO, parseMessage } from "./contract.ts";
import { decide, type GateContext, globMatch, renderInjection } from "./gate.ts";
import { classifyToolCall, decideToolCall, freshGuardState } from "./guard.ts";
import { findOwnsOverlaps, mergeRoles, parseRolesFile, type Role, rolesTemplate, validateAgentName } from "./roles.ts";
import {
	acquireLock,
	appendLog,
	appendSeen,
	appendSent,
	BusRootNotFound,
	busDir,
	findInitializedRoot,
	fingerprint,
	gitRoot,
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
	writeAtomic,
	writeCard,
} from "./store.ts";

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
	/**
	 * 角色表。**没有任何内置默认值**——必须由 `<项目根>/.fnxbus/roles.json` 提供。
	 *
	 * 不留兜底表是刻意的：兜底表里写什么角色名、什么目录约定，就等于把使用方的
	 * 项目结构写进了这个通用组件。角色表是**项目配置**，不是组件的一部分。
	 *
	 * 路由、按订阅扇出、单实例锁、inbox/seen/sent 目录全按这张表的键来，
	 * 所以加第 N 个角色只改那个 json，代码一行不用动。
	 */
	let roles: Record<string, Role> = {};
	let seen: SeenIndex = { ids: new Set<string>(), recent: [] };
	let extraReadonly: ReadonlySet<string> = new Set<string>();
	let sentIds = new Set<string>();
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	/**
	 * 会话上下文。`drain` 是被 watcher 和定时器调的，拿不到事件参数里的 ctx，
	 * 但它需要 `isIdle()` 判断现在能不能处理消息（见 drain 开头）。
	 */
	let sessionCtx: ExtensionContext | undefined;
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
		/**
		 * 没有可供人批准的 UI 时**只发不收**（`-p` 打印模式、`json` 模式）。
		 *
		 * 收了也没用：那种场景下没人能批准闸门的询问，`decideToolCall` 对任何写操作都是
		 * `block`，所以「能收消息」在这些模式里本来就是名义上的能力。
		 *
		 * 而实测（2026-09-28，复现 2/2）证明它不只是没用，是有害的 —— `-p` 启动时
		 * inbox 里只要有一条积压：
		 *
		 * ```
		 * t+0ms   registered
		 * t+3ms   inject         ← drain 取走消息：删 inbox 文件、记 seen、排队投递
		 * t+7ms   gate_released  「人主动输入」  ← -p 的 prompt 被判成 interactive
		 * t+8ms   handled        「被人接管，自动处理未走完（注入后 3 ms）」
		 * t+10ms  unregistered
		 * ```
		 *
		 * stderr：`Agent is already processing.…`，**退出码 1** —— 注入的消息和 `-p` 自己的
		 * prompt 撞车，三重后果：①整个 `-p` 调用失败，它本来要干的活没干
		 * ②那条消息永久丢失（seen 记了 inject、inbox 文件删了、LLM 只有 3ms 根本没看到）
		 * ③`-p` 的 prompt 被当成「人主动输入」，把闸门释放了，而这个模式里根本没有人。
		 *
		 * 「离线攒消息、下次启动补投」是设计里的正常场景，`-p` 又是脚本化调用的常见形式，
		 * 这个组合不罕见。消息留在 inbox 等下一个有人在场的会话处理 —— 那条路已经验过。
		 */
		if (sessionCtx !== undefined && !sessionCtx.hasUI) return;
		/**
		 * agent 正在干活时不处理消息。**这是修一个因果错位的 bug，不是性能优化。**
		 *
		 * 注入用的是 `deliverAs: "followUp"`，pi 的语义是「等 agent 没有待跑的工具调用了才投递」
		 * ——消息本来就插不进正在跑的那一轮。但下面的 `guard.gated = true` 是**同步立刻**生效的，
		 * 于是出现这种局面：一个长流程（比如 sw-graph 全量）跑到一半，轮询触发 drain，
		 * 闸门当场关上，而那条消息还在队列里排队等流程结束——
		 * **流程剩下的工具调用全部被一条还没投递、LLM 还没看到的消息拦住**。
		 *
		 * 交互模式下表现为弹框问人，`-p` 模式下 `decideToolCall` 直接 block，流程崩在半路。
		 *
		 * 所以这里等 agent 空下来再处理。消息留在 inbox，下一次轮询（5 秒）再试；
		 * 真到进程退出还没处理，那就是离线补投那条路，下次启动接着来——都是现成机制。
		 */
		if (sessionCtx !== undefined && !sessionCtx.isIdle()) return;
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
				pi.sendUserMessage(renderInjection(parsed.message, d.verdict ?? "FAILED", suspicious, d.foreignPaths), {
					deliverAs: "followUp",
				});
			}
		} finally {
			draining = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		agent = process.env.FNXBUS_AGENT ?? process.env.FORENYX_AGENT_NAME ?? "";
		if (agent.length === 0) {
			failInit(ctx, "未能确定本端角色名。请设 FNXBUS_AGENT=<角色名>，要和 roles.json 里的键一致。");
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
		if (!existsSync(rolesPath)) {
			// 没有角色表就不启动。不猜、不用内置默认值：猜错的后果是两个 agent
			// 落到不同的角色定义上，表现为「消息发了但对方不处理」，最难查。
			failInit(ctx, `找不到角色表 ${rolesPath}。\n${rolesTemplate(agent, rolesPath)}`);
			return;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(rolesPath, "utf8"));
		} catch (e) {
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
				description: "接收方角色名，或 `*` 表示按订阅扇出——投给角色表里订阅了这个 type 的所有角色",
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
			// 这里手写了个只认前缀的劣化版，把 `a/b/*/docs/**` 中间那个通配符判错了，
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

	/**
	 * 初始化一个项目：建 `.fnxbus/project.json` 与 `.fnxbus/roles.json`。
	 *
	 * **刻意只问一件事：项目根在哪。** 其余能推的都推：
	 *
	 * - 角色名从环境变量读，读不到才问
	 * - 订阅和产出范围留空——刚装上的人不知道该填什么，而且那是随业务变的，
	 *   不该在初始化时逼人决定。`--from <模板>` 可以一次填好
	 *
	 * 为什么项目根一定要人确认：猜错的后果是两个 agent 各建一个 `.fnxbus/`、
	 * 互相收不到消息、而且不报错——是最难查的那类故障。问一句「是这里吗」，
	 * 人回车确认，就不是猜了。
	 *
	 * 这个命令在 fnxbus **未启用时也要能用**（它就是用来让它能启用的），
	 * 所以不看 `initError`、不用启动时算出的 `projectRoot`。
	 */
	pi.registerCommand("bus-setup", {
		description: "fnxbus：初始化这个项目（建 .fnxbus/ 下的两个配置文件）。可选 --from <模板路径>",
		handler: async (args, ctx) => {
			const templatePath = /--from\s+(\S+)/.exec(args)?.[1];

			// 项目根：给候选让人选，而不是直接用某一个。
			// 顺序按「多半是对的」排：已初始化的 > 上一层（agent 通常在项目根的子目录里跑）
			// > 当前目录 > git 根。
			const here = resolve(ctx.cwd);
			const parent = dirname(here);
			const initialized = findInitializedRoot(ctx.cwd);
			const git = gitRoot(ctx.cwd);
			const candidates: { path: string; label: string }[] = [];
			const addCandidate = (path: string | undefined, label: string) => {
				if (path === undefined) return;
				if (candidates.some((c) => c.path === path)) return;
				candidates.push({ path, label });
			};
			addCandidate(initialized, "已经初始化过，别的 agent 多半用的就是它");
			addCandidate(parent === here ? undefined : parent, "上一层");
			addCandidate(here, "当前目录");
			addCandidate(git, "git 仓库根");

			const pickOther = "自己输入路径";
			const options = [...candidates.map((c) => `${c.path}（${c.label}）`), pickOther];
			const picked = await ctx.ui.select(
				["项目根定在哪？两个 agent 必须选同一个，否则互相收不到消息。", "", "（这是唯一需要你确认的事）"].join(
					"\n",
				),
				options,
			);
			if (picked === undefined) return;
			let projectDir: string;
			if (picked === pickOther) {
				const typed = await ctx.ui.input("项目根的绝对路径", here);
				if (typed === undefined || typed.trim().length === 0) return;
				projectDir = resolve(typed.trim());
			} else {
				// 从选项文本反查回路径，别用正则剥括号——路径本身可能带括号
				const hit = candidates.find((c) => `${c.path}（${c.label}）` === picked);
				if (hit === undefined) return;
				projectDir = hit.path;
			}
			if (!existsSync(projectDir)) {
				ctx.ui.notify(`目录不存在：${projectDir}`, "error");
				return;
			}

			// 角色名：能读就读，读不到才问
			let roleName = process.env.FNXBUS_AGENT ?? process.env.FORENYX_AGENT_NAME ?? "";
			if (roleName.length === 0) {
				const typed = await ctx.ui.input("本端角色名（要和别的 agent 用的名字区分开）", "");
				if (typed === undefined) return;
				roleName = typed.trim();
			}
			const nameErr = validateAgentName(roleName);
			if (nameErr !== undefined) {
				ctx.ui.notify(nameErr, "error");
				return;
			}

			// 模板：给了就照它填，没给就留空骨架
			let incoming: Record<string, Role> = { [roleName]: { subscribe: [], owns: [] } };
			let readonlyTools: string[] = [];
			if (templatePath !== undefined) {
				const tpl = resolve(templatePath);
				if (!existsSync(tpl)) {
					ctx.ui.notify(`模板不存在：${tpl}`, "error");
					return;
				}
				let tplRaw: unknown;
				try {
					tplRaw = JSON.parse(readFileSync(tpl, "utf8"));
				} catch (e) {
					ctx.ui.notify(`模板不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				const parsedTpl = parseRolesFile(tplRaw);
				if (parsedTpl.errors.length > 0) {
					ctx.ui.notify(`模板有问题：\n${parsedTpl.errors.map((x) => `  - ${x}`).join("\n")}`, "error");
					return;
				}
				incoming = parsedTpl.config.roles;
				readonlyTools = [...parsedTpl.config.readonlyTools];
				if (incoming[roleName] === undefined) {
					ctx.ui.notify(
						`模板里没有 ${roleName} 这个角色（有的是：${Object.keys(incoming).join(", ")}）。\n` +
							"要么换个模板，要么用 FNXBUS_AGENT 指定一个模板里有的角色名。",
						"warning",
					);
				}
			}

			const dir = busDir(projectDir);
			const projectFile = join(dir, "project.json");
			const rolesFile = join(dir, "roles.json");

			// 已有的角色表要合并，不能覆盖——第二个 agent 来 setup 时别把第一个的配置冲掉
			let merged: Record<string, Role> = {};
			let mergedTools = readonlyTools;
			let hadExisting = false;
			if (existsSync(rolesFile)) {
				hadExisting = true;
				let existingRaw: unknown;
				try {
					existingRaw = JSON.parse(readFileSync(rolesFile, "utf8"));
				} catch (e) {
					ctx.ui.notify(
						`已有的 roles.json 读不出来，没有动它：${e instanceof Error ? e.message : String(e)}`,
						"error",
					);
					return;
				}
				const parsedExisting = parseRolesFile(existingRaw);
				if (parsedExisting.errors.length > 0) {
					ctx.ui.notify(
						`已有的 roles.json 有问题，没有动它：\n${parsedExisting.errors.map((x) => `  - ${x}`).join("\n")}`,
						"error",
					);
					return;
				}
				merged = parsedExisting.config.roles;
				mergedTools = [...parsedExisting.config.readonlyTools];
			}
			const mergeResult = mergeRoles(merged, mergedTools, incoming, readonlyTools);
			merged = mergeResult.roles;
			mergedTools = mergeResult.readonlyTools;
			const overwritten = mergeResult.overwritten;

			try {
				if (!existsSync(projectFile)) writeAtomic(projectFile, `${JSON.stringify({}, null, "\t")}\n`);
				const body = mergedTools.length > 0 ? { roles: merged, readonlyTools: mergedTools } : { roles: merged };
				writeAtomic(rolesFile, `${JSON.stringify(body, null, "\t")}\n`);
			} catch (e) {
				ctx.ui.notify(`写配置失败：${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}

			const lines = [
				`项目根：${projectDir}`,
				hadExisting ? `已有角色表，合并进去了` : `建好了 ${projectFile}`,
				`写好了 ${rolesFile}`,
				`角色：${Object.keys(merged).join(", ")}`,
			];
			if (overwritten.length > 0) lines.push(`覆盖了已有的：${overwritten.join(", ")}`);
			const mine = merged[roleName];
			if (mine !== undefined && mine.subscribe.length === 0) {
				lines.push("", `${roleName} 的 subscribe 是空的——它收不到任何扇出消息（指名发给它的仍然能收到）。`);
				lines.push(`要订阅就编辑 ${rolesFile}，或者用 --from <模板> 重跑一次。`);
			}
			lines.push("", "重启本 agent 生效。");
			ctx.ui.notify(lines.join("\n"), "info");
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
