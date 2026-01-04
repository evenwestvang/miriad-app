/**
 * Tests for Tymbal frame helpers
 */

import { describe, it, expect } from "vitest";
import { tymbal, createMessageHandle, generateMessageId } from "@cikada/core/tymbal";

describe("tymbal", () => {
  describe("start", () => {
    it("should create a start frame with id", () => {
      const frame = tymbal.start("msg-123");
      const parsed = JSON.parse(frame);

      expect(parsed.i).toBe("msg-123");
      expect(parsed.m).toBeUndefined();
    });

    it("should include metadata if provided", () => {
      const frame = tymbal.start("msg-123", { type: "assistant", sender: "fox" });
      const parsed = JSON.parse(frame);

      expect(parsed.i).toBe("msg-123");
      expect(parsed.m).toEqual({ type: "assistant", sender: "fox" });
    });
  });

  describe("append", () => {
    it("should create an append frame", () => {
      const frame = tymbal.append("msg-123", "Hello ");
      const parsed = JSON.parse(frame);

      expect(parsed.i).toBe("msg-123");
      expect(parsed.a).toBe("Hello ");
    });
  });

  describe("set", () => {
    it("should create a set frame with value", () => {
      const frame = tymbal.set("msg-123", { type: "text", content: "Hello world" });
      const parsed = JSON.parse(frame);

      expect(parsed.i).toBe("msg-123");
      expect(parsed.v).toEqual({ type: "text", content: "Hello world" });
      expect(parsed.t).toBeDefined(); // timestamp
    });
  });

  describe("delete", () => {
    it("should create a delete frame", () => {
      const frame = tymbal.delete("msg-123");
      const parsed = JSON.parse(frame);

      expect(parsed.i).toBe("msg-123");
      expect(parsed.v).toBeNull();
      // Note: delete frames don't include timestamp (unlike set)
    });
  });
});

describe("createMessageHandle", () => {
  it("should create a message handle with stream/set methods", async () => {
    const frames: string[] = [];
    const broadcast = async (frame: string) => {
      frames.push(frame);
    };

    const handle = createMessageHandle({
      id: "msg-handle",
      broadcast,
      metadata: { type: "test" },
    });

    // stream() sends start frame on first call, then append frames
    await handle.stream("Hello ");
    await handle.stream("world!");
    await handle.set({ finalValue: true });

    expect(frames.length).toBe(4);

    // Check start frame (sent automatically on first stream())
    const startFrame = JSON.parse(frames[0]);
    expect(startFrame.i).toBe("msg-handle");
    expect(startFrame.m).toEqual({ type: "test" });

    // Check append frames
    const append1 = JSON.parse(frames[1]);
    expect(append1.a).toBe("Hello ");

    const append2 = JSON.parse(frames[2]);
    expect(append2.a).toBe("world!");

    // Check set frame (metadata merged with content and finalValue)
    const setFrame = JSON.parse(frames[3]);
    expect(setFrame.v.type).toBe("test");
    expect(setFrame.v.content).toBe("Hello world!");
    expect(setFrame.v.finalValue).toBe(true);
  });

  it("should handle direct set without streaming", async () => {
    const frames: string[] = [];
    const broadcast = async (frame: string) => {
      frames.push(frame);
    };

    const handle = createMessageHandle({
      id: "direct-msg",
      broadcast,
    });

    // set() without prior stream() sends set directly
    await handle.set({ content: "Direct message" });

    expect(frames.length).toBe(1);
    const setFrame = JSON.parse(frames[0]);
    expect(setFrame.i).toBe("direct-msg");
    expect(setFrame.v).toEqual({ content: "Direct message" });
  });
});

describe("generateMessageId", () => {
  it("should generate unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateMessageId());
    }
    expect(ids.size).toBe(100);
  });

  it("should generate ULID-like strings", () => {
    const id = generateMessageId();
    // ULIDs are 26 characters, uppercase alphanumeric
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
  });
});
