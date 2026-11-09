/**
 * 玩家设置：鼠标灵敏度 + 准星外观。
 *
 * 四条硬约束（写在这里，改动前先读）：
 *   1. **默认灵敏度 1.0 必须与旧手感逐位相等**：核心公式 `yaw -= movementX * BASE_SENSITIVITY * sens`，
 *      其中 `BASE_SENSITIVITY = 0.0023` 就是旧版写死在 `game.ts` 里的 `LOOK_SENSITIVITY`。
 *   2. **非法值只降级、不清除**：localStorage 里可能是旧版本结构、也可能是用户手改过的脏数据，
 *      解析失败一律回退默认值，但**绝不 removeItem / clear**（那会连带删掉以后加的音量、画质）。
 *   3. **写入要防抖**：滑块 `input` 事件在拖动时每像素都触发，200ms 防抖 + 关闭页面时 flush。
 *   4. **准星逐字段降级**：旧记录里没有 `crosshair`、或者某个字段被改成字符串，
 *      只修那一个字段，其余保留——玩家调了半天的颜色不能因为一个间距越界就全丢。
 *
 * 本模块不依赖 three.js / DOM 全局（读写存储由调用方注入），因此可以在 Node 里单测。
 */

import {
  CROSSHAIR_COLORS,
  CROSSHAIR_DEFAULT,
  CROSSHAIR_GAP_MAX,
  CROSSHAIR_GAP_MIN,
  CROSSHAIR_LENGTH_MAX,
  CROSSHAIR_LENGTH_MIN,
  CROSSHAIR_THICKNESS_MAX,
  CROSSHAIR_THICKNESS_MIN,
  SETTINGS_STORAGE_KEY,
  SENSITIVITY_DEFAULT,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_STEP,
  clampCrosshair,
  clampCrosshairColor,
  clampSensitivity,
  formatSensitivity,
  parseSettings,
  serializeSettings,
  type CrosshairSettings,
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
  /** 准星外观（纯表现）。 */
  crosshair: CrosshairSettings;
}

export type SettingsListener = (settings: GameSettings) => void;

