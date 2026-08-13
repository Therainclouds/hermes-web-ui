"""方案 D：对 hermes-agent 上游源码（checkout）应用中文本地化补丁。

把两处硬编码英文文案改为官方 i18n 的 `t()` 调用（run.py 已在第 56 行
`from agent.i18n import t`），并在 locales/en.yaml + locales/zh.yaml 补上新 key。
这样：
  - 默认语言（en）行为与上游完全一致
  - 设置 HERMES_LANGUAGE=zh（或 config.yaml display.language: zh）后，
    配对码与 home channel 提示即为中文 —— 全走官方机制，零 monkey-patch
  - 补丁极小，与上游 i18n 方向一致，未来可原样提交上游（方案 A）

用法:
    python3 apply_cn_patch.py <hermes-agent-checkout-dir> [--revert]

目标版本基准: 上游 tag v2026.6.19 == hermes-agent 0.17.0（真机已验证结构）。

所有替换都是精确字符串匹配 + 计数校验；任何一步失败立即退出，
保证不会产出半补丁的源码。重复执行幂等。
"""

from __future__ import annotations

import argparse
import py_compile
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# gateway/run.py 的替换（基于 0.17.0 真机源码的精确上下文）
# ---------------------------------------------------------------------------

# 配对码提示：f-string 内联 → t() 调用
_PAIRING_OLD = (
    "                    if adapter:\n"
    "                        await adapter.send(\n"
    "                            source.chat_id,\n"
    '                            f"Hi~ I don\'t recognize you yet!\\n\\n"\n'
    '                            f"Here\'s your pairing code: `{code}`\\n\\n"\n'
    '                            f"Ask the bot owner to run:\\n"\n'
    '                            f"`hermes pairing approve {platform_name} {code}`"\n'
    "                        )\n"
)
_PAIRING_NEW = (
    "                    if adapter:\n"
    "                        await adapter.send(\n"
    "                            source.chat_id,\n"
    '                            t("pairing.code_prompt", code=code, platform_name=platform_name)\n'
    "                        )\n"
)

# Home channel 提示：f-string 内联 → t() 调用
_HOME_OLD = (
    "                notice = (\n"
    '                    f"📬 No home channel is set for {platform_name.title()}. "\n'
    '                    f"A home channel is where Hermes delivers cron job results "\n'
    '                    f"and cross-platform messages.\\n\\n"\n'
    '                    f"Type {sethome_cmd} to make this chat your home channel, "\n'
    '                    f"or ignore to skip."\n'
    "                )\n"
)
_HOME_NEW = (
    "                notice = t(\n"
    '                    "gateway.no_home_channel",\n'
    "                    platform_name=platform_name.title(),\n"
    "                    sethome_cmd=sethome_cmd,\n"
    "                )\n"
)

# ---------------------------------------------------------------------------
# locales/ 新增 key
# ---------------------------------------------------------------------------

_EN_PAIRING_BLOCK = (
    "\n"
    "# --- added by hermes-web-ui CN localization patch ---\n"
    "pairing:\n"
    '  code_prompt: "Hi~ I don\'t recognize you yet!\\n\\nHere\'s your pairing code: '
    '`{code}`\\n\\nAsk the bot owner to run:\\n`hermes pairing approve {platform_name} {code}`"\n'
)
_EN_GATEWAY_KEY = '  no_home_channel: "📬 No home channel is set for {platform_name}. ' \
    'A home channel is where Hermes delivers cron job results and cross-platform messages.' \
    '\\n\\nType {sethome_cmd} to make this chat your home channel, or ignore to skip."\n'

_ZH_PAIRING_BLOCK = (
    "\n"
    "# --- added by hermes-web-ui CN localization patch ---\n"
    "pairing:\n"
    '  code_prompt: "你好~ 我还不认识你！\\n\\n这是你的配对码：`{code}`\\n\\n请找 bot 主人运行：'
    '\\n`hermes pairing approve {platform_name} {code}`"\n'
)
_ZH_GATEWAY_KEY = '  no_home_channel: "📬 {platform_name} 还没设置主频道（home channel）。' \
    '\\n\\n主频道是 Hermes 发送定时任务结果和跨平台消息的地方。' \
    '\\n\\n回复 {sethome_cmd} 把当前对话设为主频道，或忽略跳过。"\n'


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------

