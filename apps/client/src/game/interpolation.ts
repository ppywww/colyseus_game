/**
 * 远端玩家插值缓冲（纯逻辑，无渲染依赖，可在 Node 中单测）。
 *
 * 思路（参考 Gabriel Gambetta 的客户端插值模型）：
 * 每个远端玩家维护一个带本地时间戳的样本队列；渲染时刻回退
 * INTERPOLATION_DELAY_MS，在两帧样本之间做线性插值，使远端实体
 * 在 15Hz 状态更新下依然平滑移动。
 */

export interface TransformSample {
  /** 本地收到样本时的时刻（ms，performance.now()） */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface InterpolatedTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** 角度线性插值：走最短弧，避免 yaw 在 ±π 附近绕远路。 */
export function lerpAngle(from: number, to: number, alpha: number): number {
  let diff = to - from;
  while (diff > Math.PI) {
    diff -= Math.PI * 2;
  }
  while (diff < -Math.PI) {
    diff += Math.PI * 2;
  }
  return from + diff * alpha;
}

export class InterpolationBuffer {
  private samples: TransformSample[] = [];

  public constructor(
    private readonly delayMs: number,
    private readonly maxSamples: number = 64,
  ) {}

  /** 压入一个新样本；保持按时间升序，丢弃超出容量的最旧样本。 */
  public push(sample: TransformSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && sample.t < last.t) {
      // 乱序样本：丢弃，避免破坏插值单调性
      return;
    }
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  public size(): number {
    return this.samples.length;
  }

  public newest(): TransformSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  public clear(): void {
    this.samples.length = 0;
  }

  /**
   * 取 renderTimeMs - delayMs 时刻的插值结果。
   * 样本不足时回退到最近可用样本（外推会在高抖动下导致漂移，不做）。
   */
  public sample(renderTimeMs: number): InterpolatedTransform | null {
    if (this.samples.length === 0) {
      return null;
    }

    const target = renderTimeMs - this.delayMs;
    const first = this.samples[0] as TransformSample;

    if (this.samples.length === 1 || target <= first.t) {
      return { x: first.x, y: first.y, z: first.z, yaw: first.yaw, pitch: first.pitch };
    }

    const newest = this.samples[this.samples.length - 1] as TransformSample;
    if (target >= newest.t) {
      return { x: newest.x, y: newest.y, z: newest.z, yaw: newest.yaw, pitch: newest.pitch };
    }

    for (let i = this.samples.length - 1; i > 0; i--) {
      const right = this.samples[i] as TransformSample;
      const left = this.samples[i - 1] as TransformSample;

      if (left.t <= target) {
        const span = right.t - left.t;
        const alpha = span > 0 ? Math.min(1, Math.max(0, (target - left.t) / span)) : 1;
        return {
          x: left.x + (right.x - left.x) * alpha,
          y: left.y + (right.y - left.y) * alpha,
          z: left.z + (right.z - left.z) * alpha,
          yaw: lerpAngle(left.yaw, right.yaw, alpha),
          pitch: left.pitch + (right.pitch - left.pitch) * alpha,
        };
      }
    }

    return { x: newest.x, y: newest.y, z: newest.z, yaw: newest.yaw, pitch: newest.pitch };
  }
}
