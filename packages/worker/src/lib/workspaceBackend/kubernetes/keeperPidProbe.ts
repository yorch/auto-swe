export function kubernetesKeeperPidProbeScript(): string {
  return [
    'asw_self_mnt=$(readlink "/proc/$$/ns/mnt" 2>/dev/null) || exit 0',
    '[ -n "$asw_self_mnt" ] || exit 0',
    'asw_ppid() { sed -n \'s/^PPid:[[:space:]]*//p\' "/proc/$1/status" 2>/dev/null; }',
    'for asw_d in /proc/[0-9]*; do',
    `  asw_p=\${asw_d#/proc/}`,
    '  [ "$asw_p" = "$$" ] && continue',
    '  asw_mnt=$(readlink "$asw_d/ns/mnt" 2>/dev/null) || continue',
    '  [ "$asw_mnt" = "$asw_self_mnt" ] || continue',
    '  if [ "$(asw_ppid "$asw_p")" = 0 ]; then echo "$asw_p"; fi',
    'done',
  ].join('\n');
}
