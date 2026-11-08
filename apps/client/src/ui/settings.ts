/**
 * 玩家设置（当前只有一项：鼠标灵敏度）。
 *
 * 三条硬约束（写在这里，改动前先读）：
 *   1. **默认 1.0 必须与旧手感逐位相等**：核心公式 `yaw -= movementX * BASE_SENSITIVITY * sens`，
 *      其中 `BASE_SENSITIVITY = 0.0023` 就是旧版写死在 `game.ts` 里的 `LOOK_SENSITIVITY`。
 *   2. **非法值只降级、不清除**：localStorage 里可能是旧版本结构、也可能是用户手改过的脏数据，
 *      解析失败一律回退 1.0，但**绝不 removeItem / clear**（那会连带删掉以后加的音量、画质）。
 *   3. **写入要防抖**：滑块 `input` 事件在拖动时每像素都触发，200ms 防抖 + 关闭页面时 flush。
 *
 * 本模块不依赖 three.js / DOM 全局（读写存储由调用方注入），因此可以在 Node 里单测。
 */

import {
  SETTINGS_STORAGE_KEY,
  SENSITIVITY_DEFAULT,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_STEP,
  clampSensitivity,
  formatSensitivity,
  parseSensitivity,
  serializeSensitivity,
} from "@colyseus-fps/shared";

/** 写盘防抖时长（毫秒）：拖动滑块时不要每个 input 都打一次 localStorage。 */
export const SETTINGS_DEBOUNCE_MS = 200;

/** localStorage 的最小只读/可写接口（便于单测注入内存实现）。 */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 设置快照。 */
export interface GameSettings {
  /** 鼠标灵敏度倍率：0.2–3.0，默认 1.0。 */
  sensitivity: number;
}

export type SettingsListener = (settings: GameSettings) => void;

/** 设置仓库：内存为真相，磁盘只在防抖后写一次。 */
export interface SettingsStore {
  /** 当前设置（只读快照，改它不会触发通知）。 */
  get(): GameSettings;
  getSensitivity(): number;
  /** 写入新灵敏度（内部会钳制/对齐），并安排一次防抖落盘。 */
  setSensitivity(value: number): void;
  /** 立即落盘（页面卸载、Esc 关闭设置时调用）。 */
  flush(): void;
  /** 订阅变更（大厅与游戏内两个滑块据此互相同步）。 */
  subscribe(listener: SettingsListener): () => void;
  /** 解绑全部监听并 flush。 */
  dispose(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * 创建设置仓库。
 *
 * @param storage 持久化目标；传 null 表示不可用（隐私模式 / 测试），此时只在内存里生效
 * @param options.debounceMs 写盘防抖时长，默认 {@link SETTINGS_DEBOUNCE_MS}
 */
export function createSettingsStore(
  storage: SettingsStorage | null,
  options: { debounceMs?: number } = {},
): SettingsStore {
  const debounceMs: number = Math.max(0, options.debounceMs ?? SETTINGS_DEBOUNCE_MS);
  const listeners = new Set<SettingsListener>();
  let pending: TimerHandle | null = null;

  // 启动时读一次：解析失败只回退默认值，不写回、不清除
  const settings: GameSettings = {
    sensitivity: parseSensitivity(storage === null ? null : storage.getItem(SETTINGS_STORAGE_KEY)),
  };

  const write = (): void => {
    pending = null;
    if (storage === null) {
      return;
    }
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, serializeSensitivity(settings.sensitivity));
    } catch {
      // 存储配额满 / 被禁用：设置仍然在内存里生效，不影响本局游戏
    }
  };

  const cancelPending = (): void => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
  };

  const notify = (): void => {
    for (const listener of listeners) {
      listener({ sensitivity: settings.sensitivity });
    }
  };

  return {
    get(): GameSettings {
      return { sensitivity: settings.sensitivity };
    },

    getSensitivity(): number {
      return settings.sensitivity;
    },

    setSensitivity(value: number): void {
      const next: number = clampSensitivity(value);
      if (next === settings.sensitivity) {
        // 值没变（例如滑块在同一档内抖动）：不通知、不落盘
        return;
      }
      settings.sensitivity = next;
      cancelPending();
      if (debounceMs <= 0) {
        write();
      } else {
        pending = setTimeout(write, debounceMs);
      }
      notify();
    },

    flush(): void {
      cancelPending();
      write();
    },

    subscribe(listener: SettingsListener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      cancelPending();
      write();
      listeners.clear();
    },
  };
}