/** 设置仓库：内存为真相，磁盘只在防抖后写一次。 */
export interface SettingsStore {
  /** 当前设置（只读快照，改它不会触发通知）。 */
  get(): GameSettings;
  getSensitivity(): number;
  getCrosshair(): CrosshairSettings;
  /** 写入新灵敏度（内部会钳制/对齐），并安排一次防抖落盘。 */
  setSensitivity(value: number): void;
  /** 局部更新准星外观（未给出的字段保持不变），并安排一次防抖落盘。 */
  setCrosshair(patch: Partial<CrosshairSettings>): void;
  /** 准星恢复默认。 */
  resetCrosshair(): void;
  /** 立即落盘（页面卸载、Esc 关闭设置时调用）。 */
  flush(): void;
  /** 订阅变更（大厅与游戏内两个面板据此互相同步）。 */
  subscribe(listener: SettingsListener): () => void;
  /** 解绑全部监听并 flush。 */
  dispose(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

function copySettings(settings: GameSettings): GameSettings {
  return { sensitivity: settings.sensitivity, crosshair: { ...settings.crosshair } };
}

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
  const parsed = parseSettings(storage === null ? null : storage.getItem(SETTINGS_STORAGE_KEY));
  const settings: GameSettings = {
    sensitivity: parsed.sensitivity,
    crosshair: parsed.crosshair,
  };

  const write = (): void => {
    pending = null;
    if (storage === null) {
      return;
    }
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, serializeSettings(settings));
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

  /** 变更后的统一出口：防抖落盘 + 通知。值没变时调用方应当提前 return。 */
  const commit = (): void => {
    cancelPending();
    if (debounceMs <= 0) {
      write();
    } else {
      pending = setTimeout(write, debounceMs);
    }
    for (const listener of listeners) {
      listener(copySettings(settings));
    }
  };

  return {
    get(): GameSettings {
      return copySettings(settings);
    },

    getSensitivity(): number {
      return settings.sensitivity;
    },

    getCrosshair(): CrosshairSettings {
      return { ...settings.crosshair };
    },

    setSensitivity(value: number): void {
      const next: number = clampSensitivity(value);
      if (next === settings.sensitivity) {
        // 值没变（例如滑块在同一档内抖动）：不通知、不落盘
        return;
      }
      settings.sensitivity = next;
      commit();
    },

    setCrosshair(patch: Partial<CrosshairSettings>): void {
      // 先合并再整体过一遍 clamp：这样越界值/非法颜色只会被修掉，不会写进内存
      const next: CrosshairSettings = clampCrosshair({ ...settings.crosshair, ...patch });
      const changed: boolean =
        next.color !== settings.crosshair.color ||
        next.length !== settings.crosshair.length ||
        next.thickness !== settings.crosshair.thickness ||
        next.gap !== settings.crosshair.gap ||
        next.dot !== settings.crosshair.dot ||
        next.outline !== settings.crosshair.outline ||
        next.dynamic !== settings.crosshair.dynamic;
      if (!changed) {
        return;
      }
      settings.crosshair = next;
      commit();
    },

    resetCrosshair(): void {
      this.setCrosshair({ ...CROSSHAIR_DEFAULT });
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
 * 大厅与游戏内共用同一个实例，这样"在大厅调好的灵敏度/准星"进游戏立刻生效，
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

/* ------------------------------------------------------------------ *
 * UI：设置面板（大厅「设置」折叠区与游戏内 Esc 遮罩共用）
 * ------------------------------------------------------------------ */

/**
 * 把设置面板挂到 `host` 上。
 *
 * @param host 挂载点
 * @param store 设置仓库（两个挂载点必须传同一个，否则互不同步）
 * @returns 卸载函数（移除 DOM 与监听）
 */
export function mountSettingsPanel(host: HTMLElement, store: SettingsStore): () => void {
  const panel = document.createElement("div");
  panel.className = "settings-panel";

  const uninstall: Array<() => void> = [];
  panel.append(buildSensitivityGroup(store, uninstall), buildCrosshairGroup(store, uninstall));
  host.append(panel);

  return (): void => {
    for (const off of uninstall) {
      off();
    }
    uninstall.length = 0;
    panel.remove();
  };
}

/**
 * 滑动条 + 名字 + 读数的通用行。返回 { wrapper, input, setText }。
 *
 * `onInput` 在拖动时每像素调用一次——由调用方决定怎么落盘（store 有 200ms 防抖）。
 */
function buildRangeRow(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onInput: (value: number) => void;
}): { wrapper: HTMLElement; input: HTMLInputElement; output: HTMLOutputElement } {
  const row = document.createElement("label");
  row.className = "settings-row";

  const name = document.createElement("span");
  name.className = "settings-name";
  name.textContent = options.label;

  const input = document.createElement("input");
  input.className = "settings-range";
  input.type = "range";
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.value);
  input.setAttribute("aria-label", options.label);

  const output = document.createElement("output");
  output.className = "settings-value";
  output.textContent = options.format(options.value);

  row.append(name, input, output);

  input.addEventListener("input", () => {
    const next: number = Number(input.value);
    output.textContent = options.format(next);
    options.onInput(next);
  });

  return { wrapper: row, input, output };
}

/**
 * 阻断冒泡：大厅的遮罩/游戏内的锁定遮罩都在父级监听了 click，
 * 不拦的话"点滑块"会被当成"点击进入战斗"，指针锁定一拿，控件就拖不动了。
 */
function blockPointerEvents(element: HTMLElement): void {
  const stop = (event: Event): void => {
    event.stopPropagation();
  };
  for (const type of ["pointerdown", "mousedown", "click", "touchstart"]) {
    element.addEventListener(type, stop);
  }
}

function buildSensitivityGroup(store: SettingsStore, uninstall: Array<() => void>): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";

  const title = document.createElement("h3");
  title.className = "settings-title";
  title.textContent = "鼠标灵敏度";

  const { wrapper, input, output } = buildRangeRow({
    label: "灵敏度",
    min: SENSITIVITY_MIN,
    max: SENSITIVITY_MAX,
    step: SENSITIVITY_STEP,
    value: store.getSensitivity(),
    format: (value) => `${formatSensitivity(value)}×`,
    onInput: (value) => {
      store.setSensitivity(value);
    },
  });

  const hint = document.createElement("p");
  hint.className = "settings-hint";
  const applyHint = (sensitivity: number): void => {
    hint.textContent = `当前 ${formatSensitivity(sensitivity)} × · 默认 ${formatSensitivity(SENSITIVITY_DEFAULT)} × · 范围 ${formatSensitivity(SENSITIVITY_MIN)}–${formatSensitivity(SENSITIVITY_MAX)}`;
  };
  applyHint(store.getSensitivity());

  const slider = document.createElement("div");
  slider.className = "settings-slider";
  slider.append(wrapper, hint);
  group.append(title, slider);

  const unsubscribe = store.subscribe((settings) => {
    const text: string = String(settings.sensitivity);
    if (input.value !== text) {
      input.value = text;
    }
    output.textContent = `${formatSensitivity(settings.sensitivity)}×`;
    applyHint(settings.sensitivity);
  });

  blockPointerEvents(slider);
  uninstall.push(() => {
    unsubscribe();
    slider.remove();
  });
  return group;
}

function buildCrosshairGroup(store: SettingsStore, uninstall: Array<() => void>): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";

