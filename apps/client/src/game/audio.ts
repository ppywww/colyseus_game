/**
 * 程序化音效：全部用 WebAudio 合成（噪声 + 振荡器 + 包络），不引入任何外部音频资源。
 *
 * 为什么坚持合成而不是放 mp3：
 *   1. 免版权风险——不下载任何主播/游戏的采样；
 *   2. 零网络请求，首屏不用等音频，也不会因为 404 静音；
 *   3. 每个声音都能按参数变化（距离、部位、枪型），比固定采样更"活"。
 *
 * 层次设计（对标 CS 的反馈密度）：
 *   开枪 = 低频冲击（身体感） + 中频爆裂（枪口） + 高频尾音（空间）；
 *   命中 = 短促"叮"（确认打中） / 爆头 = 更高更长的"叮——"（确认打头）；
 *   击杀 = 两段上行 + 人声 "Nice!"（致敬主播连杀播报，用浏览器 TTS 合成，不是采样）。
 */

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;
  /** 低血量心跳的循环定时器（0 = 未启动）。 */
  private heartbeatTimer = 0;
  private heartbeatOn = false;

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

  /**
   * 噪声脉冲：枪声、爆炸、脚步、布料摩擦的基础素材。
   *
   * @param delay 相对当前时刻的延迟（秒），用于拼多层"打击感"
   * @param rate 播放速率（>1 更短更尖，<1 更闷更厚）
   */
  private noise(
    durationSeconds: number,
    filterHz: number,
    gain: number,
    type: BiquadFilterType = "bandpass",
    delay = 0,
    rate = 1,
    pan = 0,
  ): void {
    if (!this.enabled || this.context === null || this.master === null || this.noiseBuffer === null) {
      return;
    }
    const now = this.context.currentTime + delay;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.playbackRate.value = rate;

    const filter = this.context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterHz;
    filter.Q.value = 0.8;

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(gain, now + Math.min(0.012, durationSeconds * 0.25));
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + durationSeconds);

    source.connect(filter);
    filter.connect(envelope);
    if (pan !== 0 && typeof this.context.createStereoPanner === "function") {
      const panner = this.context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      envelope.connect(panner);
      panner.connect(this.master);
    } else {
      envelope.connect(this.master);
    }
    source.start(now);
    source.stop(now + durationSeconds + 0.02);
  }

  /** 振荡器扫频：金属"叮"、低频冲击、耳鸣。 */
  private tone(
    fromHz: number,
    toHz: number,
    durationSeconds: number,
    gain: number,
    type: OscillatorType = "sine",
    delay = 0,
  ): void {
    if (!this.enabled || this.context === null || this.master === null) {
      return;
    }
    const now = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(fromHz, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), now + durationSeconds);

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + durationSeconds);

    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + durationSeconds + 0.02);
  }

  /* ------------------------------------------------------------------ *
   * 枪械
   * ------------------------------------------------------------------ */

  /** 步枪单发：低频冲击 + 高频噪声爆破 + 短促金属尾音。 */
  public gunshot(): void {
    const jitter = 0.94 + Math.random() * 0.12;
    this.tone(190 * jitter, 58, 0.13, 0.5, "square");
    this.noise(0.1, 1750 * jitter, 0.5, "bandpass");
    this.noise(0.05, 5200, 0.24, "highpass");
    // 远处回音：让枪声"有空间"，不是贴在耳朵上的电子音
    this.noise(0.22, 900, 0.075, "lowpass", 0.05);
  }

  /** 手枪单发：更脆更短，中频更突出（与步枪必须能盲听区分）。 */
  public gunshotPistol(): void {
    const jitter = 0.96 + Math.random() * 0.08;
    this.tone(260 * jitter, 90, 0.08, 0.42, "square");
    this.noise(0.07, 2400 * jitter, 0.42, "bandpass");
    this.noise(0.04, 6800, 0.2, "highpass");
  }

  /** 远处别人的枪声：闷、轻、带一点延迟，用来判断方位与交火点。 */
  public distantGunshot(pan = 0): void {
    this.noise(0.14, 700, 0.11, "lowpass", 0.01, 0.8, pan);
    this.tone(120, 50, 0.1, 0.09, "sine", 0.01);
  }

  /** 子弹擦身而过：短促的高频"嗖"，提示"这一枪差点打中你"。 */
  public bulletWhiz(): void {
    this.noise(0.09, 3200, 0.16, "bandpass", 0, 1.4);
    this.tone(2600, 900, 0.07, 0.05, "sine");
  }

  /* ------------------------------------------------------------------ *
   * 命中反馈
   * ------------------------------------------------------------------ */

  /** 命中身体：清脆的高频"滴"。 */
  public hitmark(): void {
    this.tone(1500, 1100, 0.06, 0.22, "triangle");
  }

  /** 命中头部：更高、更长、带一点金属泛音——必须和身体命中一听就分得开。 */
  public headshotHit(): void {
    this.tone(2400, 2300, 0.09, 0.26, "triangle");
    this.tone(3600, 3400, 0.06, 0.11, "sine", 0.02);
  }

  /** 命中敌人的肉体声（打中别人的"噗"，不是屏幕上的 UI 声）。 */
  public fleshHit(): void {
    this.tone(190, 80, 0.1, 0.2, "sine");
    this.noise(0.07, 620, 0.16, "lowpass");
  }

  /** 击杀确认：两段上行提示音。 */
  public killConfirm(): void {
    this.tone(880, 880, 0.09, 0.2, "triangle");
    window.setTimeout(() => this.tone(1320, 1320, 0.12, 0.18, "triangle"), 80);
  }

  /**
   * 爆头击杀的「Nice!」奖励反馈。
   *
   * 人声用浏览器自带的 `speechSynthesis` 合成一个短促的 "Nice"，不用任何主播采样
   * （采样有版权，且体积大）。TTS 不可用时退化成两段上行的欢呼音，反馈不会缺席。
   * 同时叠一层"人群欢呼"式的噪声包络，让它在混战里也能被听出来。
   */
  public niceCheer(): void {
    // 欢呼底噪：两段宽频噪声，模拟远处人群的一阵哄声
    this.noise(0.32, 1500, 0.1, "bandpass", 0.02);
    this.noise(0.26, 2400, 0.07, "bandpass", 0.12);
    this.tone(660, 990, 0.12, 0.14, "triangle", 0.04);
    this.tone(990, 1320, 0.16, 0.12, "triangle", 0.16);

    if (!this.enabled || typeof window.speechSynthesis === "undefined") {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance("Nice!");
      utterance.lang = "en-US";
      utterance.rate = 1.15;
      utterance.pitch = 1.15;
      utterance.volume = 0.85;
      window.speechSynthesis.speak(utterance);
    } catch {
      // 某些浏览器在无用户手势时会抛错：静默降级到上面那两层合成音
    }
  }

  /* ------------------------------------------------------------------ *
   * 受伤 / 状态
   * ------------------------------------------------------------------ */

  /**
   * 自己受伤：闷响 + 低频震动感。
   *
   * @param heavy true = 重击（爆头/手雷），音更长更低，带一点耳鸣
   */
  public hurt(heavy = false): void {
    if (heavy) {
      this.tone(190, 55, 0.32, 0.4, "sawtooth");
      this.noise(0.24, 300, 0.32, "lowpass");
      this.tone(2900, 2700, 0.5, 0.05, "sine", 0.05);
      return;
    }
    this.tone(220, 90, 0.16, 0.28, "sawtooth");
    this.noise(0.12, 420, 0.22, "lowpass");
  }

  /** 自己的脚步声（换弹/走位都会用到，节奏由主循环按移动速度控制）。 */
  public footstep(): void {
    this.noise(0.06, 480 + Math.random() * 200, 0.075, "lowpass");
    this.noise(0.03, 2200, 0.03, "highpass");
  }

  /** 起跳：短促的布料摩擦 + 轻微上行。 */
  public jump(): void {
    this.noise(0.07, 900, 0.06, "bandpass");
    this.tone(180, 240, 0.06, 0.04, "sine");
  }

  /** 落地：按冲击强度给不同的闷响（轻落几乎听不到，高处落地有"咚"）。 */
  public land(impact: number): void {
    const strength = Math.max(0.15, Math.min(1, impact));
    this.tone(120 * (1 + strength * 0.4), 55, 0.1 + strength * 0.08, 0.12 + strength * 0.2, "sine");
    this.noise(0.08, 380, 0.06 + strength * 0.12, "lowpass");
  }

  /** 低血量心跳：循环的"咚—咚"，频率固定 72BPM，靠音量渐强制造紧张感。 */
  public startHeartbeat(): void {
    if (this.heartbeatOn || !this.enabled) {
      return;
    }
    this.heartbeatOn = true;
    const beat = (): void => {
      if (!this.heartbeatOn) {
        return;
      }
      this.tone(64, 44, 0.16, 0.22, "sine");
      this.tone(58, 40, 0.14, 0.16, "sine", 0.19);
      this.heartbeatTimer = window.setTimeout(beat, 830);
    };
    beat();
  }

  public stopHeartbeat(): void {
    this.heartbeatOn = false;
    window.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = 0;
  }

  /* ------------------------------------------------------------------ *
   * 换弹 / 道具
   * ------------------------------------------------------------------ */

  public emptyClick(): void {
    this.noise(0.03, 2400, 0.18, "highpass");
  }

  /** 换弹开始：卸弹匣（塑料摩擦 + 卡榫"咔"）。 */
  public reloadStart(): void {
    this.noise(0.06, 1100, 0.18, "bandpass");
    this.tone(340, 260, 0.05, 0.08, "square", 0.04);
  }

  /** 换弹结束：推弹匣到位 + 拉机柄复位（两下，间隔 110ms）。 */
  public reloadEnd(): void {
    this.noise(0.05, 2600, 0.22, "highpass");
    this.tone(420, 300, 0.05, 0.1, "square", 0.02);
    window.setTimeout(() => {
      this.noise(0.05, 1500, 0.16, "bandpass");
      this.tone(210, 140, 0.06, 0.1, "square");
    }, 110);
  }

  /** 空仓换弹后拉枪机（比战术换弹多一下）。 */
  public boltAction(): void {
    this.noise(0.07, 1900, 0.2, "bandpass");
    this.tone(300, 180, 0.07, 0.1, "square");
  }

  /** 投掷：挥手风声。 */
  public throwWhoosh(): void {
    this.noise(0.18, 900, 0.18, "lowpass");
  }

  /** 拔保险销：极短的高频"叮"，投掷前的起手式。 */
  public pinPull(): void {
    this.tone(3200, 2800, 0.05, 0.08, "square");
  }

  /** 手雷落地/撞墙的"嗒"：按碰撞强度衰减音量。 */
  public grenadeBounce(strength = 1): void {
    this.noise(0.035, 1600, 0.08 * Math.max(0.2, Math.min(1, strength)), "bandpass");
    this.tone(520, 380, 0.04, 0.05, "square");
  }

  /** 挥刀破空：短促的高频噪声，像刀刃划过空气。 */
  public knifeSwing(): void {
    this.noise(0.12, 2400, 0.22, "bandpass");
    this.tone(900, 380, 0.1, 0.1, "triangle");
  }

  /** 砍中身体：沉闷的"噗"（thud），和子弹命中的"叮"必须明显区分。 */
  public knifeHit(): void {
    this.tone(160, 70, 0.16, 0.42, "sine");
    this.noise(0.1, 520, 0.3, "lowpass");
  }

  /** 背刺：低频重击 + 金属高频，必须比普通命中更"重"。 */
  public knifeCrit(): void {
    this.tone(110, 45, 0.28, 0.55, "sawtooth");
    this.noise(0.16, 380, 0.38, "lowpass");
    window.setTimeout(() => this.tone(1800, 1400, 0.12, 0.16, "triangle"), 40);
  }

  /** 手雷爆炸：低频冲击 + 长尾噪声 + 碎片。 */
  public explosion(): void {
    this.tone(95, 28, 0.55, 0.6, "sine");
    this.noise(0.5, 300, 0.5, "lowpass");
    this.noise(0.28, 1900, 0.3, "bandpass", 0.02);
    this.noise(0.16, 4200, 0.12, "highpass", 0.08);
  }

  /** 闪光弹：耳鸣式高频长音 + 白噪爆裂。 */
  public flashbang(): void {
    this.noise(0.12, 5200, 0.34, "highpass");
    this.tone(3800, 3100, 1.6, 0.16, "sine", 0.03);
    this.tone(5200, 5000, 1.1, 0.05, "sine", 0.03);
  }

  /** 烟雾弹起烟：柔和的白噪声，带一点"噗"的起爆声。 */
  public smokePop(): void {
    this.noise(0.1, 900, 0.16, "lowpass");
    this.noise(0.7, 640, 0.13, "lowpass", 0.06);
  }

  public dispose(): void {
    this.stopHeartbeat();
    if (typeof window.speechSynthesis !== "undefined") {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // 忽略：某些环境没有实现 cancel
      }
    }
    if (this.context !== null) {
      void this.context.close();
      this.context = null;
      this.master = null;
      this.noiseBuffer = null;
    }
  }
}
