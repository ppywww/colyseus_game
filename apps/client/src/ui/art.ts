/**
 * 卡通视觉资源（纯字符串 SVG）。
 *
 * 只放「跨界面复用」的图形：角色头像与武器图标。集中在这里的唯一理由是
 * **一致性**——大厅卡片、HUD 生命面板、武器栏、结算表如果各自存一份路径，
 * 改一次配色就要找四个地方，迟早会不一致。
 *
 * 约定：
 *   - 全部 52×52（头像）或 40×40（图标）viewBox，调用方用 CSS 控制尺寸；
 *   - 描边统一 `#2B1B2F`（--ink）、3px，圆角连接——这是整套视觉的骨架；
 *   - 图标用 `currentColor`，跟随武器栏的选中态变色，不写死颜色。
 */

/** 角色 id（与设计手册「角色」一节一致）。 */
export type CharacterId = "tom" | "jerry" | "spike" | "butch";

export interface CharacterProfile {
  id: CharacterId;
  name: string;
  /** 一句话定位，显示在大厅阵容卡与结算表。 */
  role: string;
  /** 头像底色（比角色主色更浅，保证墨线头像能压住）。 */
  tint: string;
}

/** 四个角色的元数据：大厅阵容卡、HUD 头像、结算表共用。 */
export const CHARACTERS: readonly CharacterProfile[] = [
  { id: "tom", name: "Tom", role: "均衡 · 100 血", tint: "#DCE6EF" },
  { id: "jerry", name: "Jerry", role: "敏捷 · 85 血", tint: "#F7DFC4" },
  { id: "spike", name: "Spike", role: "重装 · 130 血", tint: "#EFDCBA" },
  { id: "butch", name: "Butch", role: "狙击 · 90 血", tint: "#DAD1E0" },
];

const INK = "#2B1B2F";

/** 角色头像（52×52，含墨线）。 */
export const HEADS: Record<CharacterId, string> = {
  tom: `<svg viewBox="0 0 52 52" aria-hidden="true">
    <path d="M9 21 L7 5 L21 13 Z" fill="#7c93a8" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M43 21 L45 5 L31 13 Z" fill="#7c93a8" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M9 21 L10 12 L17 16 Z" fill="#ffb49a"/>
    <path d="M43 21 L42 12 L35 16 Z" fill="#ffb49a"/>
    <ellipse cx="26" cy="30" rx="16" ry="14" fill="#8ea4b8" stroke="${INK}" stroke-width="3"/>
    <ellipse cx="26" cy="37" rx="9.5" ry="7" fill="#f6f2ea"/>
    <path d="M19 27.5q3.5-3.5 7 0" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M33 27.5q-3.5-3.5-7 0" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M26 34.5l-3.4 2.4M26 34.5l3.4 2.4" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`,
  jerry: `<svg viewBox="0 0 52 52" aria-hidden="true">
    <ellipse cx="14" cy="15" rx="10.5" ry="10.5" fill="#c97b3e" stroke="${INK}" stroke-width="3"/>
    <ellipse cx="38" cy="15" rx="10.5" ry="10.5" fill="#c97b3e" stroke="${INK}" stroke-width="3"/>
    <ellipse cx="14" cy="15" rx="4.8" ry="4.8" fill="#ffb49a"/>
    <ellipse cx="38" cy="15" rx="4.8" ry="4.8" fill="#ffb49a"/>
    <ellipse cx="26" cy="31" rx="15" ry="13.5" fill="#e0a06a" stroke="${INK}" stroke-width="3"/>
    <ellipse cx="26" cy="36" rx="8" ry="6" fill="#f7dcc0"/>
    <circle cx="20" cy="27" r="3" fill="${INK}"/>
    <circle cx="32" cy="27" r="3" fill="${INK}"/>
    <circle cx="20.8" cy="26.2" r="1" fill="#fff"/>
    <circle cx="32.8" cy="26.2" r="1" fill="#fff"/>
    <circle cx="26" cy="34.5" r="3.4" fill="#e8432f" stroke="${INK}" stroke-width="2"/>
    <path d="M22 39q4 3 8 0" stroke="${INK}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
  </svg>`,
  spike: `<svg viewBox="0 0 52 52" aria-hidden="true">
    <path d="M10 17q-4 8 2 12 1-7 5-10z" fill="#a87c3e" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M42 17q4 8-2 12-1-7-5-10z" fill="#a87c3e" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <ellipse cx="26" cy="30" rx="17" ry="15" fill="#e0b26a" stroke="${INK}" stroke-width="3"/>
    <path d="M14 40q12 8 24 0" fill="#f2d19a" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M22 42h8" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="19" cy="26" r="3.2" fill="${INK}"/>
    <circle cx="33" cy="26" r="3.2" fill="${INK}"/>
    <path d="M15 21q4-3 8-1M37 21q-4-3-8-1" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M26 33v4" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`,
  butch: `<svg viewBox="0 0 52 52" aria-hidden="true">
    <path d="M9 22 L5 4 L22 13 Z" fill="#2e2233" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M43 22 L47 4 L30 13 Z" fill="#2e2233" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <ellipse cx="26" cy="31" rx="16" ry="14" fill="#3b2c42" stroke="${INK}" stroke-width="3"/>
    <ellipse cx="26" cy="37" rx="8.5" ry="6" fill="#5b4a5e"/>
    <path d="M18 27q4-4 8 0" stroke="#a6f07a" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M34 27q-4-4-8 0" stroke="#a6f07a" stroke-width="3" fill="none" stroke-linecap="round"/>
    <circle cx="21.5" cy="27.5" r="1.6" fill="#a6f07a"/>
    <circle cx="30.5" cy="27.5" r="1.6" fill="#a6f07a"/>
    <path d="M20 35q6 5 12 0" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  </svg>`,
};

