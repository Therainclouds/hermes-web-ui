from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from .models import AllConfig, AnalysisResult, AnalysisStatus, ASRConfig, LLMConfig, AnalysisConfig

log = logging.getLogger("storage")

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
CONFIG_FILE = DATA_DIR / "config.json"
ANALYSIS_FILE = DATA_DIR / "analysis.json"
STATUS_FILE = DATA_DIR / "status.json"
ENV_FILE = Path(".env")


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


class Storage:
    def __init__(self) -> None:
        _ensure_dir()
        self._config = self._load_config()
        self._analysis_result = self._load_analysis()
        self._status = self._load_status()

    def _load_config(self) -> AllConfig:
        if CONFIG_FILE.exists():
            try:
                data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                return AllConfig(**data)
            except Exception as e:
                log.warning("Failed to load config: %s", e)
        return AllConfig(
            asr=ASRConfig(
                dashscope_api_key=os.environ.get("DASHSCOPE_API_KEY", ""),
                paraformer_ws_url=os.environ.get("PARAFORMER_WS_URL", "wss://ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"),
                paraformer_model=os.environ.get("PARAFORMER_MODEL", "paraformer-realtime-v2"),
                paraformer_sample_rate=int(os.environ.get("PARAFORMER_SAMPLE_RATE", "16000")),
                paraformer_format=os.environ.get("PARAFORMER_FORMAT", "pcm"),
                paraformer_language_hints=os.environ.get("PARAFORMER_LANGUAGE_HINTS", "zh,en"),
                paraformer_semantic_punctuation=os.environ.get("PARAFORMER_SEMANTIC_PUNCTUATION", "true").lower() in ("true", "1", "yes"),
            ),
            llm=LLMConfig(),
            analysis=AnalysisConfig(),
        )

    def _save_config(self) -> None:
        try:
            CONFIG_FILE.write_text(
                self._config.model_dump_json(indent=2),
                encoding="utf-8",
            )
            self._save_to_env()
        except Exception as e:
            log.error("Failed to save config: %s", e)

    def _save_to_env(self) -> None:
        try:
            env_lines = []
            if ENV_FILE.exists():
                with open(ENV_FILE, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key = line.split("=")[0].strip()
                            if key not in [
                                "DASHSCOPE_API_KEY",
                                "PARAFORMER_WS_URL",
                                "PARAFORMER_MODEL",
                                "PARAFORMER_SAMPLE_RATE",
                                "PARAFORMER_FORMAT",
                                "PARAFORMER_LANGUAGE_HINTS",
                                "PARAFORMER_SEMANTIC_PUNCTUATION",
                            ]:
                                env_lines.append(line)

            asr = self._config.asr
            env_lines.append(f"DASHSCOPE_API_KEY={asr.dashscope_api_key}")
            env_lines.append(f"PARAFORMER_WS_URL={asr.paraformer_ws_url}")
            env_lines.append(f"PARAFORMER_MODEL={asr.paraformer_model}")
            env_lines.append(f"PARAFORMER_SAMPLE_RATE={asr.paraformer_sample_rate}")
            env_lines.append(f"PARAFORMER_FORMAT={asr.paraformer_format}")
            env_lines.append(f"PARAFORMER_LANGUAGE_HINTS={asr.paraformer_language_hints}")
            env_lines.append(f"PARAFORMER_SEMANTIC_PUNCTUATION={'true' if asr.paraformer_semantic_punctuation else 'false'}")

            with open(ENV_FILE, "w", encoding="utf-8") as f:
                f.write("\n".join(env_lines) + "\n")
        except Exception as e:
            log.error("Failed to save .env file: %s", e)

    def get_config(self) -> AllConfig:
        return self._config

    def get_config_safe(self) -> dict:
        data = self._config.model_dump()
        if data["asr"]["dashscope_api_key"]:
            key = data["asr"]["dashscope_api_key"]
            data["asr"]["dashscope_api_key_masked"] = key[:8] + "****" + key[-4:] if len(key) > 12 else "****"
        else:
            data["asr"]["dashscope_api_key_masked"] = ""
        if data["llm"]["api_key"]:
            key = data["llm"]["api_key"]
            data["llm"]["api_key_masked"] = key[:8] + "****" + key[-4:] if len(key) > 12 else "****"
        else:
            data["llm"]["api_key_masked"] = ""
        return data

    def update_config(self, config: AllConfig) -> None:
        self._config = config
        self._save_config()

    def update_asr_config(self, asr: ASRConfig) -> None:
        self._config.asr = asr
        self._save_config()

    def update_llm_config(self, llm: LLMConfig) -> None:
        self._config.llm = llm
        self._save_config()

    def update_analysis_config(self, analysis: AnalysisConfig) -> None:
        self._config.analysis = analysis
        self._save_config()

    def _load_analysis(self) -> AnalysisResult | None:
        if ANALYSIS_FILE.exists():
            try:
                data = json.loads(ANALYSIS_FILE.read_text(encoding="utf-8"))
                return AnalysisResult(**data)
            except Exception as e:
                log.warning("Failed to load analysis: %s", e)
        return None

    def _save_analysis(self) -> None:
        if self._analysis_result:
            try:
                ANALYSIS_FILE.write_text(
                    self._analysis_result.model_dump_json(indent=2),
                    encoding="utf-8",
                )
            except Exception as e:
                log.error("Failed to save analysis: %s", e)

    def get_analysis(self) -> AnalysisResult | None:
        return self._analysis_result

    def update_analysis(self, result: AnalysisResult) -> None:
        self._analysis_result = result
        self._save_analysis()

    def _load_status(self) -> AnalysisStatus:
        if STATUS_FILE.exists():
            try:
                data = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
                return AnalysisStatus(**data)
            except Exception as e:
                log.warning("Failed to load status: %s", e)
        return AnalysisStatus()

    def _save_status(self) -> None:
        try:
            STATUS_FILE.write_text(
                self._status.model_dump_json(indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            log.error("Failed to save status: %s", e)

    def get_status(self) -> AnalysisStatus:
        return self._status

    def update_status(self, **kwargs) -> None:
        for k, v in kwargs.items():
            if hasattr(self._status, k):
                setattr(self._status, k, v)
        self._save_status()

    def clear_analysis(self) -> None:
        self._analysis_result = None
        if ANALYSIS_FILE.exists():
            ANALYSIS_FILE.unlink()


storage = Storage()
