"""Hermes Agent 中文本地化 —— 运行时 monkey-patch 核心模块（方案 C）。

覆盖（目标 hermes-agent 0.17.x，内容锚定，不依赖行号）:
  1. Slash 命令中文别名：/新会话 /新对话 → /new，/设为主频道 /设为主对话 → /sethome，
     /停止 /终止 → /stop，/帮助 /菜单 → /help
  2. 配对码提示文案：发送出口内容锚定翻译（飞书/微信/其他平台的 send 汇聚点）
  3. Home channel 提示文案：同上

设计约束:
  - 所有 patch 独立 try/except 兜底，失败仅返回 warning 字符串，绝不抛异常
  - 文案翻译按英文 marker 内容匹配（marker 不存在则原文透传），幂等
  - 别名 patch 修改 `CommandDef.aliases` 后必须重建 `_COMMAND_LOOKUP`
    （0.17.0 无 rebuild_lookups() 函数，注释过时）
  - 由 `sitecustomize.py` 在解释器启动时导入并调用 apply()；
    也可由 `selfcheck.py` 单独导入做自检

参考: docs/planning/hermes-cn-localization-memo.md
"""

from __future__ import annotations

import functools
import importlib
import re
import sys

# ---------------------------------------------------------------------------
# 1. Slash 命令中文别名
# ---------------------------------------------------------------------------

# 中文别名映射: 英文主名 -> 中文别名（与需求文档 2.3 一致）
_ZH_ALIASES: dict[str, tuple[str, ...]] = {
    "new": ("新会话", "新对话"),
    "sethome": ("设为主频道", "设为主对话"),
    "stop": ("停止", "终止"),
    "help": ("帮助", "菜单"),
}


def _patch_aliases() -> list[str]:
    """给 COMMAND_REGISTRY 追加中文别名并重建命令查找表。

    0.17.0 的 CommandDef 是 dataclass，aliases 字段不能直接赋值，
    必须走 object.__setattr__；_COMMAND_LOOKUP 是 import 时一次性构建的
    缓存，改完字段后必须重建，否则 resolve_command 仍查旧缓存。
    """
    warnings: list[str] = []
    try:
        import hermes_cli.commands as commands

        patched = 0
        for name, aliases in _ZH_ALIASES.items():
            cmd = commands.resolve_command(name)
            if cmd is None:
                warnings.append(f"alias: command '{name}' not found, skipped")
                continue
            merged = tuple(dict.fromkeys(cmd.aliases + aliases))
            object.__setattr__(cmd, "aliases", merged)
            patched += 1

        # 重建查找缓存（关键步骤，缺了别名解析不到）
        commands._COMMAND_LOOKUP = commands._build_command_lookup()

        # 自检：抽查两个代表别名
        for probe, expect in (("/新会话", "new"), ("设为主频道", "sethome")):
            resolved = commands.resolve_command(probe)
            if resolved is None or resolved.name != expect:
                warnings.append(f"alias: resolve '{probe}' -> {resolved!r}, expected {expect}")
        if patched:
            return warnings
        return warnings or ["alias: no commands patched"]
    except Exception as exc:  # noqa: BLE001 - patch 失败不阻断启动
        return [f"alias: patch failed: {exc!r}"]


# ---------------------------------------------------------------------------
# 2/3. 配对码 + Home channel 文案（发送出口内容锚定翻译）
# ---------------------------------------------------------------------------

_PAIRING_MARKER = "Hi~ I don't recognize you yet!"
_PAIRING_RE = re.compile(
    r"Here's your pairing code: `(?P<code>[A-Za-z0-9]+)`.*?"
    r"`hermes pairing approve (?P<platform>\w+)",
    re.S,
)
_HOME_MARKER = "No home channel is set for "


def _translate_outbound_text(text: str) -> str:
    """对已知英文系统提示做内容锚定翻译；非目标文案原样返回（幂等）。"""
    if not isinstance(text, str):
        return text

    # 配对码提示（gateway/run.py 发送的原始英文）
    if _PAIRING_MARKER in text:
        match = _PAIRING_RE.search(text)
        if match:
            code, platform = match.group("code"), match.group("platform")
            return (
                "你好~ 我还不认识你！\n\n"
                f"这是你的配对码：`{code}`\n\n"
                "请找 bot 主人运行：\n"
                f"`hermes pairing approve {platform} {code}`"
            )

    # Home channel 提示
    if _HOME_MARKER in text:
        sethome_cmd = "/hermes sethome" if "/hermes sethome" in text else "/sethome"
        platform_match = re.search(r"No home channel is set for ([^.]+)\.", text)
        platform = platform_match.group(1).strip() if platform_match else "该平台"
        return (
            f"📬 {platform} 还没设置主频道（home channel）。\n\n"
            "主频道是 Hermes 发送定时任务结果和跨平台消息的地方。\n\n"
            f"回复 {sethome_cmd} 把当前对话设为主频道，或忽略跳过。"
        )

    return text


