#!/bin/bash
# ===========================================================================
# screen-sleep.sh — playback-aware monitor sleep for the WNP kiosk
#
# Polls the WiiM's HTTP API for the player status. When nothing has been
# playing for IDLE_SECS, the monitor is put to sleep. As soon as playback
# resumes, the monitor is woken immediately.
#
# Works on both display stacks:
#   - Wayland (labwc, Raspberry Pi OS Trixie default): uses wlopm
#   - X11 (LXDE kiosk per the WNP docs):               uses xset
#
# Setup (on the Raspberry Pi):
#   1. Copy this file to the Pi, e.g. /home/<user>/screen-sleep.sh
#   2. chmod +x screen-sleep.sh
#   3. Launch it on session start, backgrounded. Wayland/labwc: add to
#      ~/.config/labwc/autostart. X11/LXDE: add to autostart.sh.
#        /home/<user>/screen-sleep.sh >> /home/<user>/screen-sleep.log 2>&1 &
#
# The WiiM IP is read from the WNP server's settings.json. Override with
# the WIIM_IP environment variable if you want to pin it.
# ===========================================================================

# --- Configuration ---------------------------------------------------------
IDLE_SECS="${IDLE_SECS:-300}"           # Sleep after this many seconds idle (default 5 min)
POLL_SECS="${POLL_SECS:-5}"             # How often to poll the WiiM
WNP_DIR="${WNP_DIR:-$HOME/wiim-now-playing}" # Path to the wiim-now-playing checkout

# --- Display stack detection & screen control ------------------------------
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -z "$WAYLAND_DISPLAY" ] && [ -S "$XDG_RUNTIME_DIR/wayland-0" ]; then
    export WAYLAND_DISPLAY="wayland-0"
fi

if [ -n "$WAYLAND_DISPLAY" ] && command -v wlopm >/dev/null; then
    STACK="wayland"
    screen_off() { wlopm --off '*'; }
    screen_wake() { wlopm --on '*'; }
elif command -v xset >/dev/null; then
    STACK="x11"
    export DISPLAY="${DISPLAY:-:0}"
    # Let the screensaver leave the screen alone; only this script manages power.
    xset s off
    xset s noblank
    xset +dpms
    xset dpms 0 0 0   # disable DPMS timers; we use 'dpms force' explicitly
    screen_off() { xset dpms force off; }
    screen_wake() { xset dpms force on; }
else
    echo "WNP screen-sleep: neither wlopm (Wayland) nor xset (X11) available, exiting"
    exit 1
fi

# --- Resolve the WiiM IP address -------------------------------------------
get_wiim_ip() {
    if [ -n "$WIIM_IP" ]; then
        echo "$WIIM_IP"
        return
    fi
    # Extract "location":"http://<ip>:port/..." from the WNP settings file.
    for f in "$WNP_DIR/data/settings.json" "$WNP_DIR/server/settings.json"; do
        if [ -f "$f" ]; then
            sed -n 's#.*"location":"[a-z]*://\([0-9.]*\)[:/].*#\1#p' "$f" | head -n1
            return
        fi
    done
}

# --- Query player status: prints "playing", "idle" or "unknown" ------------
player_state() {
    local ip="$1" status
    # WiiM answers on https with a self-signed certificate, hence -k.
    status=$(curl -sk --max-time 3 "https://$ip/httpapi.asp?command=getPlayerStatus" \
        | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    case "$status" in
        play|load) echo "playing" ;;
        stop|pause|none) echo "idle" ;;
        *) echo "unknown" ;;
    esac
}

# --- Main loop -------------------------------------------------------------
echo "WNP screen-sleep: starting on $STACK (idle=${IDLE_SECS}s, poll=${POLL_SECS}s)"

# Start from a known state: the screen may have been left off by a previous
# run, so wake it explicitly rather than assuming it is on.
screen_wake
idle_for=0
screen_on=1

while true; do
    ip=$(get_wiim_ip)
    if [ -z "$ip" ]; then
        echo "WNP screen-sleep: no WiiM IP found (yet), retrying..."
        sleep 10
        continue
    fi

    state=$(player_state "$ip")

    if [ "$state" = "playing" ]; then
        idle_for=0
        if [ "$screen_on" -eq 0 ]; then
            echo "WNP screen-sleep: playback detected, waking screen"
            screen_wake
            screen_on=1
        fi
    elif [ "$state" = "idle" ]; then
        idle_for=$((idle_for + POLL_SECS))
        if [ "$screen_on" -eq 1 ] && [ "$idle_for" -ge "$IDLE_SECS" ]; then
            echo "WNP screen-sleep: idle for ${idle_for}s, screen off"
            screen_off
            screen_on=0
        fi
    fi
    # "unknown" (device unreachable): keep current screen state, don't count
    # towards idle, so a network blip never blanks the screen mid-song.

    sleep "$POLL_SECS"
done
