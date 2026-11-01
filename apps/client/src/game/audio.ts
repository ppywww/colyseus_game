/**
 * 程序化音效：用 WebAudio 合成枪声/命中/击杀/爆炸/投掷/换弹，避免引入音频资源。
 *
 * 设计要点：
 *   - 全部为一次性合成（噪声 + 振荡器 + 包络），不占用长连接资源；
 *   - 首次用户手势（点击进入战场）后才会创建 AudioContext，符合浏览器自动播放策略；
 *   - 音量整体偏保守，避免多开窗口时过吵。
 */

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;

  /** 在用户手势中调用，创建/恢复音频上下文。 */
  public unlock(): void {
    if (this.context === null) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor === undefined) {
        this.enabled = false;
        return;
      }
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.context.destination);
      this.noiseBuffer = this.createNoiseBuffer(this.context);
    }
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
  }

  public setVolume(value: number): void {
    if (this.master !== null) {
      this.master.gain.value = Math.max(0, Math.min(1, value));
    }
  }

  private createNoiseBuffer(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * 0.5);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /** 噪声脉冲：枪声、爆炸、脚步等的基础素材。 */
  private noise(durationSeconds: number, filterHz: number, gain: number, type: BiquadFilterType = "bandpass"): void {
    if (!this.enabled || this.context === null || this.master === null || this.noiseBuffer === null) {
      return;
    }
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const filter = this.context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterHz;
    filter.Q.value = 0.8;

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + durationSeconds);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.start(now);
    source.stop(now + durationSeconds + 0.02);
  }

  /** 振荡器扫频：用于金属感的"叮"和低频冲击。 */
  private tone(
    fromHz: number,
    toHz: number,
    durationSeconds: number,
    gain: number,
    type: OscillatorType = "sine",
  ): void {
    if (!this.enabled || this.context === null || this.master === null) {
      return;
    }
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(fromHz, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), now + durationSeconds);

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + durationSeconds);

    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + durationSeconds + 0.02);
  }

  /** 步枪单发：低频冲击 + 高频噪声爆破 + 短促金属尾音。 */
  public gunshot(): void {
    this.tone(180, 60, 0.12, 0.5, "square");
    this.noise(0.11, 1800, 0.55, "bandpass");
    this.noise(0.06, 5200, 0.25, "highpass");
  }

  /** 命中敌人：清脆的高频"滴"。 */
  public hitmark(): void {
    this.tone(1500, 1100, 0.07, 0.22, "triangle");
  }

  /** 击杀确认：两段上行提示音。 */
  public killConfirm(): void {
    this.tone(880, 880, 0.09, 0.2, "triangle");
    window.setTimeout(() => this.tone(1320, 1320, 0.12, 0.18, "triangle"), 80);
  }

  /** 自己受伤：闷响 + 低频震动感。 */
  public hurt(): void {
    this.tone(220, 90, 0.18, 0.3, "sawtooth");
    this.noise(0.14, 400, 0.25, "lowpass");
  }

  public emptyClick(): void {
    this.noise(0.03, 2400, 0.18, "highpass");
  }

  public reloadStart(): void {
    this.noise(0.05, 1200, 0.2, "bandpass");
  }

  public reloadEnd(): void {
    this.noise(0.04, 2600, 0.22, "highpass");
    window.setTimeout(() => this.noise(0.04, 1600, 0.18, "bandpass"), 110);
  }

  /** 投掷：挥手风声。 */
  public throwWhoosh(): void {
    this.noise(0.18, 900, 0.18, "lowpass");
  }

  /** 手雷爆炸：低频冲击 + 长尾噪声。 */
  public explosion(): void {
    this.tone(90, 30, 0.5, 0.6, "sine");
    this.noise(0.5, 320, 0.5, "lowpass");
    this.noise(0.25, 1800, 0.3, "bandpass");
  }

  /** 闪光弹：耳鸣式高频长音。 */
  public flashbang(): void {
    this.tone(3800, 3200, 1.4, 0.16, "sine");
    this.noise(0.35, 6000, 0.3, "highpass");
  }

  /** 烟雾弹起烟：柔和的白噪声。 */
  public smokePop(): void {
    this.noise(0.6, 700, 0.16, "lowpass");
  }

  public dispose(): void {
    if (this.context !== null) {
      void this.context.close();
      this.context = null;
      this.master = null;
      this.noiseBuffer = null;
    }
  }
}