def _make_send_wrapper(orig, content_index: int):
    """包装 adapter 的 send 类方法：翻译 content 参数后转调原方法。

    send(chat_id, content, ...)                -> content_index=1
    send_private_notice(chat_id, user_id, content, ...) -> content_index=2
    """

    @functools.wraps(orig)
    async def wrapper(self, *args, **kwargs):
        if len(args) > content_index and isinstance(args[content_index], str):
            args = (*args[:content_index], _translate_outbound_text(args[content_index]), *args[content_index + 1:])
        elif "content" in kwargs and isinstance(kwargs["content"], str):
            kwargs["content"] = _translate_outbound_text(kwargs["content"])
        return await orig(self, *args, **kwargs)

    wrapper._hermes_cn_wrapped = True  # 幂等标记，防止重复包装
    return wrapper


# 需要包装的方法: 模块 -> (类名, 方法名 -> content 位置)
_STRING_PATCH_TARGETS: dict[str, tuple[str, dict[str, int]]] = {
    # 目标平台：飞书/微信各自覆写了 send，必须各自包装
    "gateway.platforms.feishu": ("FeishuAdapter", {"send": 1}),
    "gateway.platforms.weixin": ("WeixinAdapter", {"send": 1}),
    # 基类兜底：其余平台 + 通知路径
    "gateway.platforms.base": ("BasePlatformAdapter", {"send": 1, "send_private_notice": 2}),
}


def _patch_string_translation() -> list[str]:
    warnings: list[str] = []
    for module_name, (class_name, methods) in _STRING_PATCH_TARGETS.items():
        try:
            module = importlib.import_module(module_name)
            cls = getattr(module, class_name)
            for method_name, content_index in methods.items():
                orig = getattr(cls, method_name, None)
                if orig is None:
                    warnings.append(f"strings: {module_name}.{class_name}.{method_name} not found, skipped")
                    continue
                if getattr(orig, "_hermes_cn_wrapped", False):
                    continue
                setattr(cls, method_name, _make_send_wrapper(orig, content_index))
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"strings: {module_name} patch failed: {exc!r}")
    return warnings


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def apply() -> list[str]:
    """应用全部 patch，返回 warning 列表（空列表 = 全部成功，不抛异常）。"""
    warnings: list[str] = []
    warnings.extend(_patch_aliases())
    warnings.extend(_patch_string_translation())
    return warnings


def verify() -> dict:
    """自检：返回各 patch 的生效状态（供 selfcheck.py 使用）。"""
    status: dict = {"aliases": {}, "strings": {}}

    # 别名生效性：只验证解析，不改任何状态
    try:
        import hermes_cli.commands as commands

        for probe in ("新会话", "设为主频道", "停止", "帮助"):
            resolved = commands.resolve_command(probe)
            status["aliases"][probe] = resolved.name if resolved else None
    except Exception as exc:  # noqa: BLE001
        status["aliases"]["error"] = repr(exc)

    # 文案包装生效性：检查方法是否被标记为已包装
    for module_name, (class_name, methods) in _STRING_PATCH_TARGETS.items():
        try:
            module = importlib.import_module(module_name)
            cls = getattr(module, class_name)
            for method_name in methods:
                method = getattr(cls, method_name, None)
                status["strings"][f"{module_name}.{class_name}.{method_name}"] = bool(
                    method and getattr(method, "_hermes_cn_wrapped", False)
                )
        except Exception as exc:  # noqa: BLE001
            status["strings"][module_name] = repr(exc)

    # 翻译函数行为自测（纯函数，不依赖运行环境）
    sample_pairing = (
        "Hi~ I don't recognize you yet!\n\n"
        "Here's your pairing code: `FLJ94RAZ`\n\n"
        "Ask the bot owner to run:\n"
        "`hermes pairing approve weixin FLJ94RAZ`"
    )
    sample_home = (
        "📬 No home channel is set for Weixin. A home channel is where Hermes "
        "delivers cron job results and cross-platform messages.\n\n"
        "Type /sethome to make this chat your home channel, or ignore to skip."
    )
    status["translate_pairing"] = "你好~ 我还不认识你！" in _translate_outbound_text(sample_pairing)
    status["translate_home"] = "还没设置主频道" in _translate_outbound_text(sample_home)
    return status


if __name__ == "__main__":
    # 直接运行：python hermes_cn_localization.py  -> 应用 patch 并打印状态
    result = apply()
    if result:
        print("[hermes-cn] WARNINGS:", file=sys.stderr)
        for warning in result:
            print(f"  - {warning}", file=sys.stderr)
    print("[hermes-cn] applied; verify:", verify())
