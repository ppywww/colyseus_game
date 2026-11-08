/**
 * 视模型姿态与动画曲线单测（纯函数，不启动渲染器）。
 *
 * 守住的四条底线（对应参考文档 2.3 / 2.5 的可量化判据）：
 *   1. 静态姿态：枪根旋转必须包含 7.4° 的右滚（z = 0.13），否则"枪身斜置"永远出不来；
 *   2. idle：呼吸位移 ≤ 5mm、角度 ≤ 0.35°，超出会让准心跟着"呼吸"；
 *   3. walk：摆幅必须按 τ=120ms 淡入淡出，停走瞬间不能突变（否则枪会跳一下）；
 *   4. fire：后退 45mm + 上跳 3.15°，且只动视模型（相机后坐由 game.ts 的 shake 独立负责）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as THREE from "three";

import { THROW_COOLDOWN_MS } from "@colyseus-fps/shared";

import {
  VIEWMODEL_BASE_POSITION,
  VIEWMODEL_BASE_ROTATION,
  VIEWMODEL_MUZZLE_LOCAL,
  advanceBobAmp,
  advanceBobPhase,
  computeReloadChargeOffset,
  computeReloadMagazineOffset,
  computeViewmodelPose,
  smoothstep,
  type ViewmodelPoseState,
} from "../src/game/viewmodel.js";

const RAD_TO_DEG = 180 / Math.PI;

/** 主相机 FOV 与 16:9 基准宽高比（构图判据的标定基准）。 */
const CAMERA_FOV = 80;
const CAMERA_ASPECT = 16 / 9;

/**
 * 把一个「相对枪根」的局部坐标投影成屏幕百分比坐标（x/y ∈ 0–100）。
 * 公式与参考文档 2.3.2 完全一致，用于验证「枪根 70%/84%、枪口 57%/60%」等构图判据。
 */
function projectToScreen(local: { x: number; y: number; z: number }): { x: number; y: number } {
  const holder = new THREE.Group();
  holder.position.set(VIEWMODEL_BASE_POSITION.x, VIEWMODEL_BASE_POSITION.y, VIEWMODEL_BASE_POSITION.z);
  holder.rotation.set(VIEWMODEL_BASE_ROTATION.x, VIEWMODEL_BASE_ROTATION.y, VIEWMODEL_BASE_ROTATION.z);
  holder.updateMatrix();

  const world = new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(holder.matrix);
  const tanV = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  const tanH = tanV * CAMERA_ASPECT;
  return {
    x: (0.5 + (world.x / (-world.z * tanH)) * 0.5) * 100,
    y: (0.5 - (world.y / (-world.z * tanV)) * 0.5) * 100,
  };
}

/** 静止基准姿态（无 bob、无后坐、未换弹、未投掷）。 */
function restState(overrides: Partial<ViewmodelPoseState> = {}): ViewmodelPoseState {
  return {
    moving: false,
    grounded: true,
    reloadProgress: 0,
    throwProgress: 0,
    bobPhase: 0,
    bobAmp: 0,
    recoilPos: 0,
    recoilRot: 0,
    recoilRoll: 0,
    landing: 0,
    ...overrides,
  };
}

describe("静态持枪构图", () => {
  it("枪根位置应为 (0.2387, −0.228, −0.400)", () => {
    const pose = computeViewmodelPose(restState(), 0);
    assert.ok(Math.abs(pose.position.x - 0.2387) < 1e-9);
    assert.ok(Math.abs(pose.position.y + 0.228) < 1e-9);
    assert.ok(Math.abs(pose.position.z + 0.4) < 1e-9);
  });

  it("基础旋转必须非零，且右滚约 7.4°（这是枪身斜置的唯一来源）", () => {
    const pose = computeViewmodelPose(restState(), 0);
    assert.ok(pose.rotation.x !== 0 && pose.rotation.y !== 0 && pose.rotation.z !== 0, "基础旋转不应为 0");

    // 允许 idle 呼吸带来的 ±0.006 rad 波动
    assert.ok(Math.abs(pose.rotation.z - 0.13) < 0.01, `roll 应约 0.13 rad，实际 ${pose.rotation.z}`);
    const rollDeg = (pose.rotation.z * RAD_TO_DEG);
    assert.ok(rollDeg > 6.5 && rollDeg < 8.5, `右滚应落在 7–8°，实际 ${rollDeg.toFixed(2)}°`);
    assert.ok(Math.abs(pose.rotation.x - 0.05) < 0.005, "枪口应微抬约 2.9°");
    assert.ok(Math.abs(pose.rotation.y - 0.05) < 0.005, "枪口应微左约 2.9°");
  });

  it("导出常量应与文档一致（BASE_POSITION / BASE_ROTATION）", () => {
    assert.equal(VIEWMODEL_BASE_POSITION.x, 0.2387);
    assert.equal(VIEWMODEL_BASE_POSITION.y, -0.228);
    assert.equal(VIEWMODEL_BASE_POSITION.z, -0.4);
    assert.equal(VIEWMODEL_BASE_ROTATION.z, 0.13);
  });
});

