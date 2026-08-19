import { describe, expect, it } from "vitest";
import {
  AUDIO_SAMPLE_RATE,
  createAgentConfig,
  SYSTEM_PROMPT,
} from "../src/agent/agent-config.js";
import { ALLOWED_TOOLS } from "../src/agent/tool-policy.js";

describe("createAgentConfig", () => {
  it("produces a Settings message pinned to linear16 / 8000 Hz on both sides", () => {
    const settings = createAgentConfig();
    expect(settings.type).toBe("Settings");
    expect(AUDIO_SAMPLE_RATE).toBe(8000);
    expect(settings.audio.input).toEqual({ encoding: "linear16", sample_rate: 8000 });
    expect(settings.audio.output).toEqual({
      encoding: "linear16",
      sample_rate: 8000,
      container: "none",
    });
  });

  it("uses the exact bounded system prompt as think.prompt", () => {
    const settings = createAgentConfig();
    expect(settings.agent.think.prompt).toBe(SYSTEM_PROMPT);
    // Spot-check the constraints that make it bounded rather than open-ended.
    expect(SYSTEM_PROMPT).toContain("You may ONLY help the caller check the status of an order.");
    expect(SYSTEM_PROMPT).toContain("Call getOrderStatus exactly once");
    expect(SYSTEM_PROMPT).toContain("Do not retry.");
  });

  it("registers exactly one function, and it is the allowlisted tool", () => {
    const settings = createAgentConfig();
    const functions = settings.agent.think.functions;
    expect(functions).toHaveLength(1);
    expect(functions[0]?.name).toBe(ALLOWED_TOOLS[0]);
    expect(functions[0]?.name).toBe("getOrderStatus");
  });

  it("declares getOrderStatus with a required string orderId parameter", () => {
    const fn = createAgentConfig().agent.think.functions[0]!;
    expect(fn.parameters.type).toBe("object");
    expect(fn.parameters.required).toEqual(["orderId"]);
    expect(fn.parameters.properties.orderId?.type).toBe("string");
  });

  it("declares the function client-side (no endpoint field)", () => {
    const fn = createAgentConfig().agent.think.functions[0]!;
    // Client-side execution ⇒ the app runs it and enforces the policy; no endpoint.
    expect(fn).not.toHaveProperty("endpoint");
    expect(fn).not.toHaveProperty("url");
  });

  it("defaults think to an Anthropic Claude provider", () => {
    const settings = createAgentConfig();
    expect(settings.agent.think.provider.type).toBe("anthropic");
    expect(settings.agent.think.provider.model).toMatch(/^claude-/);
  });

  it("allows model overrides without touching the bounded parts", () => {
    const settings = createAgentConfig({
      speakModel: "aura-2-asteria-en",
      thinkProvider: { type: "anthropic", model: "claude-4-5-haiku" },
    });
    expect(settings.agent.speak.provider.model).toBe("aura-2-asteria-en");
    expect(settings.agent.think.provider.model).toBe("claude-4-5-haiku");
    // Prompt and function set stay fixed regardless of overrides.
    expect(settings.agent.think.prompt).toBe(SYSTEM_PROMPT);
    expect(settings.agent.think.functions).toHaveLength(1);
  });
});
