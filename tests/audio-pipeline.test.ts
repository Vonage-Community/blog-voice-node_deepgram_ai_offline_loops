import { describe, expect, it } from "vitest";
import { createTurnTimer } from "../src/voice/audio-pipeline.js";

/** A fake clock that returns each queued value in order, then holds the last. */
function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("createTurnTimer", () => {
  it("measures each stage as the delta since the previous mark", () => {
    // begin=0, STT mark=100, model mark=250, TTS mark=600, finish=650
    const timer = createTurnTimer(fakeClock([0, 100, 250, 600, 650]));
    timer.begin();
    expect(timer.mark("speechToText")).toBe(100);
    expect(timer.mark("model")).toBe(150);
    expect(timer.mark("textToSpeech")).toBe(350);
    const latency = timer.finish();
    expect(latency).toEqual({
      speechToTextMs: 100,
      modelMs: 150,
      toolMs: 0,
      textToSpeechMs: 350,
      totalTurnMs: 650,
    });
  });

  it("uses set() for a stage measured elsewhere (the tool)", () => {
    const timer = createTurnTimer(fakeClock([0, 100, 250, 700, 750]));
    timer.begin();
    timer.mark("speechToText"); // 100
    timer.mark("model"); // 150
    timer.set("tool", 130); // measured by lookupOrderStatus
    timer.mark("textToSpeech"); // 450
    const latency = timer.finish();
    expect(latency.toolMs).toBe(130);
    expect(latency.totalTurnMs).toBe(750);
  });

  it("totalTurnMs is measured from begin() to finish()", () => {
    const timer = createTurnTimer(fakeClock([1000, 2080]));
    timer.begin();
    expect(timer.finish().totalTurnMs).toBe(1080);
  });

  it("begin() resets stage durations for a fresh turn", () => {
    const timer = createTurnTimer(fakeClock([0, 50, 200, 260]));
    timer.begin();
    timer.mark("speechToText"); // 50
    timer.begin(); // reset — clock now at 200
    const latency = timer.finish(); // now 260
    expect(latency.speechToTextMs).toBe(0);
    expect(latency.totalTurnMs).toBe(60);
  });

  it("does not throw if finish() is called before begin()", () => {
    const timer = createTurnTimer(fakeClock([500, 500]));
    expect(() => timer.finish()).not.toThrow();
    expect(timer.finish().totalTurnMs).toBe(0);
  });
});
