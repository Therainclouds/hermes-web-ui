# Restores executable bits on deployed scripts after extraction from a tarball.
#
# WHY THIS EXISTS
#   Three independent failure modes can leave scripts non-executable on the device:
#     1. The git tree itself lacks +x (Windows checkout + core.filemode=false).
#     2. The device-package tarball was built on a host that lost +x (tar
#        `portable: true` preserves source mode, so a 0644 source = 0644 archive).
#     3. `tar -cf - . | tar -xf -` through a FIFO silently normalises modes
#        depending on umask and --no-same-permissions interactions.
#   Any one of these produces systemd `203/EXEC` on ExecStartPre the moment the
#   service is restarted. This library is the defensive "last mile" that
#   guarantees a successful deploy regardless of upstream state.
#
# USAGE (from install-device-package.sh, update-source-deploy.sh, or any
# deploy-adjacent script that syncs a fresh source tree into DEPLOY_DIR):
#
#   # After sync_package_tree / sync_source_tree has populated ${DEPLOY_DIR}:
#   source "${SCRIPT_DIR}/_lib/fixup-script-modes.sh"
#   fixup_script_modes "${DEPLOY_DIR}"
#
# This file is meant to be sourced, NOT executed directly. It defines the
# `fixup_script_modes` function and returns without side effects.

fixup_script_modes() {
  local target="${1:-}"
  if [[ -z "${target}" ]]; then
    echo "[fixup-script-modes] usage: fixup_script_modes <deploy-dir>" >&2
    return 1
  fi
  if [[ ! -d "${target}" ]]; then
    echo "[fixup-script-modes] target ${target} does not exist; skipping"
    return 0
  fi
  local scripts_dir="${target}/scripts"
  if [[ ! -d "${scripts_dir}" ]]; then
    echo "[fixup-script-modes] ${scripts_dir} missing; skipping"
    return 0
  fi

  local -a fixed=()

  # All .sh files under scripts/. Recursive because subdirs may contain helper scripts.
  while IFS= read -r -d '' f; do
    if [[ ! -x "$f" ]]; then
      chmod 0755 "$f"
      fixed+=("$(basename "$f")")
    fi
  done < <(find "${scripts_dir}" -type f -name '*.sh' -print0 2>/dev/null)

  # Python files under scripts/ that carry a shebang (i.e. are meant to be invoked directly).
  while IFS= read -r -d '' f; do
    if [[ ! -x "$f" ]] && head -1 "$f" 2>/dev/null | grep -q '^#!.*python'; then
      chmod 0755 "$f"
      fixed+=("$(basename "$f")")
    fi
  done < <(find "${scripts_dir}" -type f -name '*.py' -print0 2>/dev/null)

  if [[ ${#fixed[@]} -gt 0 ]]; then
    # Sort and dedupe for deterministic output in logs.
    local -a sorted=()
    while IFS= read -r n; do sorted+=("$n"); done < <(printf '%s\n' "${fixed[@]}" | sort -u)
    echo "[fixup-script-modes] restored +x on ${#sorted[@]} script(s) in ${scripts_dir}: ${sorted[*]}"
  fi
}
