from __future__ import annotations

import os
from dataclasses import dataclass


def _load_dotenv(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
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


_load_dotenv()


@dataclass(frozen=True)
class Settings:
    dashscope_api_key: str = os.environ.get("DASHSCOPE_API_KEY", "")
    base_url: str = os.environ.get(
        "BAILIAN_BASE_URL",
        "https://ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com",
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
    asr_max_audio_seconds: int = int(os.environ.get("ASR_MAX_AUDIO_SECONDS", "7200"))
    oss_bucket: str = os.environ.get("OSS_BUCKET", "")
    oss_access_key_id: str = os.environ.get("OSS_ACCESS_KEY_ID", "")
    oss_access_key_secret: str = os.environ.get("OSS_ACCESS_KEY_SECRET", "")
    oss_endpoint: str = os.environ.get("OSS_ENDPOINT", "oss-cn-beijing.aliyuncs.com")
    oss_path_prefix: str = os.environ.get("OSS_PATH_PREFIX", "meeting-asr-uploads/")
    paraformer_ws_url: str = os.environ.get(
        "PARAFORMER_WS_URL",
        "wss://ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
    )
    paraformer_model: str = os.environ.get("PARAFORMER_MODEL", "paraformer-realtime-v2")
    paraformer_format: str = os.environ.get("PARAFORMER_FORMAT", "pcm")
    paraformer_sample_rate: int = int(os.environ.get("PARAFORMER_SAMPLE_RATE", "16000"))
    paraformer_semantic_punctuation: bool = os.environ.get(
        "PARAFORMER_SEMANTIC_PUNCTUATION", "true"
    ).lower() in ("true", "1", "yes")
    host: str = os.environ.get("BACKEND_HOST", "127.0.0.1")
    port: int = int(os.environ.get("BACKEND_PORT", "8000"))
    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")

    def language_hints_list(self) -> list[str]:
        return [s.strip() for s in self.asr_language_hints.split(",") if s.strip()]

    @property
    def oss_configured(self) -> bool:
        return bool(self.oss_bucket and self.oss_access_key_id and self.oss_access_key_secret)


settings = Settings()