import { describe, it, expect } from "vitest";
import { parse, prefixNick, format, IRCMessage } from "./parser";

describe("prefixNick", () => {
  it("extracts nick from full prefix", () => {
    expect(prefixNick("nick!user@host")).toBe("nick");
  });

  it("returns prefix as-is when no bang", () => {
    expect(prefixNick("irc.freeq.at")).toBe("irc.freeq.at");
  });

  it("returns empty string for empty prefix", () => {
    expect(prefixNick("")).toBe("");
  });
});

describe("parse", () => {
  it("parses a simple PRIVMSG", () => {
    const msg = parse(":alice!u@h PRIVMSG #general :Hello world\r\n");
    expect(msg.prefix).toBe("alice!u@h");
    expect(msg.command).toBe("PRIVMSG");
    expect(msg.params).toEqual(["#general", "Hello world"]);
    expect(msg.tags).toEqual({});
  });

  it("parses a numeric reply (001)", () => {
    const msg = parse(":irc.freeq.at 001 testnick :Welcome to FreeQ\r\n");
    expect(msg.prefix).toBe("irc.freeq.at");
    expect(msg.command).toBe("001");
    expect(msg.params).toEqual(["testnick", "Welcome to FreeQ"]);
  });

  it("parses tags correctly", () => {
    const msg = parse(
      "@msgid=abc123;time=2024-01-01T00:00:00.000Z :irc.freeq.at 001 testnick :Welcome\r\n"
    );
    expect(msg.tags).toEqual({
      msgid: "abc123",
      time: "2024-01-01T00:00:00.000Z",
    });
    expect(msg.command).toBe("001");
  });

  it("handles tag value escaping", () => {
    const msg = parse("@text=hello\\sworld\\:test :server CMD arg\r\n");
    expect(msg.tags["text"]).toBe("hello world;test");
  });

  it("handles tag without value (boolean)", () => {
    const msg = parse("@batch :server CMD arg\r\n");
    expect(msg.tags["batch"]).toBe("");
  });

  it("handles no prefix", () => {
    const msg = parse("PING :irc.freeq.at\r\n");
    expect(msg.prefix).toBe("");
    expect(msg.command).toBe("PING");
    expect(msg.params).toEqual(["irc.freeq.at"]);
  });

  it("handles empty params after command", () => {
    const msg = parse("PING\r\n");
    expect(msg.command).toBe("PING");
    expect(msg.params).toEqual([]);
  });

  it("handles trailing colon param with spaces", () => {
    const msg = parse(":server 332 testnick #topic :This is a topic\r\n");
    expect(msg.params).toEqual(["testnick", "#topic", "This is a topic"]);
  });
});

describe("format", () => {
  it("formats a simple command", () => {
    expect(format("PING", ["irc.freeq.at"])).toBe("PING irc.freeq.at");
  });

  it("adds trailing colon for param with spaces", () => {
    expect(format("PRIVMSG", ["#general", "Hello world"])).toBe(
      "PRIVMSG #general :Hello world"
    );
  });

  it("adds trailing colon for param starting with colon", () => {
    expect(format("PRIVMSG", ["#general", ":smile:"])).toBe(
      "PRIVMSG #general ::smile:"
    );
  });

  it("formats with tags", () => {
    expect(format("TAGMSG", ["#general"], { label: "abc" })).toBe(
      "@label=abc TAGMSG #general"
    );
  });

  it("escapes tag values when formatting", () => {
    expect(format("CMD", ["arg"], { text: "hello world;test" })).toBe(
      "@text=hello\\sworld\\:test CMD arg"
    );
  });
});
