/**
 * 人形化身模型测试（批次 A2）。
 *
 * 这一组用例是「三条线同源」的护栏：判定体（`PLAYER_HITBOXES`）、第三人称外观
 * （`avatar-model.ts`）、第一人称视模型必须引用同一批数字。任何一处手写第二套尺寸都会红。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as THREE from "three";

import {
  PLAYER_HEIGHT,
  PLAYER_HITBOXES,
  WEAPON_SLOTS,
  type HitCylinder,
  type HitZone,
} from "@colyseus-fps/shared";

import {
  AVATAR_DECOR,
  AVATAR_PALETTE,
  AVATAR_PARTS,
  AvatarModel,
  FALL_PIVOT_Y,
  FOREARM_WIDTH,
  HEAD_CENTER_Y,
  HEAD_RADIUS,
  HELMET_CENTER_Y,
  HELMET_HEIGHT,
  SHOULDER_Y,
  TORSO_CENTER_Y,
  TORSO_WIDTH,
  UPPER_ARM_WIDTH,
  avatarMaterials,
  buildAvatarModel,
  disposeAvatarMaterials,
} from "../src/game/avatar-model.js";

function zoneOf(zone: HitZone): HitCylinder {
  const found = PLAYER_HITBOXES.find((box) => box.zone === zone);
  assert.ok(found !== undefined, `PLAYER_HITBOXES 缺少 ${zone}`);
  return found;
}

describe("尺寸与判定体同源", () => {
  it("13 项部件全部存在（拆开后 16 个 mesh）", () => {
    const model = buildAvatarModel("T");
    try {
      assert.equal(AVATAR_PARTS.length, 16, "AVATAR_PARTS 应为 16 条 mesh 规格");
      assert.equal(model.parts.size, 16, "实际建出的 mesh 数应等于规格数");
      // 规格 2.2 的 13 行必须全部覆盖
      const required = [
        "head",
        "helmet",
        "visor",
        "torso",
        "pelvis",
        "backpack",
        "upperArmL",
        "foreArmL",
        "upperArmR",
        "foreArmR",
        "thighL",
        "thighR",
        "shinL",
        "shinR",
        "footL",
        "footR",
      ];
      for (const name of required) {
        assert.ok(model.parts.has(name), `缺少部件 ${name}`);
      }
    } finally {
      model.dispose();
    }
  });

  it("视觉总高必须正好等于 PLAYER_HEIGHT（1.80m）", () => {
    const model = buildAvatarModel("CT");
    try {
      assert.ok(Math.abs(model.totalHeight - PLAYER_HEIGHT) < 1e-9, `总高 ${model.totalHeight}`);
      assert.equal(model.totalHeight, 1.8);
    } finally {
      model.dispose();
    }
  });

  it("头球下沿必须 ≥ 头部判定段下沿（1.63m），不能把下巴画进胸段", () => {
    const head = zoneOf("head");
    const headBottom = HEAD_CENTER_Y - HEAD_RADIUS;
    assert.ok(headBottom >= head.yMin - 1e-9, `头球下沿 ${headBottom} 低于判定段 ${head.yMin}`);
    assert.ok(Math.abs(headBottom - head.yMin) < 1e-9, "头球下沿应与判定段下沿对齐");
    assert.equal(Math.round(headBottom * 1000) / 1000, 1.63);
  });

  it("模型必须比判定体窄（判定体容错 1–3cm/侧，不能反过来）", () => {
    const chest = zoneOf("chest");
    const head = zoneOf("head");
    const leg = zoneOf("leg");
    assert.ok(TORSO_WIDTH / 2 < chest.radius, "躯干半宽必须小于胸段判定半径");
    assert.ok(HEAD_RADIUS < head.radius, "头球半径必须小于头部判定半径");
    // 肩宽（含臂）：臂外沿 = ARM_X + UPPER_ARM_WIDTH/2
    const armZone = PLAYER_HITBOXES.find((box) => box.zone === "arm" && box.offsetRight > 0)!;
    const shoulderOuter = armZone.offsetRight + UPPER_ARM_WIDTH / 2;
    assert.ok(shoulderOuter < armZone.radius + armZone.offsetRight, "臂外沿不能超出判定体外沿");
    assert.ok(leg.radius > 0);
  });

  it("脚底必须落在 y = 0（不悬空、不陷地）", () => {
    const model = buildAvatarModel("T");
    try {
      model.root.updateMatrixWorld(true);
      const foot = model.parts.get("footL")!;
      const world = new THREE.Vector3();
      foot.getWorldPosition(world);
      const bottom = world.y - 0.07 / 2;
      assert.ok(Math.abs(bottom) < 1e-6, `左脚底应在 y=0，实际 ${bottom}`);
    } finally {
      model.dispose();
    }
  });

  it("头盔顶面与头顶都必须压在 1.80m", () => {
    assert.ok(Math.abs(HELMET_CENTER_Y + HELMET_HEIGHT / 2 - PLAYER_HEIGHT) < 1e-9);
    assert.ok(Math.abs(HEAD_CENTER_Y + HEAD_RADIUS - PLAYER_HEIGHT) < 1e-9);
  });

  it("武器挂点必须挂在右手下方、且 rotation.y = π（规格 2.4）", () => {
    const model = buildAvatarModel("T");
    try {
      assert.ok(Math.abs(model.handAnchor.rotation.y - Math.PI) < 1e-9);
      const parent = model.handAnchor.parent;
      assert.ok(parent !== null, "挂点必须有父节点（右前臂下的肘枢轴）");
      // 手部必须比肩低（下垂持枪位）
      assert.ok(Math.abs(SHOULDER_Y - 1.5) < 0.02);
      model.root.updateMatrixWorld(true);
      const hand = new THREE.Vector3();
      model.handAnchor.getWorldPosition(hand);
      assert.ok(hand.y < SHOULDER_Y, `手部高度 ${hand.y.toFixed(2)} 应低于肩 ${SHOULDER_Y}`);
      assert.ok(Math.abs(hand.y - 1.12) < 0.02, `手部高度应约 1.12，实际 ${hand.y}`);
      assert.ok(Math.abs(hand.x - 0.24) < 0.02, `右手应在 x≈0.24，实际 ${hand.x}`);
      assert.ok(Math.abs(hand.z + 0.2) < 0.02, `右手应在 z≈−0.20，实际 ${hand.z}`);
      assert.ok(Math.abs(TORSO_CENTER_Y - 1.385) < 1e-9);
    } finally {
      model.dispose();
    }
  });
});

describe("队伍配色与材质共享", () => {
  it("T / CT 的布色与装具色必须不同（两队可辨识）", () => {
    assert.notEqual(AVATAR_PALETTE.T.cloth, AVATAR_PALETTE.CT.cloth);
    assert.notEqual(AVATAR_PALETTE.T.gear, AVATAR_PALETTE.CT.gear);
    // 肤色与面罩色允许相同（真实世界就是这样）
    assert.equal(AVATAR_PALETTE.T.skin, AVATAR_PALETTE.CT.skin);
  });

  it("同队两次构建必须共用同一批材质实例（每队 8 个，不能每 avatar new 一套）", () => {
    const first = buildAvatarModel("T");
    const second = buildAvatarModel("T");
    const otherTeam = buildAvatarModel("CT");
    try {
      const materials = avatarMaterials("T");
      assert.equal(first.materials.cloth, materials.cloth);
      assert.equal(second.materials.cloth, materials.cloth);
      assert.equal(first.materials.gear, second.materials.gear);
      // 队伍之间必须不同实例
      assert.notEqual(first.materials.cloth, otherTeam.materials.cloth);
      // 每队 8 个材质：布料 / 皮肤 / 装具 / 深色 / 牛仔 / 靴 / 识别色 / 刀身
      assert.equal(Object.keys(materials).length, 8);
      // 部件真的用了共享材质
      const torso = first.parts.get("torso")!;
      const torsoMaterial = torso.material as THREE.MeshStandardMaterial;
      assert.equal(torsoMaterial, materials.cloth);
    } finally {
      first.dispose();
      second.dispose();
      otherTeam.dispose();
    }
  });
});

describe("手持武器", () => {
  it("6 个槽位各一组武器，同一切换时刻只有一组 visible", () => {
    const model = new AvatarModel("T");
    try {
      assert.equal(model.weaponGroups.length, 6);
      for (let slot = 0; slot < 6; slot += 1) {
        model.setWeaponSlot(slot);
        assert.equal(model.weaponSlot, slot);
        for (let i = 0; i < 6; i += 1) {
          assert.equal(model.weaponGroups[i]!.visible, i === slot, `slot ${slot} 时第 ${i} 组 visible 不对`);
        }
      }
      // 越界钳制
      model.setWeaponSlot(99);
      assert.equal(model.weaponSlot, 5);
      model.setWeaponSlot(-3);
      assert.equal(model.weaponSlot, 0);
      assert.equal(WEAPON_SLOTS.KNIFE, 2);
    } finally {
      model.dispose();
    }
  });

  it("每组武器都挂在 handAnchor 下（跟着手臂摆动一起动）", () => {
    const model = buildAvatarModel("CT");
    try {
      const mount = model.handAnchor.children[0];
      assert.ok(mount !== undefined, "handAnchor 下应有 weaponMount");
      for (const group of model.weaponGroups) {
        assert.equal(group.parent, mount);
      }
    } finally {
      model.dispose();
    }
  });
});

describe("动画骨骼", () => {
  it("行走摆动：腿/臂反相、小腿只向后屈、躯干上下 2cm", () => {
    const model = buildAvatarModel("T");
    try {
      const phase = Math.PI / 2;
      model.poseLocomotion(phase, 1);
      const { hipL, hipR, kneeL, shoulderL, shoulderR, torsoPivot } = model.rig;

      assert.ok(hipL.rotation.x > 0.5, "左腿在相位 π/2 应向前摆满");
      assert.ok(hipR.rotation.x < -0.5, "右腿必须反相");
      assert.ok(Math.abs(hipL.rotation.x + hipR.rotation.x) < 1e-9, "两腿幅度必须对称");
      assert.ok(kneeL.rotation.x <= 0, "小腿只能向后屈（负值）");
      assert.ok(shoulderL.rotation.x < 0, "左臂与左腿反相");
      assert.ok(Math.abs(shoulderR.rotation.x) < Math.abs(shoulderL.rotation.x), "持枪手幅度更小");
      assert.ok(Math.abs(torsoPivot.position.y - (1.05 + 0)) < 0.03, "躯干上下幅度 ≤ 2cm");

      // amp = 0 时全部归零（站立姿态）
      model.poseLocomotion(phase, 0);
      assert.equal(hipL.rotation.x, 0);
      assert.equal(shoulderR.rotation.x, 0);
    } finally {
      model.dispose();
    }
  });

  it("倒地：绕局部 X 轴 +90°，枢轴离地 0.13m，复位后站直", () => {
    const model = buildAvatarModel("T");
    try {
      model.poseFall(1);
      assert.ok(Math.abs(model.rig.fallPivot.rotation.x - Math.PI / 2) < 1e-9);
      assert.ok(Math.abs(model.rig.fallPivot.position.y - FALL_PIVOT_Y) < 1e-9);
      assert.equal(FALL_PIVOT_Y, 0.13);

      model.poseFall(0.5);
      assert.ok(model.rig.fallPivot.rotation.x < Math.PI / 2, "中途应处于倒下过程");
      assert.ok(model.rig.fallPivot.position.y > FALL_PIVOT_Y, "中途有 3cm 的膝盖发软补偿");

      model.resetFall();
      assert.equal(model.rig.fallPivot.rotation.x, 0);
      assert.ok(Math.abs(model.rig.fallPivot.position.y - FALL_PIVOT_Y) < 1e-9);
      assert.equal(model.rig.hipL.rotation.x, 0);
    } finally {
      model.dispose();
    }
  });

  it("前臂宽度必须小于上臂（比例来自判定体同一份半径）", () => {
    assert.ok(FOREARM_WIDTH < UPPER_ARM_WIDTH);
    assert.ok(UPPER_ARM_WIDTH < TORSO_WIDTH);
  });
});

describe("材质释放", () => {
  it("disposeAvatarMaterials 后可重新构建（缓存已清空）", () => {
    const before = avatarMaterials("T");
    disposeAvatarMaterials();
    const after = avatarMaterials("T");
    assert.notEqual(after, before, "缓存应被清空并重建");
    disposeAvatarMaterials();
  });
});

describe("装饰件（参考图细节）", () => {
  it("装饰件必须全部实例化，且一律挂在骨骼组上", () => {
    const model = buildAvatarModel("CT");
    try {
      const attached: THREE.Object3D[] = [];
      model.root.traverse((object) => {
        if (object.name.startsWith("decor-")) {
          attached.push(object);
        }
      });
      assert.equal(attached.length, AVATAR_DECOR.length, "装饰件数量必须与 AVATAR_DECOR 一致");
      const torsoCount = AVATAR_DECOR.filter((decor) => decor.parent === "torso").length;
      const thighCount = AVATAR_DECOR.length - torsoCount;
      assert.equal(
        attached.filter((object) => object.name === "decor-torso").length,
        torsoCount,
      );
      assert.equal(
        attached.filter((object) => object.name === "decor-thighR").length,
        thighCount,
      );
    } finally {
      model.dispose();
    }
  });

  it("装饰件不得进入 parts 表（不参与判定，也不改总高）", () => {
    const model = buildAvatarModel("CT");
    try {
      assert.equal(model.parts.size, 16);
      for (const name of model.parts.keys()) {
        assert.ok(!name.startsWith("decor-"), `${name} 不该是判定部件`);
      }
      // 总高仍然由判定体推导的结果决定
      assert.ok(Math.abs(model.totalHeight - PLAYER_HEIGHT) < 1e-9);
    } finally {
      model.dispose();
    }
  });

  it("战术背心 / 枪套这类体积件不能反过来撑宽判定宽度（必须比躯干窄）", () => {
    for (const decor of AVATAR_DECOR) {
      if (decor.parent === "torso") {
        assert.ok(decor.size.x <= TORSO_WIDTH, `${JSON.stringify(decor.pos)} 的装饰件比躯干还宽`);
      }
    }
  });
});
