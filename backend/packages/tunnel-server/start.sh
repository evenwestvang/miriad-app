#!/bin/sh
# Startup script for cast-tunnel-server
# Runs both the Hono proxy and rathole server

set -e

CONFIG_FILE="${RATHOLE_CONFIG_DIR:-/etc/rathole}/server.toml"

echo "[startup] Starting cast-tunnel-server"
echo "[startup] Hono proxy on port ${PORT:-8080}"
echo "[startup] Rathole control port ${RATHOLE_CONTROL_PORT:-2333}"

# Start Hono proxy first - it initializes the config file
echo "[startup] Starting Hono proxy..."
node /app/dist/index.js &
HONO_PID=$!

# Wait for config file to be created
echo "[startup] Waiting for config file..."
timeout=30
while [ ! -f "$CONFIG_FILE" ] && [ $timeout -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if [ ! -f "$CONFIG_FILE" ]; then
    echo "[startup] ERROR: Config file not created after 30 seconds"
    exit 1
fi

echo "[startup] Config file ready at $CONFIG_FILE"

# Start rathole server
echo "[startup] Starting rathole server..."
rathole --server "$CONFIG_FILE" &
RATHOLE_PID=$!

echo "[startup] Both services started"
echo "[startup] Hono PID: $HONO_PID"
echo "[startup] Rathole PID: $RATHOLE_PID"

# Handle shutdown
cleanup() {
    echo "[startup] Shutting down..."
    kill $HONO_PID $RATHOLE_PID 2>/dev/null || true
    wait
    echo "[startup] Shutdown complete"
}

trap cleanup SIGTERM SIGINT

# Wait for either process to exit
wait -n $HONO_PID $RATHOLE_PID

# If one exits, shut down the other
echo "[startup] A process exited, shutting down..."
cleanup
exit 1
