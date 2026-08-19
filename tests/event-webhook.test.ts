import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createEventWebhook, TERMINAL_STATUSES } from "../src/voice/event-webhook.js";

/** Minimal Express res double that records status() and end(). */
function mockRes(): Response & { statusCode: number; ended: boolean } {
  const res = {
    statusCode: 0,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; ended: boolean };
}

function mockReq(body: unknown): Request {
  return { body } as Request;
}

describe("createEventWebhook", () => {
  it("always responds 200 so Vonage does not retry", () => {
    const handler = createEventWebhook(() => {});
    const res = mockRes();
    handler(mockReq({ status: "ringing", uuid: "u1" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
  });

  it("fires onCallEnded with the uuid on a completed event", () => {
    const hook = vi.fn();
    const handler = createEventWebhook(hook);
    handler(mockReq({ status: "completed", uuid: "call-9" }), mockRes());
    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith("call-9");
  });

  it("does not fire onCallEnded for a non-terminal status", () => {
    const hook = vi.fn();
    const handler = createEventWebhook(hook);
    handler(mockReq({ status: "answered", uuid: "call-9" }), mockRes());
    expect(hook).not.toHaveBeenCalled();
  });

  it("fires the hook for every terminal status", () => {
    for (const status of TERMINAL_STATUSES) {
      const hook = vi.fn();
      const handler = createEventWebhook(hook);
      handler(mockReq({ status, uuid: "u" }), mockRes());
      expect(hook, `status ${status} should be terminal`).toHaveBeenCalledOnce();
    }
  });

  it("does not fire the hook when the uuid is missing", () => {
    const hook = vi.fn();
    const handler = createEventWebhook(hook);
    handler(mockReq({ status: "completed" }), mockRes());
    expect(hook).not.toHaveBeenCalled();
  });

  it("tolerates a missing/empty body without throwing", () => {
    const hook = vi.fn();
    const handler = createEventWebhook(hook);
    const res = mockRes();
    expect(() => handler(mockReq(undefined), res)).not.toThrow();
    expect(res.statusCode).toBe(200);
    expect(hook).not.toHaveBeenCalled();
  });
});
