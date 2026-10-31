/**
 * 客户端入口（骨架占位版本）。
 *
 * 当前阶段客户端渲染引擎尚未确定（候选：Three.js / Babylon.js / PlayCanvas），
 * 因此这里只做「常量可见性 + 目录规划」的占位验证，不创建画布、不建立网络连接。
 *
 * 后续实现顺序：
 *   1. src/net    ：Colyseus 客户端连接、房间状态订阅、消息发送
 *   2. src/input  ：键鼠输入采集与本地预测缓冲
 *   3. src/scenes ：场景、玩家实体、插值与外推渲染
 *   4. src/ui     ：HUD、计分板、结算界面
 */

import { CLIENT_INTERPOLATION_DELAY_MS, GAME_TICK_RATE, PROJECT_NAME } from "@colyseus-fps/shared";

const placeholderInfo: string[] = [
  `${PROJECT_NAME} - 客户端（骨架占位）`,
  `逻辑帧率           : ${GAME_TICK_RATE} Hz`,
  `客户端插值延迟     : ${CLIENT_INTERPOLATION_DELAY_MS} ms`,
  "渲染引擎           : 原型阶段确定（Three.js / Babylon.js / PlayCanvas）",
  "连接地址           : 由 src/net/connection.ts 读取环境变量后建立",
];

console.log("=========================================================");
for (const line of placeholderInfo) {
  console.log(` ${line}`);
}
console.log("---------------------------------------------------------");
console.log(" 待实现位置：");
console.log("   - src/net/connection.ts   ：Colyseus 客户端连接与重连");
console.log("   - src/net/state-sync.ts   ：状态订阅与快照缓冲");
console.log("   - src/input/keyboard-mouse.ts ：输入采集");
console.log("   - src/scenes/battle-scene.ts  ：战斗场景与实体渲染");
console.log("   - src/ui/hud.ts           ：HUD 与计分板");
console.log("=========================================================");
