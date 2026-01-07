import WebSocket from 'ws';

const CHANNEL_ID = process.argv[2];
const CALLSIGN = 'test-fox';

console.log('[Agent] Connecting to channel:', CHANNEL_ID);

const ws = new WebSocket('ws://localhost:3234/local-agents/connect');

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[Agent] Received:', msg.type);

  if (msg.type === 'connected') {
    ws.send(JSON.stringify({
      type: 'register',
      channelId: CHANNEL_ID,
      callsign: CALLSIGN,
      workspace: '/tmp/test-workspace'
    }));
  } else if (msg.type === 'registered') {
    console.log('[Agent] Ready for messages!');
  } else if (msg.type === 'message') {
    console.log('');
    console.log('[Agent] *** MESSAGE RECEIVED ***');
    console.log('[Agent] From:', msg.sender);
    console.log('[Agent] Content:', msg.content);

    // Simulate agent response by sending frames
    const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    console.log('[Agent] Sending response frames...');

    // Send start frame - include channelId in wrapper
    ws.send(JSON.stringify({
      type: 'frame',
      channelId: CHANNEL_ID,
      frame: {
        i: messageId,
        t: Date.now(),
        v: {
          type: 'agent',
          sender: CALLSIGN,
          senderType: 'agent'
        }
      }
    }));

    // Send content append
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'frame',
        channelId: CHANNEL_ID,
        frame: {
          i: messageId,
          p: ['content'],
          a: 'Hello! I received your message: '
        }
      }));
    }, 100);

    // Append more content
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'frame',
        channelId: CHANNEL_ID,
        frame: {
          i: messageId,
          p: ['content'],
          a: '"' + msg.content + '"'
        }
      }));
    }, 200);

    // Send set frame to finalize
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'frame',
        channelId: CHANNEL_ID,
        frame: {
          i: messageId,
          t: Date.now(),
          v: {
            type: 'agent',
            sender: CALLSIGN,
            senderType: 'agent',
            content: 'Hello! I received your message: "' + msg.content + '"',
            timestamp: new Date().toISOString()
          }
        }
      }));
      console.log('[Agent] Response frames sent!');

      // Keep connection alive briefly to see if frames were processed
      setTimeout(() => {
        console.log('[Agent] Test complete, closing connection');
        ws.close();
        process.exit(0);
      }, 1000);
    }, 300);

  } else if (msg.type === 'error') {
    console.log('[Agent] Error:', msg.code, msg.message);
    ws.close();
    process.exit(1);
  }
});

ws.on('close', () => process.exit(0));
ws.on('error', (e) => { console.log('[Agent] WS Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('[Agent] Timeout - no message received'); process.exit(0); }, 30000);