  const title = document.createElement("h3");
  title.className = "settings-title";
  title.textContent = "准星";

  // ---- 预览：与游戏内准星共用 `.xh` 的 CSS，所见即所得 ----
  const previewWrap = document.createElement("div");
  previewWrap.className = "xh-preview-wrap";
  const preview = document.createElement("div");
  preview.className = "xh xh-preview";
  preview.innerHTML =
    "<span></span><span></span><span></span><span></span><span class=\"xh-dot\"></span>";
  previewWrap.append(preview);

  const applyPreview = (crosshair: CrosshairSettings): void => {
    const style = preview.style;
    style.setProperty("--xh-color", crosshair.color);
    style.setProperty("--xh-len", `${crosshair.length}px`);
    style.setProperty("--xh-thick", `${crosshair.thickness}px`);
    style.setProperty("--xh-gap", `${crosshair.gap}px`);
    preview.classList.toggle("has-dot", crosshair.dot);
    preview.classList.toggle("outline", crosshair.outline);
  };

  // ---- 颜色：预设色块 + 自由取色 ----
  const swatches = document.createElement("div");
  swatches.className = "settings-swatches";
  const swatchButtons: HTMLButtonElement[] = [];

  const customColor = document.createElement("input");
  customColor.type = "color";
  customColor.className = "settings-color";
  customColor.setAttribute("aria-label", "自定义准星颜色");

  const markActiveSwatch = (color: string): void => {
    for (const button of swatchButtons) {
      button.classList.toggle("active", button.dataset.color === color);
    }
    customColor.value = color;
  };

  for (const color of CROSSHAIR_COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-swatch";
    button.dataset.color = color;
    button.style.background = color;
    button.title = color;
    button.setAttribute("aria-label", `准星颜色 ${color}`);
    button.addEventListener("click", () => {
      store.setCrosshair({ color: clampCrosshairColor(color) });
    });
    swatchButtons.push(button);
    swatches.append(button);
  }
  customColor.addEventListener("input", () => {
    store.setCrosshair({ color: clampCrosshairColor(customColor.value) });
  });
  swatches.append(customColor);