describe("idle 呼吸", () => {
  it("垂直位移应在 ±4mm 内往返，水平位移 ≤ ±2.5mm", () => {
    let maxDy = 0;
    let maxDx = 0;
    for (let i = 0; i <= 200; i += 1) {
      const t = (i / 200) * 4; // 覆盖一个完整 4s 周期
      const pose = computeViewmodelPose(restState(), t);
      maxDy = Math.max(maxDy, Math.abs(pose.position.y - VIEWMODEL_BASE_POSITION.y));
      maxDx = Math.max(maxDx, Math.abs(pose.position.x - VIEWMODEL_BASE_POSITION.x));
    }
    assert.ok(maxDy > 0.0035 && maxDy <= 0.0041, `呼吸幅度应约 ±4mm，实际 ${maxDy.toFixed(4)}`);
    assert.ok(maxDx > 0.002 && maxDx <= 0.0026, `水平呼吸应约 ±2.5mm，实际 ${maxDx.toFixed(4)}`);
  });

  it("呼吸角度必须 ≤ 0.35°（否则准心会跟着晃）", () => {
    let maxDelta = 0;
    for (let i = 0; i <= 200; i += 1) {
      const t = (i / 200) * 4;
      const pose = computeViewmodelPose(restState(), t);
      maxDelta = Math.max(
        maxDelta,
        Math.abs(pose.rotation.x - VIEWMODEL_BASE_ROTATION.x),
        Math.abs(pose.rotation.z - VIEWMODEL_BASE_ROTATION.z),
      );
    }
    assert.ok(maxDelta * RAD_TO_DEG <= 0.35, `呼吸角度过大：${(maxDelta * RAD_TO_DEG).toFixed(2)}°`);
  });
});

describe("walk 摆幅淡入", () => {
  it("摆幅按 τ=120ms 淡入：单帧不会突变，1s 后趋近满幅", () => {
    const dt = 1 / 60;
    const firstFrame = advanceBobAmp(0, true, dt);
    assert.ok(firstFrame > 0 && firstFrame < 0.2, `单帧摆幅应很小，实际 ${firstFrame.toFixed(3)}`);

    let amp = 0;
    for (let i = 0; i < 120; i += 1) {
      amp = advanceBobAmp(amp, true, dt);
    }
    assert.ok(amp > 0.99, `2 秒后应接近满幅，实际 ${amp.toFixed(3)}`);
  });

  it("停走时摆幅不会瞬间归零（避免停走瞬间跳枪）", () => {
    const stopped = advanceBobAmp(1, false, 1 / 60);
    assert.ok(stopped > 0.8 && stopped < 1, `停走一帧后仍应保留大部分摆幅，实际 ${stopped.toFixed(3)}`);
  });

  it("满幅摆动的水平位移应约 ±10mm，且与静止姿态连续", () => {
    const moving = computeViewmodelPose(restState({ bobPhase: Math.PI / 2, bobAmp: 1 }), 0);
    const still = computeViewmodelPose(restState({ bobPhase: Math.PI / 2, bobAmp: 0 }), 0);
    const delta = Math.abs(moving.position.x - still.position.x);
    assert.ok(delta > 0.0095 && delta <= 0.0101, `水平摆幅应约 10mm，实际 ${delta.toFixed(4)}`);
  });

  it("停下后相位不再推进", () => {
    const phase = advanceBobPhase(1.2, false, false, 1 / 60);
    assert.equal(phase, 1.2);
    assert.ok(advanceBobPhase(1.2, true, false, 1 / 60) > 1.2);
    assert.ok(advanceBobPhase(1.2, true, true, 1 / 60) > advanceBobPhase(1.2, true, false, 1 / 60));
  });
});

