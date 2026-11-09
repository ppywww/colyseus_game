/**
 * 设置仓库（灵敏度）单测。
 *
 * 覆盖的是"玩家真的会踩到"的场景，而不是 happy path：
 *   - 存储里是非法 JSON / 旧结构 / 越界值 → 回退 1.0 且**不清除原记录**
 *   - 拖动滑块每像素一次 input → 只落盘一次（200ms 防抖）
 *   - 关页面 / Esc 关闭时要能立即 flush
 *   - 大厅与游戏内两个滑块共享同一个仓库 → 订阅必须双向同步
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SETTINGS_STORAGE_KEY,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  CROSSHAIR_DEFAULT,
  CROSSHAIR_GAP_MAX,
} from "@colyseus-fps/shared";

import {
  SETTINGS_DEBOUNCE_MS,
  createSettingsStore,
  type SettingsStorage,
} from "../src/ui/settings.js";

/** 内存版 localStorage（Node 里没有 DOM）。 */
class MemoryStorage implements SettingsStorage {
  public readonly map = new Map<string, string>();
  public writes = 0;
  public reads = 0;

  public getItem(key: string): string | null {
    this.reads += 1;
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  public setItem(key: string, value: string): void {
    this.writes += 1;
    this.map.set(key, value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("设置加载", () => {
  it("空存储应使用默认灵敏度 1.0", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    assert.equal(store.getSensitivity(), 1);
    store.dispose();
  });

  it("合法记录应被读出来（启动只读一次）", () => {
    const storage = new MemoryStorage();
    storage.map.set(SETTINGS_STORAGE_KEY, JSON.stringify({ sensitivity: 1.85 }));
    const store = createSettingsStore(storage, { debounceMs: 0 });
    assert.equal(store.getSensitivity(), 1.85);
    assert.equal(storage.reads, 1, "启动只应读一次 localStorage");
    store.dispose();
  });

  it("非法 JSON 应回退 1.0，且**不得清除**原记录", () => {
    const storage = new MemoryStorage();
    storage.map.set(SETTINGS_STORAGE_KEY, "{ 这不是 JSON");
    const store = createSettingsStore(storage, { debounceMs: 0 });
    assert.equal(store.getSensitivity(), 1);
    assert.equal(storage.map.get(SETTINGS_STORAGE_KEY), "{ 这不是 JSON", "脏数据不能被删掉");
    store.dispose();
  });

  it("越界 / 非数字记录应被夹住而不是崩掉", () => {
    const storage = new MemoryStorage();
    storage.map.set(SETTINGS_STORAGE_KEY, JSON.stringify({ sensitivity: 99 }));
    const clamped = createSettingsStore(storage, { debounceMs: 0 });
    assert.equal(clamped.getSensitivity(), SENSITIVITY_MAX);
    clamped.dispose();

    storage.map.set(SETTINGS_STORAGE_KEY, JSON.stringify({ sensitivity: "快" }));
    const fallback = createSettingsStore(storage, { debounceMs: 0 });
    assert.equal(fallback.getSensitivity(), 1);
    fallback.dispose();
  });

  it("存储不可用（隐私模式）时应退化成纯内存，不抛错", () => {
    const store = createSettingsStore(null, { debounceMs: 0 });
    store.setSensitivity(2.5);
    assert.equal(store.getSensitivity(), 2.5);
    store.flush();
    store.dispose();
  });

  it("setItem 抛错（配额满）时设置仍然在内存里生效", () => {
    const storage: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createSettingsStore(storage, { debounceMs: 0 });
    store.setSensitivity(0.4);
    assert.equal(store.getSensitivity(), SENSITIVITY_MIN * 2);
    store.dispose();
  });
});

describe("设置写入与防抖", () => {
  it("默认防抖应为 200ms", () => {
    assert.equal(SETTINGS_DEBOUNCE_MS, 200);
  });

  it("拖动滑块连续 5 次 input 只落盘 1 次", async () => {
    const storage = new MemoryStorage();
    const store = createSettingsStore(storage, { debounceMs: 20 });
    for (const value of [0.5, 0.55, 0.6, 0.65, 0.7]) {
      store.setSensitivity(value);
    }
    assert.equal(storage.writes, 0, "防抖窗口内不应写盘");
    await sleep(60);
    assert.equal(storage.writes, 1, "窗口结束后只写一次");
    assert.equal(store.getSensitivity(), 0.7);
    store.dispose();
  });

  it("flush 应立即落盘（Esc 关闭设置 / 页面卸载）", () => {
    const storage = new MemoryStorage();
    const store = createSettingsStore(storage, { debounceMs: 5000 });
    store.setSensitivity(1.2);
    assert.equal(storage.writes, 0);
    store.flush();
    assert.equal(storage.writes, 1);
    assert.equal(JSON.parse(storage.map.get(SETTINGS_STORAGE_KEY) as string).sensitivity, 1.2);
    store.dispose();
  });

  it("值没变化时不应重复写盘", () => {
    const storage = new MemoryStorage();
    const store = createSettingsStore(storage, { debounceMs: 0 });
    store.setSensitivity(1);
    assert.equal(storage.writes, 0, "1.0 与默认值相同，不该写");
    store.setSensitivity(1.4);
    assert.equal(storage.writes, 1);
    store.setSensitivity(1.4);
    assert.equal(storage.writes, 1, "同值不应再写");
    store.dispose();
  });

  it("写入前必须钳制（0.1 → 0.2，5 → 3.0）", () => {
    const storage = new MemoryStorage();
    const store = createSettingsStore(storage, { debounceMs: 0 });
    store.setSensitivity(0.1);
    assert.equal(store.getSensitivity(), SENSITIVITY_MIN);
    store.setSensitivity(5);
    assert.equal(store.getSensitivity(), SENSITIVITY_MAX);
    store.dispose();
  });
});

describe("订阅同步（大厅 ⇄ 游戏内两个滑块）", () => {
  it("任一处修改都应通知订阅者", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    const seen: number[] = [];
    const unsubscribe = store.subscribe((settings) => seen.push(settings.sensitivity));
    store.setSensitivity(2.2);
    store.setSensitivity(0.3);
    assert.deepEqual(seen, [2.2, 0.3]);
    unsubscribe();
    store.setSensitivity(1);
    assert.deepEqual(seen, [2.2, 0.3], "退订后不应再收到通知");
    store.dispose();
  });

  it("dispose 应落盘并停止通知", () => {
    const storage = new MemoryStorage();
    const store = createSettingsStore(storage, { debounceMs: 5000 });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.setSensitivity(1.6);
    store.dispose();
    assert.equal(storage.writes, 1, "dispose 必须 flush");
    store.setSensitivity(2.9);
    assert.equal(notified, 1, "dispose 后不应再有通知");
  });

  it("get() 返回的是副本，外部改动不会污染仓库", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    const snapshot = store.get();
    snapshot.sensitivity = 3;
    assert.equal(store.getSensitivity(), 1);
    store.dispose();
  });
});

describe("准星设置（与灵敏度同源存储）", () => {
  it("空存储应使用默认准星", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    assert.deepEqual(store.getCrosshair(), CROSSHAIR_DEFAULT);
    store.dispose();
  });

  it("局部更新只改给出的字段", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    store.setCrosshair({ color: "#38bdf8" });
    const afterColor = store.getCrosshair();
    assert.equal(afterColor.color, "#38bdf8");
    assert.equal(afterColor.gap, CROSSHAIR_DEFAULT.gap, "没给的字段必须保持不变");

    store.setCrosshair({ gap: 8, dot: true });
    const afterGap = store.getCrosshair();
    assert.equal(afterGap.gap, 8);
    assert.equal(afterGap.dot, true);
    assert.equal(afterGap.color, "#38bdf8", "之前改过的颜色不能丢");
    store.dispose();
  });

