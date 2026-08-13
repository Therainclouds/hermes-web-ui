"""Hermes CN patch 自检脚本（方案 C）。

用法（在目标设备上，使用 hermes-agent 的 venv python 运行）:
    /home/hermesui/.hermes/hermes-agent-venv/bin/python3 \
        /opt/hermes-web-ui/patches/selfcheck.py

或在本地用任一装有 hermes-agent 的 venv python 运行:
    python3 selfcheck.py

输出: 逐项 PASS/FAIL + 退出码（0=全部通过，1=有失败项）。
"""

from __future__ import annotations

import os
import sys

PATCHES_DIR = os.path.dirname(os.path.abspath(__file__))
if PATCHES_DIR not in sys.path:
    sys.path.insert(0, PATCHES_DIR)


def main() -> int:
    import hermes_cn_localization as hcn

    print("== 应用 patch ==")
    warnings = hcn.apply()
    for warning in warnings:
        print(f"  WARN: {warning}")
    print(f"  applied (warnings: {len(warnings)})")

    print("\n== 自检 ==")
    status = hcn.verify()
    failed = False

    for alias, resolved in sorted(status.get("aliases", {}).items()):
        ok = resolved is not None
        failed = failed or not ok
        print(f"  alias /{alias:<6} -> {resolved!r:<10} {'PASS' if ok else 'FAIL'}")

    for target, wrapped in sorted(status.get("strings", {}).items()):
        ok = wrapped is True
        failed = failed or not ok
        print(f"  wrap {target:<55} {wrapped!r:<6} {'PASS' if ok else 'FAIL'}")

    for name in ("translate_pairing", "translate_home"):
        ok = status.get(name) is True
        failed = failed or not ok
        print(f"  {name:<18} {status.get(name)!r:<6} {'PASS' if ok else 'FAIL'}")

    print(f"\n== {'ALL PASS' if not failed else 'FAILURES PRESENT'} ==")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
