/**
 * Minimal browser-native media manager for SmallWebRTCTransport.
 *
 * SmallWebRTCTransport defaults to DailyMediaManager which pulls in the full
 * @daily-co/daily-js SDK (including a ~10 MB "call-machine-object-bundle.js"
 * downloaded on every call). By providing this lightweight replacement we avoid
 * that dependency entirely while still handling mic acquisition/mute correctly.
 *
 * Only the methods actually called by SmallWebRTCTransport are implemented.
 * Device switching and screen-share are not needed for FreyaClient's use case.
 */

type TrackSet = {
  local: {
    audio: MediaStreamTrack | undefined;
    video: MediaStreamTrack | undefined;
    screenAudio: MediaStreamTrack | undefined;
    screenVideo: MediaStreamTrack | undefined;
  };
};

export class NativeMicManager {
  private _micTrack: MediaStreamTrack | undefined;
  private _micEnabled = true;
  private _enableMic: boolean;

  constructor(enableMic: boolean) {
    this._enableMic = enableMic;
  }

  // Called by SmallWebRTCTransport with PipecatClient options — not needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setClientOptions(_options: any): void {}

  async initialize(): Promise<void> {
    if (!this._enableMic) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this._micTrack = stream.getAudioTracks()[0];
    this._micEnabled = true;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this._micTrack?.stop();
    this._micTrack = undefined;
  }

  tracks(): TrackSet {
    return {
      local: {
        audio: this._micTrack,
        video: undefined,
        screenAudio: undefined,
        screenVideo: undefined,
      },
    };
  }

  get isMicEnabled(): boolean {
    return this._micEnabled && !!this._micTrack;
  }

  get isCamEnabled(): boolean {
    return false;
  }

  get supportsScreenShare(): boolean {
    return false;
  }

  enableMic(enable: boolean): void {
    if (this._micTrack) {
      this._micTrack.enabled = enable;
    }
    this._micEnabled = enable;
  }

  enableCam(_enable: boolean): void {}

  // Device enumeration stubs — FreyaClient does not expose device selection UI.
  async getAllMics(): Promise<MediaDeviceInfo[]> {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  }
  async getAllCams(): Promise<MediaDeviceInfo[]> { return []; }
  async getAllSpeakers(): Promise<MediaDeviceInfo[]> { return []; }
  async updateMic(_id: string): Promise<void> {}
  async updateCam(_id: string): Promise<void> {}
  async updateSpeaker(_id: string): Promise<void> {}
  get selectedMic(): MediaDeviceInfo | undefined { return undefined; }
  get selectedCam(): MediaDeviceInfo | undefined { return undefined; }
  get selectedSpeaker(): MediaDeviceInfo | undefined { return undefined; }
}