  it("越界值写入前必须夹住，而不是写进内存", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    store.setCrosshair({ gap: 9999, thickness: 0, color: "不是颜色" });
    const crosshair = store.getCrosshair();
    assert.equal(crosshair.gap, CROSSHAIR_GAP_MAX);
    assert.equal(crosshair.thickness, 1);
    assert.equal(crosshair.color, CROSSHAIR_DEFAULT.color);
    store.dispose();
  });

  it("改动应当通知订阅者，且值没变时不重复通知/写盘", () => {
    const storage = new MemoryStorage();
    const store = createSettingsStore(storage, { debounceMs: 0 });
    const seen: number[] = [];
    store.subscribe((settings) => seen.push(settings.crosshair.gap));

    store.setCrosshair({ gap: 7 });
    assert.deepEqual(seen, [7]);
    const writes = storage.writes;
    store.setCrosshair({ gap: 7 });
    assert.equal(seen.length, 1, "同值不应再通知");
    assert.equal(storage.writes, writes, "同值不应再写盘");
    store.dispose();
  });

  it("准星与灵敏度必须写进同一个 JSON（不会互相覆盖）", () => {
    const storage = new MemoryStorage();
    const store = createSettingsStore(storage, { debounceMs: 0 });
    store.setSensitivity(1.45);
    store.setCrosshair({ color: "#fde047", gap: 6 });
    store.flush();

    const raw = JSON.parse(storage.map.get(SETTINGS_STORAGE_KEY) as string) as {
      sensitivity: number;
      crosshair: { color: string; gap: number };
    };
    assert.equal(raw.sensitivity, 1.45);
    assert.equal(raw.crosshair.color, "#fde047");
    assert.equal(raw.crosshair.gap, 6);
    store.dispose();

    // 重新加载（模拟刷新页面）两个值都要在
    const reloaded = createSettingsStore(storage, { debounceMs: 0 });
    assert.equal(reloaded.getSensitivity(), 1.45);
    assert.equal(reloaded.getCrosshair().color, "#fde047");
    assert.equal(reloaded.getCrosshair().gap, 6);
    reloaded.dispose();
  });

  it("旧记录（只有 sensitivity）升级后必须保留灵敏度、准星取默认", () => {
    const storage = new MemoryStorage();
    storage.map.set(SETTINGS_STORAGE_KEY, JSON.stringify({ sensitivity: 2.1 }));
    const store = createSettingsStore(storage, { debounceMs: 0 });
    assert.equal(store.getSensitivity(), 2.1, "升级不能把玩家调好的灵敏度冲掉");
    assert.deepEqual(store.getCrosshair(), CROSSHAIR_DEFAULT);
    store.dispose();
  });

  it("resetCrosshair 应回到默认，且不影响灵敏度", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    store.setSensitivity(2.4);
    store.setCrosshair({ color: "#ef4444", gap: 11, dot: true });
    store.resetCrosshair();
    assert.deepEqual(store.getCrosshair(), CROSSHAIR_DEFAULT);
    assert.equal(store.getSensitivity(), 2.4);
    store.dispose();
  });

  it("get() 返回的准星是深拷贝，改它不会污染仓库", () => {
    const store = createSettingsStore(new MemoryStorage(), { debounceMs: 0 });
    const snapshot = store.get();
    snapshot.crosshair.color = "#000000";
    snapshot.crosshair.gap = 12;
    assert.equal(store.getCrosshair().color, CROSSHAIR_DEFAULT.color);
    assert.equal(store.getCrosshair().gap, CROSSHAIR_DEFAULT.gap);
    store.dispose();
  });
});
