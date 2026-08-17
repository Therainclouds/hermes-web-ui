#!/usr/bin/env python3
"""Build the cumulative versions.json published to the device OSS release bucket.

The server's runtime-version-manager (`GET /api/hermes/runtime-versions`) reads
this file from `{OSS}/versions.json` as its remote version list. The list must be
cumulative: every release appends the current tag instead of replacing history.

Input (env vars):
  RELEASE_TAGS              Space separated git tags, e.g. "v0.7.15 v0.7.16"
  AGENT_VERSION             Current Hermes Agent version, e.g. "0.15.2"
  HERMES_VERSIONS           Optional space separated published Hermes Agent
                            versions, e.g. "0.15.2 0.16.0". Merged with
                            AGENT_VERSION so the manifest lists every published
                            version (newest first) instead of the single
                            pinned stable.
  EXISTING_VERSIONS_PATH    Optional path to the existing versions.json fetched
                            from OSS; merged so already published versions are kept.
  OUTPUT_PATH               Output file path. When empty, prints JSON to stdout.

Output shape (schema 1):
  {"schema": 1, "hermes": ["..."], "webui": ["..."]}
"""
import json
import os
import re
from pathlib import Path

SEMVER_RE = re.compile(r'^v?(\d+)\.(\d+)\.(\d+)$')
TAG_RE = re.compile(r'^v(\d+)\.(\d+)\.(\d+)$')


def version_key(version: str):
    match = SEMVER_RE.match(version.strip())
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def merge_sorted(values, sort_key):
    """Dedupe, drop invalid entries, and sort descending (newest first)."""
    seen = set()
    entries = []
    for value in values:
        item = value.strip()
        key = sort_key(item)
        if key is None or item in seen:
            continue
        seen.add(item)
        entries.append((item, key))
    entries.sort(key=lambda pair: pair[1], reverse=True)
    return [item for item, _ in entries]


def normalize_existing(payload):
    if not isinstance(payload, dict):
        return {"schema": 1, "hermes": [], "webui": []}
    hermes = [str(item).strip() for item in payload.get("hermes", []) if str(item).strip()]
    webui = [str(item).strip() for item in payload.get("webui", []) if str(item).strip()]
    return {"schema": 1, "hermes": hermes, "webui": webui}


def main() -> int:
    tags = [tag for tag in (os.environ.get("RELEASE_TAGS", "") or "").split() if tag]
    agent_version = (os.environ.get("AGENT_VERSION", "") or "").strip()
    hermes_versions = [v for v in (os.environ.get("HERMES_VERSIONS", "") or "").split() if v.strip()]
    existing_path = (os.environ.get("EXISTING_VERSIONS_PATH", "") or "").strip()
    output_path = (os.environ.get("OUTPUT_PATH", "") or "").strip()

    existing = {"schema": 1, "hermes": [], "webui": []}
    if existing_path:
        path = Path(existing_path)
        if path.exists():
            try:
                existing = normalize_existing(json.loads(path.read_text(encoding="utf-8")))
            except Exception as exc:  # noqa: BLE001 - best-effort merge
                print(f"warning: failed to parse existing versions manifest {path}: {exc}")

    webui = list(existing["webui"])
    for tag in tags:
        match = TAG_RE.match(tag.strip())
        if match:
            webui.append(".".join(match.groups()))

    hermes = list(existing["hermes"])
    candidate_hermes = [*hermes_versions, agent_version]
    for version in candidate_hermes:
        if version and SEMVER_RE.match(version):
            hermes.append(version)

    payload = {
        "schema": 1,
        "hermes": merge_sorted(hermes, version_key),
        "webui": merge_sorted(webui, version_key),
    }

    if not output_path:
        print(json.dumps(payload, indent=2) + "\n")
        return 0
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output_path} (hermes={len(payload['hermes'])}, webui={len(payload['webui'])})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
