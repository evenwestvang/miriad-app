export interface Channel {
  name: string;
  createdAt: string;
}

export interface Message {
  id: string;
  type: "message";
  channel: string;
  sender: string;
  timestamp: string;
  content: string;
}
