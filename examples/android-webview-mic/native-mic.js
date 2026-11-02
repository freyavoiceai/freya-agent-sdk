// The page side of MicBridge.kt: the app records, this collects its frames.
// Use it in place of getUserMedia when the page runs in an Android WebView.

/** Frames arrive while the app records; stop() resolves to the whole recording as PCM. */
export function nativeMic({ sampleRate = 16000, endTimeoutMs = 1000 } = {}) {
  const listeners = new Set();
  let frames = [];
  let ended = null;

  window.freyaMic = {
    onFrame(base64) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const frame = new Int16Array(bytes.buffer); // little-endian, as MicBridge writes it
      frames.push(frame);
      for (const fn of listeners) fn(frame);
    },
    onEnd() {
      ended?.();
    },
  };

  return {
    /** Every 50 ms frame, while recording: for VoiceActivity or a level meter. */
    onFrame(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** False when the app has no microphone permission. */
    start() {
      frames = [];
      return window.FreyaMicNative.start();
    },
    async stop() {
      const done = new Promise((resolve) => {
        ended = resolve;
        setTimeout(resolve, endTimeoutMs);
      });
      window.FreyaMicNative.stop();
      await done;
      ended = null;
      const samples = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
      let at = 0;
      for (const f of frames) {
        samples.set(f, at);
        at += f.length;
      }
      return { samples, sampleRate };
    },
  };
}