/**
 * HUD 武器栏图标（40×40，`currentColor` 填充）。
 *
 * 六个槽位全部是玩具/厨具：水枪、橡皮筋枪、餐叉、平底锅、胡椒瓶、面粉袋。
 * 形状刻意做「大块剪影 + 一个识别特征」（水箱、木夹、叉齿、锅柄、旋盖、袋口），
 * 这样在 40px 且只有 55% 不透明度时也能分辨。
 */
export const WEAPON_ICONS: readonly string[] = [
  // 0 · 高压水枪
  `<svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
    <path d="M6 15h22a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H6z"/>
    <path d="M31 17.5h7v5h-7z"/>
    <path d="M17 15v-5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v5z"/>
    <path d="M11 25h7l-2 12H9z"/>
    <circle cx="12" cy="19.5" r="2" fill="#FFF8E9" opacity=".55"/>
  </svg>`,
  // 1 · 橡皮筋枪
  `<svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
    <path d="M4 15h31v5H4z"/>
    <path d="M6 20h8v13H6z"/>
    <path d="M17 20h10v4H17z"/>
    <rect x="19" y="23" width="5" height="8" rx="2.5"/>
    <path d="M4 12h13v3H4z"/>
    <path d="M33 15h3v5h-3z"/>
  </svg>`,
  // 2 · 餐叉
  `<svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
    <path d="M18.4 17h3.2v18h-3.2z"/>
    <path d="M12 4h3.2v11H12zM18.4 4h3.2v11h-3.2zM24.8 4H28v11h-3.2z"/>
    <path d="M12 14h16v5H12z"/>
  </svg>`,
  // 3 · 平底锅
  `<svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
    <circle cx="15" cy="22" r="11"/>
    <path d="M24 19h13v6H24z"/>
    <circle cx="15" cy="22" r="5" fill="#FFF8E9" opacity=".35"/>
  </svg>`,
  // 4 · 胡椒瓶
  `<svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
    <path d="M12 18h16v14a5 5 0 0 1-5 5h-6a5 5 0 0 1-5-5z"/>
    <rect x="14" y="9" width="12" height="9" rx="2.5"/>
    <circle cx="20" cy="6" r="3.2"/>
  </svg>`,
  // 5 · 面粉袋
  `<svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
    <path d="M11 14h18l-2 20a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3z"/>
    <path d="M13 14l2-7h10l2 7z"/>
    <path d="M14 5h12v3H14z"/>
    <path d="M17 22h6v6h-6z" fill="#FFF8E9" opacity=".45"/>
  </svg>`,
];