describe("fire 后坐", () => {
  it("后退 45mm + 枪口上跳 3.15°", () => {
    const base = computeViewmodelPose(restState(), 0);
    const fired = computeViewmodelPose(restState({ recoilPos: 0.045, recoilRot: 0.055 }), 0);

    assert.ok(Math.abs(fired.position.z - base.position.z - 0.045) < 1e-9, "应沿 +Z 后退 45mm");
    assert.ok(Math.abs(fired.rotation.x - base.rotation.x - 0.055) < 1e-9);
    const pitchDeg = (fired.rotation.x - base.rotation.x) * RAD_TO_DEG;
    assert.ok(Math.abs(pitchDeg - 3.15) < 0.05, `枪口上跳应约 3.15°，实际 ${pitchDeg.toFixed(2)}°`);
  });

  it("随机滚转只影响 roll，不影响 pitch", () => {
    const base = computeViewmodelPose(restState(), 0);
    const rolled = computeViewmodelPose(restState({ recoilRoll: 0.012 }), 0);
    assert.ok(Math.abs(rolled.rotation.z - base.rotation.z - 0.012) < 1e-9);
    assert.ok(Math.abs(rolled.rotation.x - base.rotation.x) < 1e-9);
  });
});

describe("reload 关键帧", () => {
  it("下压阶段枪口下垂 17°、枪身右倾 31.5°、下沉 10cm（p = 0.3）", () => {
    const base = computeViewmodelPose(restState(), 0);
    const reloading = computeViewmodelPose(restState({ reloadProgress: 0.3 }), 0);

    const pitchDeg = (reloading.rotation.x - base.rotation.x) * RAD_TO_DEG;
    const rollDeg = (reloading.rotation.z - base.rotation.z) * RAD_TO_DEG;
    assert.ok(pitchDeg < -16 && pitchDeg > -18, `枪口应下垂约 17°，实际 ${pitchDeg.toFixed(2)}°`);
    assert.ok(rollDeg > 30 && rollDeg < 33, `枪身应右倾约 31.5°，实际 ${rollDeg.toFixed(2)}°`);
    assert.ok(reloading.position.y < base.position.y - 0.09, "枪身应下沉约 10cm");
  });

  it("进度回到 1.0 时姿态完全归零（不会停在换弹姿势）", () => {
    const base = computeViewmodelPose(restState(), 0);
    const finished = computeViewmodelPose(restState({ reloadProgress: 1 }), 0);
    assert.ok(Math.abs(finished.position.y - base.position.y) < 1e-9);
    assert.ok(Math.abs(finished.rotation.x - base.rotation.x) < 1e-9);
    assert.ok(Math.abs(finished.rotation.z - base.rotation.z) < 1e-9);
  });

  it("弹匣先下坠 16cm 再回到原位，拉机柄后拉 40mm 后回位", () => {
    const rest = computeReloadMagazineOffset(0);
    const dropped = computeReloadMagazineOffset(0.35);
    const inserted = computeReloadMagazineOffset(0.55);
    assert.ok(Math.abs(dropped.y - (rest.y - 0.16)) < 0.005, `弹匣应下坠 16cm，实际 ${dropped.y}`);
    assert.ok(dropped.rotX < rest.rotX, "卸弹匣时应继续外翻");
    assert.ok(Math.abs(inserted.y - rest.y) < 0.005, "插回后应回到原位");
    assert.ok(Math.abs(inserted.rotX - rest.rotX) < 1e-9);

    assert.equal(computeReloadChargeOffset(0.5), 0, "拉机柄在回抬阶段之前不动");
    assert.ok(computeReloadChargeOffset(0.67) > 0.035, "拉机柄应被后拉约 40mm");
    assert.equal(computeReloadChargeOffset(0.9), 0, "收尾阶段拉机柄应已回位");
  });
});

