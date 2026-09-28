#!/usr/bin/env python3
"""把 vitest 的结果导成一份人能读的用例清单（TESTS.md）。

    node node_modules/vitest/dist/cli.js --run --reporter=json --outputFile=/tmp/vitest-report.json
    python3 scripts/gen-test-list.py

「173 个测试全过」这个数字说明不了测了什么。这份清单的用处是：
改动前能扫一眼「这块有没有被覆盖」，而不用翻五个测试文件。
"""

from __future__ import annotations

import collections
import json
import os
import sys

REPORT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vitest-report.json"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "TESTS.md")

# 每个文件管什么。**照实写**——比如 contract.test.ts 实际同时测 contract.ts 和 gate.ts，
# 文件名只提了一个，这种事要写出来而不是让人自己去发现。
FILE_DESC = {
    "contract.test.ts": (
        "消息契约 + ②层机制校验",
        "`contract.ts`（结构、版本号、`verdict` 闭合枚举、未知字段、体积上限）与 "
        "`gate.ts`（幂等、内容指纹去重、速率上限、`reply_to` 交叉核对、摘要实算比对、"
        "文件归属、订阅路由、注入模板）。**文件名只提了 contract，实际两个模块都在这里测。**",
    ),
    "guard.test.ts": (
        "授权闸门",
        "工具调用的副作用分类——含一个手写的 shell 词法分析器（用正则判断连踩五次坑："
        "`cd X && find`、`for` 循环、引号里的 `|`、`2>&1`、`2>/dev/null`）——以及"
        "放行 / 询问 / 拦截的判定。",
    ),
    "store.test.ts": (
        "文件队列",
        "项目根解析、原子写、单实例锁、`seen`/`sent` 账本、名片 pid 探活、"
        "消息体积与 inbox 积压上限。",
    ),
    "roles.test.ts": (
        "角色表",
        "解析（两种写法）、角色名字符集（它要当目录名用）、`owns` 重叠检测、"
        "第二个 agent 来初始化时的合并。",
    ),
    "extension.test.ts": (
        "扩展入口（假 pi 驱动）",
        "`drain` 的两道守卫、闸门与 drain 的联动、按订阅扇出、坏消息隔离、拒收回执、"
        "丢失可见性。**保护的是「自己的逻辑不退化」，不能证明「对 pi 行为的假设仍然成立」**"
        "——后者只有真跑 agent 能验，那些假设在测试文件头列了出来。",
    ),
}
ORDER = ["contract.test.ts", "guard.test.ts", "store.test.ts", "roles.test.ts", "extension.test.ts"]


def main() -> None:
    if not os.path.exists(REPORT):
        sys.exit(f"找不到 {REPORT}，先跑 vitest 的 json reporter（见本文件头部注释）")
    d = json.load(open(REPORT, encoding="utf-8"))

    by_file: dict[str, collections.OrderedDict] = {}
    for tr in d["testResults"]:
        base = os.path.basename(tr["name"])
        groups: collections.OrderedDict = collections.OrderedDict()
        for a in tr["assertionResults"]:
            key = " › ".join(a["ancestorTitles"]) or "(无分组)"
            groups.setdefault(key, []).append(a["title"])
        by_file[base] = groups

    # 报告里出现了但 ORDER 没列的文件也要带上，别默默漏掉
    order = ORDER + [f for f in by_file if f not in ORDER]

    L: list[str] = []
    L.append("# 单测清单")
    L.append("")
    total_all = d.get("numTotalTests", 0)
    passed = d.get("numPassedTests", 0)
    L.append(f"{total_all} 个用例，{passed} 通过。自动导出，不要手改。")
    L.append("")
    L.append("重新生成：")
    L.append("")
    L.append("```bash")
    L.append("node node_modules/vitest/dist/cli.js --run --reporter=json --outputFile=/tmp/vitest-report.json")
    L.append("python3 scripts/gen-test-list.py")
    L.append("```")
    L.append("")
    L.append("「N 个测试全过」说明不了测了什么。这份清单的用处是改动前扫一眼")
    L.append("「这块有没有被覆盖」，不用翻五个测试文件。")
    L.append("")
    L.append("## 分布")
    L.append("")
    L.append("| 文件 | 管什么 | 用例数 |")
    L.append("|---|---|---|")
    total = 0
    for f in order:
        if f not in by_file:
            continue
        n = sum(len(v) for v in by_file[f].values())
        total += n
        label = FILE_DESC.get(f, (f, ""))[0]
        L.append(f"| [`{f}`](#{f.replace('.', '')}) | {label} | {n} |")
    L.append(f"| | | **{total}** |")
    L.append("")

    for f in order:
        if f not in by_file:
            continue
        label, desc = FILE_DESC.get(f, (f, "（这个文件还没写说明）"))
        n = sum(len(v) for v in by_file[f].values())
        L.append("---")
        L.append("")
        L.append(f'<a id="{f.replace(".", "")}"></a>')
        L.append("")
        L.append(f"## `{f}` —— {label}")
        L.append("")
        L.append(f"{n} 条。{desc}")
        L.append("")
        for group, titles in by_file[f].items():
            L.append(f"### {group}")
            L.append("")
            for t in titles:
                L.append(f"- {t}")
            L.append("")

    open(OUT, "w", encoding="utf-8").write("\n".join(L) + "\n")
    print(f"写好 {OUT}：{total} 条用例，{len(by_file)} 个文件")


if __name__ == "__main__":
    main()