  // ---- 尺寸三条滑块 ----
  const lengthRow = buildRangeRow({
    label: "长度",
    min: CROSSHAIR_LENGTH_MIN,
    max: CROSSHAIR_LENGTH_MAX,
    step: 1,
    value: store.getCrosshair().length,
    format: (value) => `${Math.round(value)}px`,
    onInput: (value) => store.setCrosshair({ length: value }),
  });
  const thicknessRow = buildRangeRow({
    label: "粗细",
    min: CROSSHAIR_THICKNESS_MIN,
    max: CROSSHAIR_THICKNESS_MAX,
    step: 1,
    value: store.getCrosshair().thickness,
    format: (value) => `${Math.round(value)}px`,
    onInput: (value) => store.setCrosshair({ thickness: value }),
  });
  const gapRow = buildRangeRow({
    label: "间距",
    min: CROSSHAIR_GAP_MIN,
    max: CROSSHAIR_GAP_MAX,
    step: 1,
    value: store.getCrosshair().gap,
    format: (value) => `${Math.round(value)}px`,
    onInput: (value) => store.setCrosshair({ gap: value }),
  });

  // ---- 三个开关 ----
  const toggles = document.createElement("div");
  toggles.className = "settings-toggles";

  const buildToggle = (
    label: string,
    key: "dot" | "outline" | "dynamic",
    hintText: string,
  ): { wrapper: HTMLLabelElement; input: HTMLInputElement } => {
    const wrapper = document.createElement("label");
    wrapper.className = "settings-toggle";
    wrapper.title = hintText;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = store.getCrosshair()[key];
    input.addEventListener("change", () => {
      store.setCrosshair({ [key]: input.checked } as Partial<CrosshairSettings>);
    });
    const text = document.createElement("span");
    text.textContent = label;
    wrapper.append(input, text);
    return { wrapper, input };
  };

  const dotToggle = buildToggle("中心点", "dot", "在准星正中画一个小方点");
  const outlineToggle = buildToggle("描边", "outline", "给准星描一圈黑边，浅色墙面上也看得清");
  const dynamicToggle = buildToggle("随开火张开", "dynamic", "关掉后准星保持固定间距，不随扩散变化");
  toggles.append(dotToggle.wrapper, outlineToggle.wrapper, dynamicToggle.wrapper);

  // ---- 恢复默认 ----
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "settings-reset";
  reset.textContent = "恢复默认准星";
  reset.addEventListener("click", () => {
    store.resetCrosshair();
  });

  const body = document.createElement("div");
  body.className = "settings-slider";
  body.append(
    previewWrap,
    swatches,
    lengthRow.wrapper,
    thicknessRow.wrapper,
    gapRow.wrapper,
    toggles,
    reset,
  );
  group.append(title, body);

  const applyAll = (crosshair: CrosshairSettings): void => {
    applyPreview(crosshair);
    markActiveSwatch(crosshair.color);
    const sync = (input: HTMLInputElement, output: HTMLOutputElement, value: number): void => {
      const text: string = String(value);
      if (input.value !== text) {
        input.value = text;
      }
      output.textContent = `${value}px`;
    };
    sync(lengthRow.input, lengthRow.output, crosshair.length);
    sync(thicknessRow.input, thicknessRow.output, crosshair.thickness);
    sync(gapRow.input, gapRow.output, crosshair.gap);
    dotToggle.input.checked = crosshair.dot;
    outlineToggle.input.checked = crosshair.outline;
    dynamicToggle.input.checked = crosshair.dynamic;
  };
  applyAll(store.getCrosshair());

  const unsubscribe = store.subscribe((settings) => {
    applyAll(settings.crosshair);
  });

  blockPointerEvents(body);
  uninstall.push(() => {
    unsubscribe();
    body.remove();
    swatchButtons.length = 0;
  });
  return group;
}

/**
 * 只挂灵敏度滑块的旧入口（保留给测试与将来别处复用）。
 *
 * 新代码请用 {@link mountSettingsPanel}——它同时挂灵敏度和准星。
 */
export function mountSensitivitySlider(host: HTMLElement, store: SettingsStore): () => void {
  const uninstall: Array<() => void> = [];
  const group = buildSensitivityGroup(store, uninstall);
  host.append(group);
  return (): void => {
    for (const off of uninstall) {
      off();
    }
    uninstall.length = 0;
    group.remove();
  };
}
