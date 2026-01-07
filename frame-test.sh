#!/bin/bash
# Test frame delivery from local agent
COOKIE_FILE="/tmp/cast-test-final.txt"
BASE_URL="http://localhost:3234"
CHANNEL_ID="01KECWF4AEMAA2AE7VPSXDHP4G"

echo "=== Starting agent with frame support ==="
node local-agent-engine/test-agent-with-frames.mjs "$CHANNEL_ID" &
AGENT_PID=$!
echo "Agent PID: $AGENT_PID"

# Wait for agent to connect
sleep 2

echo ""
echo "=== Sending @mention message ==="
curl -s -b "$COOKIE_FILE" -X POST "$BASE_URL/channels/$CHANNEL_ID/messages" \
  -H "Content-Type: application/json" \
  -d '{"sender": "tester", "content": "@test-fox please respond with frames!"}' | jq .

echo ""
echo "=== Waiting for agent to process and send frames... ==="
sleep 3

echo ""
echo "=== Checking messages in channel ==="
curl -s -b "$COOKIE_FILE" "$BASE_URL/channels/$CHANNEL_ID/messages?limit=5" | jq '.messages | .[] | {sender, content, type}'

# Agent should have exited by now
wait $AGENT_PID 2>/dev/null || true
echo ""
echo "=== Test complete ==="