def _replace_once(path: Path, old: str, new: str) -> bool:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 0:
        return False
    if count > 1:
        raise SystemExit(f"{path}: expected exactly 1 occurrence of target, found {count}; abort")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def _insert_into_gateway_section(path: Path, key_line: str, key_name: str) -> bool:
    """把 <key_name> 插进 YAML 顶层 gateway: section 的开头（幂等）。"""
    text = path.read_text(encoding="utf-8")
    if f"\n  {key_name}:" in text or text.startswith(f"  {key_name}:"):
        return False  # 已存在
    lines = text.splitlines()
    idx = next((i for i, line in enumerate(lines) if line.rstrip() == "gateway:"), None)
    if idx is None:
        raise SystemExit(f"{path}: top-level 'gateway:' section not found; abort")
    insert_at = idx + 1
    while insert_at < len(lines) and not lines[insert_at].strip():
        insert_at += 1
    lines[insert_at:insert_at] = [key_line.rstrip("\n")]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def _append_pairing_block(path: Path, block: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if "pairing:" in text and "code_prompt" in text:
        return False  # 已存在
    if not text.endswith("\n"):
        text += "\n"
    path.write_text(text + block, encoding="utf-8")
    return True


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def _apply(source_dir: Path) -> None:
    run_py = source_dir / "gateway" / "run.py"
    en_yaml = source_dir / "locales" / "en.yaml"
    zh_yaml = source_dir / "locales" / "zh.yaml"
    for path, label in ((run_py, "gateway/run.py"), (en_yaml, "locales/en.yaml"), (zh_yaml, "locales/zh.yaml")):
        if not path.is_file():
            raise SystemExit(f"{label} not found in {source_dir}; is this a hermes-agent checkout?")

    changed: list[str] = []
    if _replace_once(run_py, _PAIRING_OLD, _PAIRING_NEW):
        changed.append("run.py: pairing message -> t('pairing.code_prompt')")
    if _replace_once(run_py, _HOME_OLD, _HOME_NEW):
        changed.append("run.py: home channel notice -> t('gateway.no_home_channel')")

    for yaml_path, pairing_block, gateway_key, lang in (
        (en_yaml, _EN_PAIRING_BLOCK, _EN_GATEWAY_KEY, "en"),
        (zh_yaml, _ZH_PAIRING_BLOCK, _ZH_GATEWAY_KEY, "zh"),
    ):
        if _append_pairing_block(yaml_path, pairing_block):
            changed.append(f"locales/{lang}.yaml: added pairing.code_prompt")
        if _insert_into_gateway_section(yaml_path, gateway_key, "no_home_channel"):
            changed.append(f"locales/{lang}.yaml: added gateway.no_home_channel")

    if not changed:
        print("[apply-cn] no changes needed (already patched)")
    else:
        for line in changed:
            print(f"[apply-cn] + {line}")

    # 语法校验 run.py，确保补丁没破坏源码
    py_compile.compile(str(run_py), doraise=True)
    print("[apply-cn] py_compile ok for gateway/run.py")


def _revert(source_dir: Path) -> None:
    run_py = source_dir / "gateway" / "run.py"
    reverted: list[str] = []
    if _replace_once(run_py, _PAIRING_NEW, _PAIRING_OLD):
        reverted.append("run.py: restored pairing message")
    if _replace_once(run_py, _HOME_NEW, _HOME_OLD):
        reverted.append("run.py: restored home channel notice")
    print("[apply-cn] reverted:", reverted or "nothing")


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply Hermes CN localization patch to a hermes-agent checkout")
    parser.add_argument("source_dir", type=Path, help="hermes-agent source checkout directory")
    parser.add_argument("--revert", action="store_true", help="revert the patch instead of applying")
    args = parser.parse_args()

    if args.revert:
        _revert(args.source_dir)
    else:
        _apply(args.source_dir)
    sys.exit(0)


if __name__ == "__main__":
    main()
