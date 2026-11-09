/**
 * 键鼠输入：键盘状态、指针锁定、视角增量采集、滚轮切枪脉冲。
 *
 * 三条「改了就崩」的约束：
 *   1. `mousemove` 只在**指针锁定**时累加：否则拖动网页/滑块的鼠标移动会带着视角一起转
 *      （这也是灵敏度滑块必须能在锁定之外操作的前提）。
 *   2. 滚轮事件按 {@link WHEEL_MERGE_MS} 合并：触控板的惯性滚动一秒钟能发几十个事件，
 *      不合并的话一划就从 AK 滚到烟雾弹再滚回来，玩家永远切不到想用的那把。
 *   3. 灵敏度只乘在**读取时**（{@link InputController#consumeLookDelta}），不改累加值：
 *      同一帧里多次拖动滑块也不会把已经攒下的增量二次缩放。
 *   4. 单帧视角增量有上限（{@link MAX_LOOK_STEP_PER_FRAME}），超出部分**留到下一帧**而不是
 *      丢弃——这是"左右转视角时画面突然跳一下"的根治：指针锁定下浏览器偶尔会吐出一个
 *      巨大的 `movementX`（鼠标撞屏幕物理边界、驱动加速、Chrome 的合并事件都会），
 *      一次消费就是几十度的瞬移。分摊到后续几帧既不会瞬移，也不会丢掉玩家的甩枪位移。
 */

import {
  SENSITIVITY_DEFAULT,
  clampSensitivity,
} from "@colyseus-fps/shared";

/** 滚轮合并窗口（毫秒）：窗口内的多次滚动只算一步。 */
export const WHEEL_MERGE_MS = 80;

/**
 * 单个 `mousemove` 事件的位移上限（像素）。
 *
 * 正常用鼠标一帧最多几十像素，只有异常尖峰才会超过 400——这类值几乎都是浏览器 bug
 * 或设备驱动问题，直接截断比让它参与运算安全。
 */
const MAX_MOVEMENT_PER_EVENT = 400;

/** 单帧最多消费的视角增量（像素）。超出部分留在累加器里，下一帧继续。 */
export const MAX_LOOK_STEP_PER_FRAME = 350;

function clampStep(value: number, limit: number): number {
  if (value > limit) {
    return limit;
  }
  if (value < -limit) {
    return -limit;
  }
  return value;
}

export class InputController {
  private readonly keys = new Set<string>();
  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private locked = false;

  /** 鼠标灵敏度倍率（1.0 = 旧手感，见 shared 的 `BASE_SENSITIVITY`）。 */
  private sensitivity = SENSITIVITY_DEFAULT;

  /** 未消费的滚轮累计量（down 为正）。 */
  private wheelDelta = 0;
  /** 上一次真正吐出滚轮脉冲的时刻（毫秒）。 */
  private lastWheelEmitAt = 0;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked) {
      return;
    }
    this.lookDeltaX += clampStep(event.movementX, MAX_MOVEMENT_PER_EVENT);
    this.lookDeltaY += clampStep(event.movementY, MAX_MOVEMENT_PER_EVENT);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.locked) {
      return;
    }
    // 锁定状态下滚轮的唯一含义就是切枪，必须吃掉默认行为（否则某些浏览器会滚动/缩放页面）
    event.preventDefault();
    this.wheelDelta += event.deltaY;
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) {
      // 解锁瞬间清空未消费的滚轮量：否则下次锁定时会"补切"一次武器
      this.wheelDelta = 0;
      // 同理清空视角余量：Alt-Tab 回来时把攒下的位移一次性倾泻出去，就是一次视角瞬移
      this.lookDeltaX = 0;
      this.lookDeltaY = 0;
    }
  };

  public constructor(private readonly element: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  public isDown(code: string): boolean {
    return this.keys.has(code);
  }

  public isPointerLocked(): boolean {
    return this.locked;
  }

  /** 设置灵敏度倍率（会自动钳制到 0.2–3.0 并保留两位小数）。 */
  public setSensitivity(value: number): void {
    this.sensitivity = clampSensitivity(value);
  }

  /** 当前灵敏度倍率。 */
  public getSensitivity(): number {
    return this.sensitivity;
  }

  /** 请求指针锁定（需在用户手势中调用）。失败时触发 onLockError 回调而不是静默吞掉。 */
  public requestLock(): void {
    try {
      // 新版浏览器返回 Promise，旧版返回 undefined；拒绝原因（如请求过于频繁）
      // 必须被捕获，否则锁定失败时用户得不到任何反馈。
      const result = this.element.requestPointerLock() as unknown;
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.handleLockFailure(error);
        });
      }
    } catch (error: unknown) {
      this.handleLockFailure(error);
    }
  }

  public onLockError: ((message: string) => void) | null = null;

  private handleLockFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.onLockError !== null) {
      this.onLockError(message);
    }
  }

  /**
   * 读取并清零本帧累积的视角增量（**已乘灵敏度**）。
   *
   * 调用方只需要再乘 shared 的 `BASE_SENSITIVITY` 就得到弧度。
   */
  public consumeLookDelta(): { dx: number; dy: number } {
    // 单帧上限 + 余量留存：见文件头第 4 条约束。
    const stepX = clampStep(this.lookDeltaX, MAX_LOOK_STEP_PER_FRAME);
    const stepY = clampStep(this.lookDeltaY, MAX_LOOK_STEP_PER_FRAME);
    this.lookDeltaX -= stepX;
    this.lookDeltaY -= stepY;
    return {
      dx: stepX * this.sensitivity,
      dy: stepY * this.sensitivity,
    };
  }

  /**
   * 取出一个滚轮脉冲：`1` = 向后滚（下一个武器）、`-1` = 向前滚（上一个）、`0` = 无。
   *
   * 合并规则：距离上次吐出脉冲不足 {@link WHEEL_MERGE_MS} 时返回 0（但累计量保留），
   * 累计量的**符号**决定方向——触控板"先下后上"的抖动会被抵消成 0，不会白切一次。
   */
  public consumeWheelStep(): -1 | 0 | 1 {
    if (this.wheelDelta === 0) {
      return 0;
    }
    const now: number = performance.now();
    if (now - this.lastWheelEmitAt < WHEEL_MERGE_MS) {
      return 0;
    }
    const direction: -1 | 1 = this.wheelDelta > 0 ? 1 : -1;
    this.wheelDelta = 0;
    this.lastWheelEmitAt = now;
    return direction;
  }

  public dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.keys.clear();
    this.wheelDelta = 0;
  }
}
