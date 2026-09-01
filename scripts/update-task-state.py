#!/usr/bin/env python3
import json
import os
import pwd
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"currentTask": None, "lastTask": None}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return {
                "currentTask": payload.get("currentTask"),
                "lastTask": payload.get("lastTask"),
            }
    except Exception:
        pass
    return {"currentTask": None, "lastTask": None}


def main() -> int:
    state_file = os.environ.get("STATE_FILE", "").strip()
    task_id = os.environ.get("TASK_ID", "").strip()
    if not state_file or not task_id:
        return 0

    path = Path(state_file)
    data = load_state(path)
    record = data.get("currentTask")
    if not isinstance(record, dict) or record.get("id") != task_id:
        last = data.get("lastTask")
        if isinstance(last, dict) and last.get("id") == task_id:
          record = dict(last)
        else:
            now = utc_now()
            record = {
                "id": task_id,
                "strategy": os.environ.get("TASK_STRATEGY", "device-package"),
                "owner": os.environ.get("TASK_OWNER", "runtime"),
                "status": "queued",
                "stage": "queued",
                "message": "",
                "targetVersion": "",
                "warning": "",
                "error": "",
                "logPath": "",
                "rollbackMessage": "",
                "healthcheckUrl": "",
                "heartbeatAt": now,
                "startedAt": now,
                "finishedAt": None,
            }
    else:
        record = dict(record)

    record["strategy"] = os.environ.get("TASK_STRATEGY", record.get("strategy", "device-package"))
    record["owner"] = os.environ.get("TASK_OWNER", record.get("owner", "runtime"))
    record["status"] = os.environ.get("TASK_STATUS", record.get("status", "running"))
    record["stage"] = os.environ.get("TASK_STAGE", record.get("stage", "installing"))
    record["message"] = os.environ.get("TASK_MESSAGE", record.get("message", ""))
    record["targetVersion"] = os.environ.get("TARGET_VERSION", record.get("targetVersion", ""))
    record["warning"] = os.environ.get("TASK_WARNING", record.get("warning", ""))
    record["error"] = os.environ.get("TASK_ERROR", record.get("error", ""))
    record["rollbackMessage"] = os.environ.get("TASK_ROLLBACK_MESSAGE", record.get("rollbackMessage", ""))
    record["logPath"] = os.environ.get("LOG_PATH", record.get("logPath", ""))
    record["healthcheckUrl"] = os.environ.get("HEALTHCHECK_URL", record.get("healthcheckUrl", ""))
    record["heartbeatAt"] = utc_now()

    action = os.environ.get("TASK_ACTION", "patch")
    if action == "finish":
        record["finishedAt"] = utc_now()
        data["currentTask"] = None
        data["lastTask"] = record
    else:
        record["finishedAt"] = None
        data["currentTask"] = record

    app_user = os.environ.get("APP_USER", "").strip()
    pw_record = None
    if app_user:
        try:
            pw_record = pwd.getpwnam(app_user)
        except KeyError:
            pw_record = None

    path.parent.mkdir(parents=True, exist_ok=True)
    if pw_record is not None:
        os.chown(path.parent, pw_record.pw_uid, pw_record.pw_gid)
    os.chmod(path.parent, 0o775)

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
        tmp_path = Path(handle.name)

    tmp_path.replace(path)
    if pw_record is not None:
        os.chown(path, pw_record.pw_uid, pw_record.pw_gid)
    os.chmod(path, 0o664)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
