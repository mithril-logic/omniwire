#!/usr/bin/env bash
# Clobber-watch — checks all 3 mesh nodes for *.clobbered.* artifacts
# created since the SOAK_SINCE timestamp. Exits 0 if clean, 1 if any
# clobbers found. Soak window starts 2026-05-04 07:13 UTC (sync unfreeze
# after Wave 1 + manifest trim deploy).

set -u

SOAK_SINCE_UTC="2026-05-04T07:13:00Z"
SOAK_SINCE_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$SOAK_SINCE_UTC" "+%s" 2>/dev/null || date -d "$SOAK_SINCE_UTC" "+%s")

count_clobbers_since() {
  local host="$1"
  local cmd='find ~/.openclaw -maxdepth 1 -name "*.clobbered.*" -type f 2>/dev/null | while read f; do mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"); if [ "$mtime" -gt '"$SOAK_SINCE_EPOCH"' ]; then echo "$f"; fi; done | wc -l'
  if [ "$host" = "macbook" ]; then
    eval "$cmd"
  else
    ssh "$host" "$cmd"
  fi
}

echo "=== clobber-watch — soak since $SOAK_SINCE_UTC ==="
total=0
for host in macbook rei wsl; do
  c=$(count_clobbers_since "$host" 2>/dev/null || echo 0)
  echo "  $host: $c new clobbers"
  total=$((total + c))
done

echo ""
echo "=== sync daemon health ==="
for host in rei wsl; do
  state=$(ssh "$host" 'XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user is-active omniwire-sync.service' 2>/dev/null || echo "unreachable")
  echo "  $host: $state"
done
mac_pid=$(launchctl list | awk '/com\.omniwire\.sync$/ {print $1}')
if [ -n "$mac_pid" ] && [ "$mac_pid" != "-" ]; then
  echo "  macbook: active (pid $mac_pid)"
else
  echo "  macbook: inactive"
fi

echo ""
if [ "$total" -eq 0 ]; then
  echo "VERDICT: clean — $total new clobber artifacts since soak start"
  exit 0
else
  echo "VERDICT: REGRESSION — $total new clobber artifacts; investigate immediately"
  exit 1
fi
