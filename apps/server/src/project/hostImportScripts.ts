export const HOST_IMPORT_FINDINGS_START_MARKER = "__T3CODE_HOST_IMPORT_FINDINGS_START__";
export const HOST_IMPORT_FINDINGS_END_MARKER = "__T3CODE_HOST_IMPORT_FINDINGS_END__";
export const HOST_IMPORT_NEEDS_SUDO_MARKER = "__T3CODE_HOST_IMPORT_NEEDS_SUDO__";
export const HOST_IMPORT_SUDO_PROMPT = "T3CODE_SUDO_PASSWORD:";

export const HOST_IMPORT_REMOTE_SCRIPT_NAME = "host-import-remote.sh";
export const HOST_IMPORT_RUNNER_SCRIPT_NAME = "host-import-runner.sh";

export const HOST_IMPORT_REMOTE_SCRIPT = `#!/bin/sh
set -eu

FINDINGS_START="${HOST_IMPORT_FINDINGS_START_MARKER}"
FINDINGS_END="${HOST_IMPORT_FINDINGS_END_MARKER}"
NEEDS_SUDO="${HOST_IMPORT_NEEDS_SUDO_MARKER}"

phase="\${1:-discover}"

capture_shell() {
  sh -lc "$1" 2>/dev/null || true
}

print_block() {
  title="$1"
  content="$2"
  if [ -z "$content" ]; then
    return
  fi
  printf '\\n## %s\\n\\n\`\`\`text\\n%s\\n\`\`\`\\n' "$title" "$content"
}

print_partial_findings() {
  host_name="$(capture_shell 'hostname 2>/dev/null || uname -n 2>/dev/null || true')"
  current_user="$(capture_shell 'whoami 2>/dev/null || id -un 2>/dev/null || true')"
  kernel="$(capture_shell 'uname -a 2>/dev/null || true')"
  os_release="$(capture_shell 'cat /etc/os-release 2>/dev/null | head -n 40')"
  network="$(capture_shell 'ip -brief address 2>/dev/null || ifconfig 2>/dev/null || true' | head -n 80)"

  printf '%s\\n' "$FINDINGS_START"
  printf '# Host Import Findings\\n\\n'
  printf -- '- Remote access succeeded, but privileged discovery still needs a remote sudo password.\\n'
  if [ -n "$host_name" ]; then
    printf -- '- Hostname: %s\\n' "$host_name"
  fi
  if [ -n "$current_user" ]; then
    printf -- '- Discovery user: %s\\n' "$current_user"
  fi
  if [ -n "$kernel" ]; then
    printf -- '- Kernel: %s\\n' "$kernel"
  fi
  print_block "/etc/os-release" "$os_release"
  print_block "Network interfaces" "$network"
  printf '%s\\n' "$FINDINGS_END"
}

print_full_findings() {
  host_name="$(capture_shell 'hostname 2>/dev/null || uname -n 2>/dev/null || true')"
  fqdn="$(capture_shell 'hostname -f 2>/dev/null || true')"
  current_user="$(capture_shell 'whoami 2>/dev/null || id -un 2>/dev/null || true')"
  kernel="$(capture_shell 'uname -a 2>/dev/null || true')"
  uptime_info="$(capture_shell 'uptime 2>/dev/null || true')"
  os_release="$(capture_shell 'cat /etc/os-release 2>/dev/null | head -n 40')"
  nixos_version="$(capture_shell 'nixos-version 2>/dev/null || true')"
  filesystems="$(capture_shell 'findmnt -lo TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null || mount 2>/dev/null || true' | head -n 120)"
  network="$(capture_shell 'ip -brief address 2>/dev/null || ifconfig 2>/dev/null || true' | head -n 120)"
  routes="$(capture_shell 'ip route 2>/dev/null || route -n 2>/dev/null || true' | head -n 120)"
  users="$(capture_shell "awk -F: '($3 >= 1000 && $1 != \\"nobody\\") { print $1 \\":\\" $6 \\":\\" $7 }' /etc/passwd 2>/dev/null || true" | head -n 80)"
  services="$(capture_shell 'systemctl list-unit-files --type=service --state=enabled --no-pager 2>/dev/null || true' | head -n 120)"
  timers="$(capture_shell 'systemctl list-timers --all --no-pager 2>/dev/null || true' | head -n 80)"
  listening_ports="$(capture_shell 'ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null || true' | head -n 120)"
  sshd_config="$(capture_shell 'sed -n \\"1,160p\\" /etc/ssh/sshd_config 2>/dev/null || true')"
  fstab="$(capture_shell 'sed -n \\"1,160p\\" /etc/fstab 2>/dev/null || true')"
  nixos_config="$(capture_shell 'sed -n \\"1,220p\\" /etc/nixos/configuration.nix 2>/dev/null || true')"
  network_config="$(capture_shell 'for path in /etc/network/interfaces /etc/netplan/*.yaml; do [ -f "$path" ] || continue; printf "===== %s =====\\\\n" "$path"; sed -n "1,220p" "$path"; done 2>/dev/null || true')"

  printf '%s\\n' "$FINDINGS_START"
  printf '# Host Import Findings\\n\\n'
  printf -- '- Privileged discovery completed successfully.\\n'
  if [ -n "$host_name" ]; then
    printf -- '- Hostname: %s\\n' "$host_name"
  fi
  if [ -n "$fqdn" ]; then
    printf -- '- FQDN: %s\\n' "$fqdn"
  fi
  if [ -n "$current_user" ]; then
    printf -- '- Discovery user: %s\\n' "$current_user"
  fi
  if [ -n "$kernel" ]; then
    printf -- '- Kernel: %s\\n' "$kernel"
  fi
  if [ -n "$uptime_info" ]; then
    printf -- '- Uptime: %s\\n' "$uptime_info"
  fi
  if [ -n "$nixos_version" ]; then
    printf -- '- NixOS version: %s\\n' "$nixos_version"
  fi
  print_block "/etc/os-release" "$os_release"
  print_block "Filesystems" "$filesystems"
  print_block "Network interfaces" "$network"
  print_block "Routes" "$routes"
  print_block "Regular users" "$users"
  print_block "Enabled services" "$services"
  print_block "Systemd timers" "$timers"
  print_block "Listening ports" "$listening_ports"
  print_block "/etc/ssh/sshd_config" "$sshd_config"
  print_block "/etc/fstab" "$fstab"
  print_block "Network config files" "$network_config"
  print_block "/etc/nixos/configuration.nix" "$nixos_config"
  printf '%s\\n' "$FINDINGS_END"
}

case "$phase" in
  discover)
    if [ "$(id -u)" -eq 0 ]; then
      exec sh "$0" internal-root
    fi
    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      exec sudo -n sh "$0" internal-root
    fi
    print_partial_findings
    printf '%s\\n' "$NEEDS_SUDO"
    exit 42
    ;;
  internal-root)
    print_full_findings
    exit 0
    ;;
  *)
    printf 'Unsupported host import phase: %s\\n' "$phase" >&2
    exit 64
    ;;
esac
`;