/** 浏览器 localStorage 的安全包装：隐私模式下访问会抛错，这里降级成 null。 */
export function browserSettingsStorage(): SettingsStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const storage: Storage = window.localStorage;
    // 有些环境（Safari 无痕）能拿到对象但一读就抛
    storage.getItem(SETTINGS_STORAGE_KEY);
    return storage;
  } catch {
    return null;
  }
}

let singleton: SettingsStore | null = null;

/**
 * 全局设置仓库（懒加载单例）。
 *
 * 大厅与游戏内共用同一个实例，这样"在大厅调好的灵敏度"进游戏立刻生效，
 * 而在游戏里改了之后退回大厅，滑块也是新值（不需要刷新页面）。
 */
export function getSettingsStore(): SettingsStore {
  if (singleton === null) {
    singleton = createSettingsStore(browserSettingsStorage());
  }
  return singleton;
}

/** 仅测试用：清掉单例，让下一次 {@link getSettingsStore} 重新读存储。 */
export function resetSettingsStoreForTests(): void {
  singleton = null;
}

/**
 * 挂载灵敏度滑块（大厅「设置」折叠区与游戏内 Esc 遮罩共用这一个函数）。
 *
 * @param host 挂载点
 * @param store 设置仓库（两个挂载点必须传同一个，否则互不同步）
 * @returns 卸载函数（移除 DOM 与监听）
 */
export function mountSensitivitySlider(host: HTMLElement, store: SettingsStore): () => void {
  const row = document.createElement("label");
  row.className = "settings-row";

  const name = document.createElement("span");
  name.className = "settings-name";
  name.textContent = "鼠标灵敏度";

  const input = document.createElement("input");
  input.className = "settings-range";
  input.type = "range";
  input.min = String(SENSITIVITY_MIN);
  input.max = String(SENSITIVITY_MAX);
  input.step = String(SENSITIVITY_STEP);
  input.value = String(store.getSensitivity());
  input.setAttribute("aria-label", "鼠标灵敏度");

  const value = document.createElement("output");
  value.className = "settings-value";
  value.textContent = formatSensitivity(store.getSensitivity());

  row.append(name, input, value);

  const hint = document.createElement("p");
  hint.className = "settings-hint";
  const applyHint = (sensitivity: number): void => {
    hint.textContent = `当前 ${formatSensitivity(sensitivity)} × · 默认 ${formatSensitivity(SENSITIVITY_DEFAULT)} × · 范围 ${formatSensitivity(SENSITIVITY_MIN)}–${formatSensitivity(SENSITIVITY_MAX)}`;
  };
  applyHint(store.getSensitivity());

  const wrapper = document.createElement("div");
  wrapper.className = "settings-slider";
  wrapper.append(row, hint);

  const handleInput = (): void => {
    const next: number = clampSensitivity(input.value);
    store.setSensitivity(next);
  };

  /**
   * 阻断冒泡：大厅的遮罩/游戏内的锁定遮罩都在父级监听了 click，
   * 不拦的话"点滑块"会被当成"点击进入战斗"，指针锁定一拿，滑块就拖不动了。
   */
  const stopPropagation = (event: Event): void => {
    event.stopPropagation();
  };

  input.addEventListener("input", handleInput);
  // 整个滑块容器都拦下：父级监听的是「点击进入战斗」，一旦冒泡上去就会抢走指针锁定，
  // 滑块立刻拖不动（拖到一半指针被锁是玩家最讨厌的那种 bug）。
  wrapper.addEventListener("pointerdown", stopPropagation);
  wrapper.addEventListener("mousedown", stopPropagation);
  wrapper.addEventListener("click", stopPropagation);

  // 大厅与游戏内两个滑块共享同一个仓库：任何一处改动，另一处立即同步
  const unsubscribe = store.subscribe((settings: GameSettings): void => {
    const text: string = String(settings.sensitivity);
    if (input.value !== text) {
      input.value = text;
    }
    value.textContent = formatSensitivity(settings.sensitivity);
    applyHint(settings.sensitivity);
  });

  host.append(wrapper);

  return (): void => {
    unsubscribe();
    input.removeEventListener("input", handleInput);
    wrapper.removeEventListener("pointerdown", stopPropagation);
    wrapper.removeEventListener("mousedown", stopPropagation);
    wrapper.removeEventListener("click", stopPropagation);
    wrapper.remove();
  };
}
