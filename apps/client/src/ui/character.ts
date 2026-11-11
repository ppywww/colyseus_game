/**
 * 角色选择（大厅）。
 *
 * 三件事，缺一不可：
 *   1. **持久化**：选过的角色下次进页面还在（localStorage 单键，不污染设置包）；
 *   2. **可交互**：阵容卡是 `<button>`，支持键盘 Tab / Space，选中态用奶酪黄 + 抬起；
 *   3. **单一来源**：选中的 id 同时喂给「入房选项」与「HUD 头像」，
 *      所以大厅里选的是谁、进游戏后左上角头像就是谁。
 *
 * 为什么不做"角色属性差异"：4v4 竞技里选人即选强度，路人局会退化成抢人。
 * 四个角色的血量/移速/武器完全一致，只换外观——这一条写进代码注释，避免以后被"加回来"。
 */

import { CHARACTER_IDS, characterOfIndex, characterIndexOf, type CharacterId } from "@colyseus-fps/shared";

import { CHARACTERS, HEADS } from "./art.js";

/** localStorage 键名（与 `fps.settings.v1` 分开：换角色不该触发设置面板重挂）。 */
const STORAGE_KEY = "fps.character.v1";

/** 读上次选择的角色；非法/缺失时回退到第一个角色。 */
export function loadCharacter(): CharacterId {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式 / 禁用存储：不影响进游戏，只是不记忆
    return characterOfIndex(0);
  }
  return characterOfIndex(characterIndexOf(raw ?? ""));
}

/** 记住选择（写失败静默忽略：存不下也能玩，不该因此报错打断开局）。 */
export function saveCharacter(id: CharacterId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 忽略
  }
}

/** 角色 id → 它在 `CHARACTER_IDS` 里的下标（状态同步用）。 */
export function characterIndex(id: CharacterId): number {
  return CHARACTER_IDS.indexOf(id);
}

/**
 * 把阵容卡渲染进 `host`，并接管选中态。
 *
 * @param host 容器（`#roster-list`）
 * @param selected 当前选中的角色
 * @param onChange 点击某张卡时的回调（调用方负责存盘 + 更新 HUD 头像）
 * @returns 卸载函数（当前流程只挂一次，留着是为了和 `mountSettingsPanel` 的接口一致）
 */
export function mountCharacterPicker(
  host: HTMLElement,
  selected: CharacterId,
  onChange: (id: CharacterId) => void,
): () => void {
  host.replaceChildren();
  const buttons = new Map<CharacterId, HTMLButtonElement>();

  for (const character of CHARACTERS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "roster-card";
    card.dataset.character = character.id;
    card.setAttribute("aria-pressed", String(character.id === selected));
    card.title = `选择 ${character.name}`;

    const face = document.createElement("span");
    face.className = "roster-face";
    face.style.background = character.tint;
    face.innerHTML = HEADS[character.id];

    const name = document.createElement("span");
    name.className = "roster-name";
    name.textContent = character.name;

    const role = document.createElement("span");
    role.className = "roster-role";
    role.textContent = character.role;

    const text = document.createElement("span");
    text.className = "roster-text";
    text.append(name, role);

    const check = document.createElement("span");
    check.className = "roster-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";

    card.append(face, text, check);
    card.classList.toggle("selected", character.id === selected);
    card.addEventListener("click", () => {
      if (card.classList.contains("selected")) {
        return;
      }
      for (const [id, button] of buttons) {
        const active: boolean = id === character.id;
        button.classList.toggle("selected", active);
        button.setAttribute("aria-pressed", String(active));
      }
      saveCharacter(character.id);
      onChange(character.id);
    });

    buttons.set(character.id, card);
    host.append(card);
  }

  return () => {
    host.replaceChildren();
  };
}