export const HOST_IMPORT_RUNNER_SCRIPT = `#!/bin/sh
set -eu

phase="\${T3CODE_HOST_IMPORT_PHASE:-}"
target="\${T3CODE_HOST_IMPORT_TARGET:-}"
remote_script="\${T3CODE_HOST_IMPORT_REMOTE_SCRIPT:-}"
remote_path="/tmp/t3code-host-import-\${USER:-user}-\${PPID}.sh"

if [ -z "$phase" ] || [ -z "$target" ] || [ -z "$remote_script" ]; then
  printf 'Missing required host import environment.\\n' >&2
  exit 64
fi

common_opts="-o StrictHostKeyChecking=yes -o UserKnownHostsFile=\${HOME}/.ssh/known_hosts -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"

case "$phase" in
  key)
    auth_opts="-o BatchMode=yes -o PreferredAuthentications=publickey"
    ;;
  ssh-password|sudo-password)
    auth_opts="-o BatchMode=no -o NumberOfPasswordPrompts=1 -o PreferredAuthentications=publickey,password"
    ;;
  *)
    printf 'Unsupported host import phase: %s\\n' "$phase" >&2
    exit 64
    ;;
esac

cleanup() {
  ssh -o BatchMode=yes $common_opts "$target" "rm -f '$remote_path'" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

printf 'Preparing secure host import for %s...\\n' "$target"
cat "$remote_script" | ssh $common_opts $auth_opts "$target" "cat > '$remote_path' && chmod 700 '$remote_path'"
printf 'Remote analysis helper uploaded to %s.\\n' "$remote_path"

if [ "$phase" = "sudo-password" ]; then
  printf 'Executing remote analysis with privileged access...\\n'
  ssh $common_opts $auth_opts -tt "$target" "sudo -S -p '${HOST_IMPORT_SUDO_PROMPT}' sh '$remote_path' internal-root"
else
  printf 'Executing remote analysis...\\n'
  ssh $common_opts $auth_opts -tt "$target" "sh '$remote_path' discover"
fi
`;
