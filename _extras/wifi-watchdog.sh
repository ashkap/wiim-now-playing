#!/bin/bash
# ===========================================================================
# wifi-watchdog.sh — keep the WNP kiosk online despite flaky WiFi
#
# Pings the gateway on an interval. After a sustained outage it restarts the
# WiFi connection, and if that still doesn't recover it reboots the Pi as a
# last resort. Meant to run as a systemd service (see wifi-watchdog.service)
# so it runs system-wide, independent of the graphical/kiosk session.
#
# All thresholds are overridable via the environment / the service unit.
# ===========================================================================
set -u

GATEWAY="${GATEWAY:-192.168.40.1}"                 # Router/gateway to ping
IFACE="${IFACE:-wlan0}"                            # WiFi interface
CONN="${CONN:-netplan-wlan0-SDA_SONOS}"            # NetworkManager connection name
CHECK_SECS="${CHECK_SECS:-30}"                     # Seconds between checks
FAILS_TO_RESTART="${FAILS_TO_RESTART:-4}"          # ~2 min down  -> restart WiFi
FAILS_TO_REBOOT="${FAILS_TO_REBOOT:-12}"           # ~6 min down  -> reboot

# Use sudo only when not already root, so this works both as a root service
# and when run by hand as a normal user with passwordless sudo.
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') wifi-watchdog: $*"; }

restart_wifi() {
    log "restarting WiFi ($IFACE / $CONN)"
    $SUDO nmcli device disconnect "$IFACE" >/dev/null 2>&1
    sleep 3
    $SUDO nmcli connection up "$CONN" >/dev/null 2>&1 \
        || $SUDO nmcli device connect "$IFACE" >/dev/null 2>&1
}

log "started (gateway=$GATEWAY iface=$IFACE conn=$CONN interval=${CHECK_SECS}s, restart@${FAILS_TO_RESTART} reboot@${FAILS_TO_REBOOT})"

fails=0
while true; do
    if ping -c1 -W3 "$GATEWAY" >/dev/null 2>&1; then
        if [ "$fails" -gt 0 ]; then log "network recovered after $fails failed check(s)"; fi
        fails=0
    else
        fails=$((fails + 1))
        log "gateway $GATEWAY unreachable (consecutive failures: $fails)"
        if [ "$fails" -ge "$FAILS_TO_REBOOT" ]; then
            log "still down after $fails checks — rebooting as a last resort"
            $SUDO systemctl reboot
            sleep 120   # give the reboot time to take effect
        elif [ $((fails % FAILS_TO_RESTART)) -eq 0 ]; then
            restart_wifi
        fi
    fi
    sleep "$CHECK_SECS"
done
