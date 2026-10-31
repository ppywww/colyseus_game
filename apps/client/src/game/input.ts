/**
 * 键鼠输入：键盘状态、指针锁定与视角增量采集。
 */

export class InputController {
  private readonly keys = new Set<string>();
  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private locked = false;

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
    this.lookDeltaX += event.movementX;
    this.lookDeltaY += event.movementY;
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
  };

  public constructor(private readonly element: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  public isDown(code: string): boolean {
    return this.keys.has(code);
  }

  public isPointerLocked(): boolean {
    return this.locked;
  }

  /** 请求指针锁定（需在用户手势中调用）。 */
  public requestLock(): void {
    this.element.requestPointerLock();
  }

  /** 读取并清零本帧累积的视角增量。 */
  public consumeLookDelta(): { dx: number; dy: number } {
    const delta = { dx: this.lookDeltaX, dy: this.lookDeltaY };
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    return delta;
  }

  public dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.keys.clear();
  }
}
