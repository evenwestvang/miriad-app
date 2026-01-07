#!/bin/bash
# Integration test for local agent - using consistent session
set -e

COOKIE_FILE="/tmp/cast-test-final.txt"
BASE_URL="http://localhost:3234"

echo "=== Step 1: Get channel list with existing session ==="
CHANNELS=$(curl -s -b "$COOKIE_FILE" "$BASE_URL/channels")
echo "Channels: $CHANNELS"

# Get first channel ID
CHANNEL_ID=$(echo "$CHANNELS" | jq -r '.channels[0].id // empty')

if [ -z "$CHANNEL_ID" ]; then
  echo "No existing channels, creating one..."
  RESULT=$(curl -s -b "$COOKIE_FILE" -X POST "$BASE_URL/channels" \
    -H "Content-Type: application/json" \
    -d '{"name": "local-agent-test"}')
  CHANNEL_ID=$(echo "$RESULT" | jq -r '.channel.id')
  echo "Created channel: $CHANNEL_ID"
else
  echo "Using existing channel: $CHANNEL_ID"
fi

echo ""
echo "=== Step 2: Start test agent in background ==="
# Create a simple test agent that just logs what it receives
node local-agent-engine/test-agent.mjs "$CHANNEL_ID" &
AGENT_PID=$!
echo "Agent PID: $AGENT_PID"

# Wait for agent to connect and register
sleep 2

echo ""
echo "=== Step 3: Send @mention message ==="
MSG_RESULT=$(curl -s -b "$COOKIE_FILE" -X POST "$BASE_URL/channels/$CHANNEL_ID/messages" \
  -H "Content-Type: application/json" \
  -d '{"sender": "tester", "content": "@test-fox hello from the integration test!"}')
echo "Message result: $MSG_RESULT"

# Wait for message to be delivered
echo ""
echo "=== Step 4: Waiting for agent to receive message... ==="
sleep 3

# Clean up
kill $AGENT_PID 2>/dev/null || true
echo ""
echo "=== Test complete ==="
