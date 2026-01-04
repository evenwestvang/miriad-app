import { Channel, Message } from "../shared/types.js";

const BASE_URL = process.env.SERVER_URL || "http://localhost:3131";

async function apiCall<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }
  return response.json();
}

export async function listChannels(): Promise<Channel[]> {
  return apiCall<Channel[]>("GET", "/api/channels");
}

export async function sendMessage(
  channel: string,
  sender: string,
  content: string
): Promise<Message> {
  return apiCall("POST", `/api/channels/${encodeURIComponent(channel)}/messages`, {
    sender,
    content,
  });
}

export async function getMessages(channel: string, limit?: number): Promise<Message[]> {
  const query = limit ? `?limit=${limit}` : "";
  return apiCall<Message[]>(
    "GET",
    `/api/channels/${encodeURIComponent(channel)}/messages${query}`
  );
}

export interface StreamCallbacks {
  onMessages: (messages: Message[]) => void;
  onError: (error: Error) => void;
}

export function subscribeToChannel(
  channel: string,
  callbacks: StreamCallbacks
): () => void {
  const controller = new AbortController();

  const connect = async () => {
    try {
      const response = await fetch(
        `${BASE_URL}/api/channels/${encodeURIComponent(channel)}/stream`,
        { signal: controller.signal }
      );

      if (!response.ok) {
        throw new Error(`Stream error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (currentEvent === "messages") {
                callbacks.onMessages(parsed);
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        callbacks.onError(error as Error);
      }
    }
  };

  connect();

  return () => controller.abort();
}
