#!/bin/bash
# Test agent disconnect cleanup
COOKIE_FILE="/tmp/cast-test-final.txt"
BASE_URL="http://localhost:3234"
CHANNEL_ID="01KECWF4AEMAA2AE7VPSXDHP4G"

echo "=== Step 1: Check roster before agent connects ==="
curl -s -b "$COOKIE_FILE" "$BASE_URL/channels/$CHANNEL_ID/roster" | jq '.roster[] | {callsign, status}'

echo ""
echo "=== Step 2: Connect agent and check roster ==="
# Start agent in background
node local-agent-engine/test-agent.mjs "$CHANNEL_ID" &
AGENT_PID=$!
sleep 2

echo "Roster after connection:"
curl -s -b "$COOKIE_FILE" "$BASE_URL/channels/$CHANNEL_ID/roster" | jq '.roster[] | {callsign, status}'

echo ""
echo "=== Step 3: Kill agent and check roster cleanup ==="
kill $AGENT_PID 2>/dev/null
sleep 1

echo "Roster after disconnect:"
curl -s -b "$COOKIE_FILE" "$BASE_URL/channels/$CHANNEL_ID/roster" | jq '.roster[] | {callsign, status}'

echo ""
echo "=== Test complete ==="