describe("throw 投掷", () => {
  it("甩出阶段枪身向左下甩（dx −0.10 / dy −0.12 / roll −0.35 / pitch +0.30）", () => {
    const base = computeViewmodelPose(restState(), 0);
    const throwing = computeViewmodelPose(restState({ throwProgress: 240 / THROW_COOLDOWN_MS }), 0);

    assert.ok(Math.abs(throwing.position.x - base.position.x + 0.1) < 1e-6, "应向左 10cm");
    assert.ok(Math.abs(throwing.position.y - base.position.y + 0.12) < 1e-6, "应向下 12cm");
    assert.ok(Math.abs(throwing.position.z - base.position.z - 0.05) < 1e-6, "应向后 5cm");
    assert.ok(Math.abs(throwing.rotation.z - base.rotation.z + 0.35) < 1e-6);
    assert.ok(Math.abs(throwing.rotation.x - base.rotation.x - 0.3) < 1e-6);
  });

  it("700ms 后必须回到静止姿态", () => {
    const base = computeViewmodelPose(restState(), 0);
    const finished = computeViewmodelPose(restState({ throwProgress: 1 }), 0);
    assert.ok(Math.abs(finished.position.x - base.position.x) < 1e-9);
    assert.ok(Math.abs(finished.position.y - base.position.y) < 1e-9);
    assert.ok(Math.abs(finished.rotation.z - base.rotation.z) < 1e-9);
  });
});

describe("工具函数", () => {
  it("smoothstep 应把输入钳制到 [0,1] 并保持首尾端点", () => {
    assert.equal(smoothstep(-1), 0);
    assert.equal(smoothstep(0), 0);
    assert.equal(smoothstep(1), 1);
    assert.equal(smoothstep(2), 1);
    assert.ok(Math.abs(smoothstep(0.5) - 0.5) < 1e-9);
  });

  it("落地冲击只叠加垂直位移，不影响角度", () => {
    const base = computeViewmodelPose(restState(), 0);
    const landed = computeViewmodelPose(restState({ landing: -0.02 }), 0);
    assert.ok(Math.abs(landed.position.y - base.position.y + 0.02) < 1e-9);
    assert.ok(Math.abs(landed.rotation.x - base.rotation.x) < 1e-9);
  });
});

describe("屏幕构图判据（16:9 / fov 80）", () => {
  it("判据①：枪根应落在屏幕右下 70% / 84%（允许 ±2%）", () => {
    const root = projectToScreen({ x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(root.x - 70) <= 2, `枪根横向应约 70%，实际 ${root.x.toFixed(1)}%`);
    assert.ok(Math.abs(root.y - 84) <= 2, `枪根纵向应约 84%，实际 ${root.y.toFixed(1)}%`);
  });

  it("判据②：枪口应在中线右侧、画面中线略下方（54–59% / 57–63%）", () => {
    const muzzle = projectToScreen(VIEWMODEL_MUZZLE_LOCAL);
    assert.ok(muzzle.x > 54 && muzzle.x < 59, `枪口横向应 54–59%，实际 ${muzzle.x.toFixed(1)}%`);
    assert.ok(muzzle.y > 57 && muzzle.y < 63, `枪口纵向应 57–63%，实际 ${muzzle.y.toFixed(1)}%`);
  });

  it("判据③：枪管轴线延长线必须在 y=50% 处穿过准心附近（48–52%）", () => {
    const root = projectToScreen({ x: 0, y: 0, z: 0 });
    const muzzle = projectToScreen(VIEWMODEL_MUZZLE_LOCAL);
    // 过枪根与枪口的直线，在 y = 50% 时的横坐标
    const slope = (muzzle.x - root.x) / (muzzle.y - root.y);
    const atCenterY = muzzle.x + slope * (50 - muzzle.y);
    assert.ok(atCenterY > 48 && atCenterY < 52, `延长线应穿过准心，实际 ${atCenterY.toFixed(1)}%`);
  });
});
