from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: str | os.PathLike[str]) -> None:
    p = Path(path)
    if not p.exists():
        return
    try:
        with p.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        # Config file present but unreadable — don't crash startup; storage
        # layer will surface a clearer error when the user tries to save.
        pass


# .env lives in DATA_DIR (not cwd), so secrets never end up in the install
# directory, never get packaged into device updates, and survive across
# re-deploys. Cwd can be anywhere under systemd.
_data_dir_env = Path(os.environ.get("DATA_DIR", "data")).resolve()
_load_dotenv(_data_dir_env / "config.env")


@dataclass
class Settings:
    # NOTE: this is intentionally NOT frozen. It is the single runtime copy of
    # the ASR/analysis configuration that the request handlers actually read
    # (asr_proxy, diarize_*). It is seeded from process env at startup, and is
    # kept in sync with the persisted config.json by Storage._save_config()
    # (storage.py) — see Settings.sync_from() below.
    #
    # History: v0.7.17 incident "DASHSCOPE_API_KEY is not configured" after a
    # hot config push. The class was `frozen=True` with defaults evaluated once
    # at import time, so `update_config()` (which writes config.json +
    # config.env) never refreshed the in-memory object that asr_proxy reads.
    # Result: the key was on disk but the running process kept using the empty
    # startup value. Making it mutable + Storage-backed is the root-cause fix.
    dashscope_api_key: str = os.environ.get("DASHSCOPE_API_KEY", "")
    # DashScope *root* domain — submit/poll code paths already include the
    # `/api/v1/...` segment, so do NOT put a trailing `/v1` here. Operators
    # that paste `https://dashscope.aliyuncs.com/v1` from the console will
    # be normalized by diarize_proxy._normalize_base_url(), but the default
    # below stays clean to keep logs and `config.current` readable.
    base_url: str = os.environ.get(
        "BAILIAN_BASE_URL",
        "https://dashscope.aliyuncs.com",
    )
    asr_model: str = os.environ.get("ASR_MODEL", "paraformer-v2")
    asr_sample_rate: int = int(os.environ.get("ASR_SAMPLE_RATE", "16000"))
    asr_format: str = os.environ.get("ASR_FORMAT", "pcm")
    asr_language_hints: str = os.environ.get("ASR_LANGUAGE_HINTS", "zh,en")
    asr_default_speaker_count: int = int(
        os.environ.get("ASR_DEFAULT_SPEAKER_COUNT", "0")
    )
    asr_chunk_seconds: float = float(os.environ.get("ASR_CHUNK_SECONDS", "12"))
    asr_chunk_overlap_seconds: float = float(
        os.environ.get("ASR_CHUNK_OVERLAP_SECONDS", "2.0")
    )
    asr_poll_interval_seconds: float = float(
        os.environ.get("ASR_POLL_INTERVAL_SECONDS", "0.2")
    )
    # Configurable per-request. Env var sets the ceiling, but the runtime
    # `meeting_max_audio_seconds` field (read from data/config.json) overrides
    # it. Useful for short ad-hoc captures vs long board meetings.
    asr_max_audio_seconds: int = int(os.environ.get("ASR_MAX_AUDIO_SECONDS", "7200"))
    oss_bucket: str = os.environ.get("OSS_BUCKET", "")
    oss_access_key_id: str = os.environ.get("OSS_ACCESS_KEY_ID", "")
    oss_access_key_secret: str = os.environ.get("OSS_ACCESS_KEY_SECRET", "")
    oss_endpoint: str = os.environ.get("OSS_ENDPOINT", "oss-cn-beijing.aliyuncs.com")
    oss_path_prefix: str = os.environ.get("OSS_PATH_PREFIX", "meeting-asr-uploads/")
    paraformer_ws_url: str = os.environ.get(
        "PARAFORMER_WS_URL",
        "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    )
    paraformer_model: str = os.environ.get("PARAFORMER_MODEL", "paraformer-realtime-v2")
    # Omni-Realtime (multimodal conversation model, e.g.
    # `qwen3.5-omni-flash-realtime`). Reuses the same DASHSCOPE_API_KEY as the
    # ASR service — we never expose a per-session key from the client.
    omni_realtime_ws_url: str = os.environ.get(
        "OMNI_REALTIME_WS_URL",
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    )
    omni_realtime_model: str = os.environ.get(
        "OMNI_REALTIME_MODEL",
        "qwen3.5-omni-flash-realtime",
    )
    omni_realtime_voice: str = os.environ.get(
        "OMNI_REALTIME_VOICE",
        "Cherry",
    )
    omni_realtime_instructions: str = os.environ.get(
        "OMNI_REALTIME_INSTRUCTIONS",
        "",
    )
    paraformer_format: str = os.environ.get("PARAFORMER_FORMAT", "pcm")
    paraformer_sample_rate: int = int(os.environ.get("PARAFORMER_SAMPLE_RATE", "16000"))
    paraformer_semantic_punctuation: bool = os.environ.get(
        "PARAFORMER_SEMANTIC_PUNCTUATION", "true"
    ).lower() in ("true", "1", "yes")
    host: str = os.environ.get("BACKEND_HOST", "127.0.0.1")
    port: int = int(os.environ.get("BACKEND_PORT", "8000"))
    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")

    def sync_from(self, asr: object) -> None:
        """Refresh the fields that a hot config push (Storage.update_config)
        may have changed.

        `asr` is the runtime ASRConfig pydantic model from storage. Only the
        fields that Storage actually persists are copied — anything that is
        purely process-env (host/port/cors, OSS credentials, chunking knobs)
        stays untouched because those are spawn-time decisions by the Node
        parent and cannot be changed without a restart anyway.

        Called by Storage._save_config() after every write, so disk
        (config.json + config.env), Storage._config, and this object always
        agree. Without this the handlers read stale secrets after the user
        edits the key in the Web UI.
        """
        if asr is None:
            return
        self.dashscope_api_key = asr.dashscope_api_key
        self.paraformer_ws_url = asr.paraformer_ws_url
        self.paraformer_model = asr.paraformer_model
        self.paraformer_format = asr.paraformer_format
        self.paraformer_sample_rate = int(asr.paraformer_sample_rate)
        self.paraformer_semantic_punctuation = bool(asr.paraformer_semantic_punctuation)
        # language hints live under the ASR section too; keep both spellings
        # in sync so callers that read either name see the same value.
        if getattr(asr, "paraformer_language_hints", None):
            self.asr_language_hints = asr.paraformer_language_hints

    def language_hints_list(self) -> list[str]:
        return [s.strip() for s in self.asr_language_hints.split(",") if s.strip()]

    @property
    def oss_configured(self) -> bool:
        return bool(self.oss_bucket and self.oss_access_key_id and self.oss_access_key_secret)


settings = Settings()