"""Python 启动钩子 —— 自动注入 Hermes Agent 中文本地化 patch（方案 C）。

机制说明:
  - `sitecustomize` 是 Python 在解释器启动时（导入 site 模块）自动 import 的
    标准钩子，交互式与非交互式进程都生效 —— 这是对需求文档原方案
    `PYTHONSTARTUP`（仅交互式生效）的修正。
  - 通过 `PYTHONPATH=<本目录>` 注入（例如写到 /etc/default/hermes-web-ui 的
    EnvironmentFile 里，随 web UI -> gateway 子进程环境变量链路生效）。
  - 本目录必须同时包含本文件与 hermes_cn_localization.py。

安全性:
  - 任何失败只打印一条 stderr 警告，绝不阻断进程启动。
  - 对不包含 hermes_cli / gateway 的 Python 环境（如 meeting-asr 独立 venv），
    导入失败被捕获后直接跳过。
"""

import sys


def _main() -> None:
    try:
        import hermes_cn_localization as _hcn
    except Exception as exc:  # noqa: BLE001 - 任何失败都不阻断启动
        print(f"[hermes-cn] patch module unavailable, skipped: {exc!r}", file=sys.stderr)
        return

    warnings = _hcn.apply()
    if warnings:
        print("[hermes-cn] patch applied with warnings:", file=sys.stderr)
        for warning in warnings:
            print(f"  - {warning}", file=sys.stderr)
    else:
        print("[hermes-cn] all patches applied", file=sys.stderr)


_main()
