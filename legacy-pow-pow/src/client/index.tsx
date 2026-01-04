import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import {
  listChannels,
  sendMessage,
  subscribeToChannel,
} from "./api.js";
import { Channel, Message } from "../shared/types.js";

type Screen = "channels" | "name" | "chat";

interface AppState {
  screen: Screen;
  channels: Channel[];
  currentChannel: string | null;
  userName: string;
  messages: Message[];
  error: string | null;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function highlightMentions(content: string, userName: string): React.ReactNode {
  const parts = content.split(/(@[\w-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const isSelf = part.slice(1).toLowerCase() === userName.toLowerCase();
      return (
        <Text key={i} color={isSelf ? "yellow" : "cyan"} bold={isSelf}>
          {part}
        </Text>
      );
    }
    return part;
  });
}

function ChannelListScreen({
  channels,
  onSelect,
  onRefresh,
}: {
  channels: Channel[];
  onSelect: (name: string) => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [newChannel, setNewChannel] = useState("");
  const [creating, setCreating] = useState(false);

  useInput((input, key) => {
    if (creating) {
      if (key.return && newChannel.trim()) {
        onSelect(newChannel.trim());
        setNewChannel("");
        setCreating(false);
      } else if (key.escape) {
        setCreating(false);
        setNewChannel("");
      }
      return;
    }

    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow) {
      setSelected((s) => Math.min(channels.length, s + 1));
    } else if (key.return) {
      if (selected === channels.length) {
        setCreating(true);
      } else if (channels[selected]) {
        onSelect(channels[selected].name);
      }
    } else if (input === "r") {
      onRefresh();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="green">
          PowPow - Select a Channel
        </Text>
      </Box>

      {channels.length === 0 ? (
        <Text color="gray">No channels yet. Create one to get started.</Text>
      ) : (
        channels.map((channel, i) => (
          <Box key={channel.name}>
            <Text color={selected === i ? "green" : undefined}>
              {selected === i ? "❯ " : "  "}
              #{channel.name}
            </Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        {creating ? (
          <Box>
            <Text color="green">❯ New channel: </Text>
            <TextInput value={newChannel} onChange={setNewChannel} />
          </Box>
        ) : (
          <Text color={selected === channels.length ? "green" : "gray"}>
            {selected === channels.length ? "❯ " : "  "}+ Create new channel
          </Text>
        )}
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray">↑↓ Navigate | Enter Select | r Refresh | Esc Quit</Text>
      </Box>
    </Box>
  );
}

function NameScreen({
  channelName,
  onSubmit,
  onBack,
}: {
  channelName: string;
  onSubmit: (name: string) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState("");

  useInput((_, key) => {
    if (key.escape) {
      onBack();
    } else if (key.return && name.trim()) {
      onSubmit(name.trim());
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="green">
          Join #{channelName}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="green">Your name: </Text>
        <TextInput value={name} onChange={setName} />
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray">Enter Confirm | Esc Back</Text>
      </Box>
    </Box>
  );
}

function ChatScreen({
  channelName,
  userName,
  messages,
  onSend,
  onLeave,
}: {
  channelName: string;
  userName: string;
  messages: Message[];
  onSend: (content: string) => void;
  onLeave: () => void;
}) {
  const [input, setInput] = useState("");

  useInput((_, key) => {
    if (key.escape) {
      onLeave();
    }
  });

  const handleSubmit = (value: string) => {
    if (value.trim()) {
      onSend(value.trim());
      setInput("");
    }
  };

  // Show last 15 messages
  const recentMessages = messages.slice(-15);

  return (
    <Box flexDirection="column" height={process.stdout.rows - 2}>
      {/* Header */}
      <Box
        borderStyle="single"
        borderColor="green"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text bold color="green">
          #{channelName}
        </Text>
        <Text color="gray">
          as {userName}
        </Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {recentMessages.length === 0 ? (
          <Text color="gray">No messages yet. Start the conversation!</Text>
        ) : (
          recentMessages.map((msg) => (
            <Box key={msg.id} marginY={0}>
              <Text>
                <Text color="gray">{formatTime(msg.timestamp)} </Text>
                <Text
                  bold
                  color={msg.sender === userName ? "green" : "blue"}
                >
                  {msg.sender}
                </Text>
                <Text>: </Text>
                {highlightMentions(msg.content, userName)}
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="green">{userName}: </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a message... (Esc to leave)"
        />
      </Box>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>({
    screen: "channels",
    channels: [],
    currentChannel: null,
    userName: "",
    messages: [],
    error: null,
  });

  const [unsubscribe, setUnsubscribe] = useState<(() => void) | null>(null);

  // Fetch channels on mount and when returning to channel list
  const refreshChannels = useCallback(async () => {
    try {
      const channels = await listChannels();
      setState((s) => ({ ...s, channels, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, error: String(e) }));
    }
  }, []);

  useEffect(() => {
    refreshChannels();
  }, [refreshChannels]);

  // Handle quit
  useInput((_, key) => {
    if (key.escape && state.screen === "channels") {
      exit();
    }
  });

  // Select channel
  const handleSelectChannel = (name: string) => {
    setState((s) => ({ ...s, currentChannel: name, screen: "name" }));
  };

  // Enter chat with name
  const handleEnterChat = (name: string) => {
    if (!state.currentChannel) return;

    setState((s) => ({
      ...s,
      userName: name,
      screen: "chat",
      error: null,
    }));

    // Subscribe to updates
    const unsub = subscribeToChannel(state.currentChannel, {
      onMessages: (messages) => setState((s) => ({ ...s, messages })),
      onError: (error) => setState((s) => ({ ...s, error: error.message })),
    });
    setUnsubscribe(() => unsub);
  };

  // Send message
  const handleSend = async (content: string) => {
    if (!state.currentChannel || !state.userName) return;
    try {
      await sendMessage(state.currentChannel, state.userName, content);
    } catch (e) {
      setState((s) => ({ ...s, error: String(e) }));
    }
  };

  // Leave channel
  const handleLeave = () => {
    if (unsubscribe) {
      unsubscribe();
      setUnsubscribe(null);
    }
    setState((s) => ({
      ...s,
      screen: "channels",
      currentChannel: null,
      userName: "",
      messages: [],
    }));
    refreshChannels();
  };

  // Go back from name screen
  const handleBack = () => {
    setState((s) => ({ ...s, screen: "channels", currentChannel: null }));
  };

  // Error display
  if (state.error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {state.error}</Text>
        <Text color="gray">Press any key to continue...</Text>
      </Box>
    );
  }

  switch (state.screen) {
    case "channels":
      return (
        <ChannelListScreen
          channels={state.channels}
          onSelect={handleSelectChannel}
          onRefresh={refreshChannels}
        />
      );
    case "name":
      return (
        <NameScreen
          channelName={state.currentChannel!}
          onSubmit={handleEnterChat}
          onBack={handleBack}
        />
      );
    case "chat":
      return (
        <ChatScreen
          channelName={state.currentChannel!}
          userName={state.userName}
          messages={state.messages}
          onSend={handleSend}
          onLeave={handleLeave}
        />
      );
  }
}

// Check server and start
async function main() {
  try {
    await listChannels();
  } catch {
    console.error("Error: Cannot connect to server at http://localhost:3131");
    console.error("Start the server first with: npm run server");
    process.exit(1);
  }

  render(<App />);
}

main();
