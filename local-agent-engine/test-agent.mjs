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
    console.log('[Agent] Has systemPrompt:', msg.systemPrompt ? 'yes (' + msg.systemPrompt.length + ' chars)' : 'no');
    ws.close();
    process.exit(0);
  } else if (msg.type === 'error') {
    console.log('[Agent] Error:', msg.code, msg.message);
    ws.close();
    process.exit(1);
  }
});

ws.on('close', () => process.exit(0));
ws.on('error', (e) => { console.log('[Agent] WS Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('[Agent] Timeout - no message received'); process.exit(0); }, 20000);
