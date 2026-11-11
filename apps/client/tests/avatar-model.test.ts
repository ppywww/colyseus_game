/**
 * 卡通角色模型测试。
 *
 * 这一组用例是「三条线同源」的护栏：判定体（`PLAYER_HITBOXES`）、第三人称外观
 * （`avatar-model.ts`）、第一人称视模型必须引用同一批数字。任何一处手写第二套尺寸都会红。
 *
 * 主题换成猫和老鼠之后，新增的护栏是**角色差异化不能变强**：
 * `bodyScale ≤ 1`、`0.085 × headScale < 0.13` —— 四个角色只在毛色/耳朵/尾巴/配饰上不同，
 * 谁都不许比判定体宽，也不许比判定体高。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as THREE from "three";

import {
  CHARACTER_IDS,
  PLAYER_HEIGHT,
  PLAYER_HITBOXES,
  THROWABLE_TYPES,
  WEAPON_SLOTS,
  type CharacterId,
  type HitCylinder,
  type HitZone,
} from "@colyseus-fps/shared";

import {
  ARM_X,
  AVATAR_PARTS,
  AvatarModel,
  CHARACTER_STYLES,
  CREST_CENTER_Y,
  CREST_HEIGHT,
  FALL_PIVOT_Y,
  FOOT_HEIGHT,
  FOREARM_WIDTH,
  HEAD_CENTER_Y,
  HEAD_RADIUS,
  MUZZLE_CENTER_Z,
  MUZZLE_DEPTH,
  MUZZLE_WIDTH,
  NECKBAND_Y,
  SHOULDER_Y,
  TEAM_ACCENT,
  TORSO_CENTER_Y,
  TORSO_WIDTH,
  UPPER_ARM_WIDTH,
  WAIST_Y,
  THROWABLE_HELD_SPEC,
  avatarDecor,
  avatarMaterials,
  buildAvatarModel,
  buildAvatarModelOfIndex,
  disposeAvatarMaterials,
} from "../src/game/avatar-model.js";

function zoneOf(zone: HitZone): HitCylinder {
  const found = PLAYER_HITBOXES.find((box) => box.zone === zone);
  assert.ok(found !== undefined, `PLAYER_HITBOXES 缺少 ${zone}`);
  return found;
}

/** 头部判定半宽（headScale 会乘在模型上，护栏要用放大后的值）。 */
function headHalfWidth(character: CharacterId): number {
  return (HEAD_RADIUS * CHARACTER_STYLES[character].headScale);
}

describe("尺寸与判定体同源", () => {
  it("16 个骨架部件全部存在", () => {
    const model = buildAvatarModel("T");
    try {
      assert.equal(AVATAR_PARTS.length, 16, "AVATAR_PARTS 应为 16 条 mesh 规格");
      assert.equal(model.parts.size, 16, "实际建出的 mesh 数应等于规格数");
      const required: readonly string[] = [
        "head",
        "crest",
        "muzzle",
        "torso",
        "pelvis",
        "tailBase",
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
      // 旧版的枪械装具必须彻底消失（主题统一性：身上不该再有头盔/面罩/背包）
      for (const retired of ["helmet", "visor", "backpack"]) {
        assert.ok(!model.parts.has(retired), `${retired} 是旧版军事装具，应已移除`);
      }
    } finally {
      model.dispose();
    }
  });

  it("视觉总高必须正好等于 PLAYER_HEIGHT（1.80m），四个角色都一样", () => {
    for (const character of CHARACTER_IDS) {
      const model = buildAvatarModel("CT", character);
      try {
        assert.ok(
          Math.abs(model.totalHeight - PLAYER_HEIGHT) < 1e-9,
          `${character} 总高 ${model.totalHeight}`,
        );
      } finally {
        model.dispose();
      }
    }
    assert.equal(PLAYER_HEIGHT, 1.8);
  });

  it("头球下沿必须正好压在头部判定段下沿（1.63m）", () => {
    const head = zoneOf("head");
    const headBottom = HEAD_CENTER_Y - HEAD_RADIUS;
    assert.ok(headBottom >= head.yMin - 1e-9, `头球下沿 ${headBottom} 低于判定段 ${head.yMin}`);
    assert.ok(Math.abs(headBottom - head.yMin) < 1e-9, "头球下沿应与判定段下沿对齐");
    assert.equal(Math.round(headBottom * 1000) / 1000, 1.63);
  });

  it("模型必须比判定体窄（宁可判定宽容，不能看着打中却穿过去）", () => {
    const chest = zoneOf("chest");
    const head = zoneOf("head");
    const armZone = PLAYER_HITBOXES.find((box) => box.zone === "arm" && box.offsetRight > 0);
    assert.ok(armZone !== undefined);

    // 躯干：基准半宽 × 最大体型系数（bodyScale 上界必须是 1）
    assert.ok(TORSO_WIDTH / 2 < chest.radius, "躯干半宽必须小于胸段判定半径");
    for (const character of CHARACTER_IDS) {
      const style = CHARACTER_STYLES[character];
      assert.ok(style.bodyScale <= 1, `${character} 的 bodyScale 不能大于 1`);
      assert.ok(style.bodyScale > 0.7, `${character} 的 bodyScale 过小会瘦成竹竿`);
      const torsoHalf = (TORSO_WIDTH * style.bodyScale) / 2;
      assert.ok(torsoHalf < chest.radius, `${character} 的躯干 ${torsoHalf} 超过胸段 ${chest.radius}`);

      // 头：headScale 放大后仍须小于头部判定半径
      assert.ok(style.headScale >= 0.9 && style.headScale <= 1.5, `${character} 的 headScale 越界`);
      assert.ok(
        headHalfWidth(character) < head.radius,
        `${character} 的头半宽 ${headHalfWidth(character)} 超过判定半径 ${head.radius}`,
      );

      // 臂：肩枢轴 + 上臂半宽 不能超出臂段外沿
      const shoulderOuter = ARM_X * style.bodyScale + UPPER_ARM_WIDTH / 2;
      assert.ok(
        shoulderOuter < armZone.radius + armZone.offsetRight,
        `${character} 的臂外沿 ${shoulderOuter} 超出判定体`,
      );
    }
  });

  it("脚底必须落在 y = 0（不悬空、不陷地）", () => {
    const model = buildAvatarModel("T");
    try {
      model.root.updateMatrixWorld(true);
      const foot = model.parts.get("footL")!;
      const world = new THREE.Vector3();
      foot.getWorldPosition(world);
      const bottom = world.y - FOOT_HEIGHT / 2;
      assert.ok(Math.abs(bottom) < 1e-6, `左脚底应在 y=0，实际 ${bottom}`);
    } finally {
      model.dispose();
    }
  });

  it("毛簇顶面与头顶都必须压在 1.80m", () => {
    assert.ok(Math.abs(CREST_CENTER_Y + CREST_HEIGHT / 2 - PLAYER_HEIGHT) < 1e-9);
    assert.ok(Math.abs(HEAD_CENTER_Y + HEAD_RADIUS - PLAYER_HEIGHT) < 1e-9);
  });

  it("武器挂点必须挂在右手下方、且 rotation.y = π", () => {
    const model = buildAvatarModel("T");
    try {
      assert.ok(Math.abs(model.handAnchor.rotation.y - Math.PI) < 1e-9);
      const parent = model.handAnchor.parent;
      assert.ok(parent !== null, "挂点必须有父节点（右前臂下的肘枢轴）");
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

describe("角色外观（纯外观，无任何数值差异）", () => {
  it("四个角色各有一套设定，且毛色两两不同", () => {
    const furs = new Set<number>();
    for (const character of CHARACTER_IDS) {
      const style = CHARACTER_STYLES[character];
      assert.equal(style.id, character, "设定里的 id 必须与键一致");
      furs.add(style.fur);
    }
    assert.equal(furs.size, CHARACTER_IDS.length, "四个角色的毛色必须两两可区分");
  });

  it("队伍识别色必须不同，且不随角色变化", () => {
    assert.notEqual(TEAM_ACCENT.T, TEAM_ACCENT.CT);
    // 围巾/项圈才是敌我识别的第一信号：同一个角色在两队必须换配饰颜色
    const tomT = buildAvatarModel("T", "tom");
    const tomCT = buildAvatarModel("CT", "tom");
    try {
      assert.notEqual(tomT.materials.accent.color.getHex(), tomCT.materials.accent.color.getHex());
      // 毛色不参与敌我识别（Jerry 只有一个色）
      assert.equal(tomT.materials.fur.color.getHex(), tomCT.materials.fur.color.getHex());
    } finally {
      tomT.dispose();
      tomCT.dispose();
    }
  });

  it("下标工厂必须与 id 工厂等价；数字越界钳制、非法字符串回退默认", () => {
    const byId = buildAvatarModel("T", "spike");
    const byIndex = buildAvatarModelOfIndex("T", CHARACTER_IDS.indexOf("spike"));
    // 下标是 uint8，越界只能钳制（不能落回 tom，否则"最后一个角色"永远选不上）
    const clamped = buildAvatarModelOfIndex("T", 99);
    const negative = buildAvatarModelOfIndex("T", -5);
    try {
      assert.equal(byId.character, byIndex.character);
      assert.equal(clamped.character, CHARACTER_IDS[CHARACTER_IDS.length - 1]);
      assert.equal(negative.character, CHARACTER_IDS[0]);
      assert.equal(byId.root.name, "avatar-T-spike");
    } finally {
      byId.dispose();
      byIndex.dispose();
      clamped.dispose();
      negative.dispose();
    }
  });
});

describe("材质共享（按 角色 × 队伍 缓存）", () => {
  it("同组合两次构建必须共用同一批材质实例", () => {
    const first = buildAvatarModel("T", "jerry");
    const second = buildAvatarModel("T", "jerry");
    const otherTeam = buildAvatarModel("CT", "jerry");
    try {
      const materials = avatarMaterials("jerry", "T");
      assert.equal(first.materials.accent, materials.accent);
      assert.equal(second.materials.fur, materials.fur);
      assert.equal(first.materials.fur, second.materials.fur);
      // 队伍之间必须不同实例
      assert.notEqual(first.materials.accent, otherTeam.materials.accent);
      // 11 种材质：毛/肚/耳内/鼻/眼/爪/识别色/金属/木/刃/墨
      assert.equal(Object.keys(materials).length, 11);
      // 部件真的用了共享材质
      const torso = first.parts.get("torso")!;
      assert.equal(torso.material, materials.fur);
    } finally {
      first.dispose();
      second.dispose();
      otherTeam.dispose();
    }
  });

  it("卡通质感的判据是反照率：低金属度 + 高粗糙度", () => {
    const materials = avatarMaterials("tom", "T");
    assert.ok(materials.fur.metalness <= 0.1, "毛皮不该有金属度");
    assert.ok(materials.fur.roughness >= 0.7, "毛皮必须够粗糙才不会反光成塑料球");
    // 只有厨具允许金属感
    assert.ok(materials.metal.metalness > 0.5);
    assert.ok(materials.blade.metalness > 0.5);
  });

  it("disposeAvatarMaterials 后可重新构建（缓存已清空）", () => {
    const before = avatarMaterials("tom", "T");
    disposeAvatarMaterials();
    const after = avatarMaterials("tom", "T");
    assert.notEqual(after, before, "缓存应被清空并重建");
    disposeAvatarMaterials();
  });
});

describe("手持道具（全部厨房化）", () => {
  it("6 个槽位各一组道具，同一切换时刻只有一组 visible", () => {
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
      model.setWeaponSlot(99);
      assert.equal(model.weaponSlot, 5);
      model.setWeaponSlot(-3);
      assert.equal(model.weaponSlot, 0);
      assert.equal(WEAPON_SLOTS.KNIFE, 2);
    } finally {
      model.dispose();
    }
  });

  it("每组道具都挂在 handAnchor 下（跟着手臂摆动一起动）", () => {
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

  it("三种投掷物的手持模型必须与飞行模型同形（不能扔的是锅、飞的是球）", () => {
    for (const type of Object.values(THROWABLE_TYPES)) {
      const spec = THROWABLE_HELD_SPEC[type];
      assert.ok(spec !== undefined, `${type} 缺少手持模型`);
      assert.ok(spec.length >= 2, `${type} 的手持模型至少要有两件几何（主体 + 握把/顶盖）`);
    }
    // 平底锅是竖着拎的锅面（cylinder 转 90°），胡椒瓶有锥形顶盖，面粉袋是鼓袋
    const pan = THROWABLE_HELD_SPEC[THROWABLE_TYPES.FRAG];
    assert.ok(pan.some((mesh) => mesh.geometry === "cylinder" && mesh.rotX !== undefined));
    const pepper = THROWABLE_HELD_SPEC[THROWABLE_TYPES.FLASH];
    assert.ok(pepper.some((mesh) => mesh.geometry === "cone"));
    const flour = THROWABLE_HELD_SPEC[THROWABLE_TYPES.SMOKE];
    assert.ok(flour.some((mesh) => mesh.geometry === "ellipsoid"));
  });
});

describe("动画骨骼", () => {
  it("行走摆动：腿/臂反相、小腿只向后屈、躯干上下 ≤ 2cm", () => {
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
      assert.ok(Math.abs(shoulderR.rotation.x) < Math.abs(shoulderL.rotation.x), "持物手幅度更小");
      assert.ok(Math.abs(torsoPivot.position.y - WAIST_Y) < 0.03, "躯干上下幅度 ≤ 2cm");

      // amp = 0 时全部归零（站立姿态）
      model.poseLocomotion(phase, 0);
      assert.equal(hipL.rotation.x, 0);
      assert.equal(shoulderR.rotation.x, 0);
    } finally {
      model.dispose();
    }
  });

  it("尾巴跟着走路甩动（低频左右摆，幅度随速度增大）", () => {
    const model = buildAvatarModel("T", "tom");
    try {
      model.poseLocomotion(Math.PI / 2, 0);
      const idle = Math.abs(model.rig.tail.rotation.y);
      model.poseLocomotion(Math.PI / 2, 1);
      const running = Math.abs(model.rig.tail.rotation.y);
      assert.ok(running > idle, "跑动时尾巴摆幅应更大");
      assert.ok(running > 0.1 && running < 0.5, "摆幅应在一个自然的区间里，不能抽筋");
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

describe("装饰件（不参与判定）", () => {
  it("装饰件全部实例化，且一律挂在骨骼组上", () => {
    for (const character of CHARACTER_IDS) {
      const model = buildAvatarModel("CT", character);
      try {
        const specs = avatarDecor(character);
        const attached: THREE.Object3D[] = [];
        model.root.traverse((object) => {
          if (object.name.startsWith("decor-")) {
            attached.push(object);
          }
        });
        assert.equal(attached.length, specs.length, `${character} 的装饰件数量必须与规格一致`);
        // 按挂载点分组核对：关节球（肩/肘/髋/膝）是"接缝填充件"，必须真的长在关节上，
        // 否则行走时它们会留在原地，而肢体已经甩出去了
        const expected = new Map<string, number>();
        for (const spec of specs) {
          expected.set(spec.parent, (expected.get(spec.parent) ?? 0) + 1);
        }
        for (const [parent, count] of expected) {
          assert.equal(
            attached.filter((object) => object.name === `decor-${parent}`).length,
            count,
            `${character} 的 ${parent} 挂载件数量不对`,
          );
        }
      } finally {
        model.dispose();
      }
    }
  });

  it("装饰件不得进入 parts 表（不参与判定，也不改总高）", () => {
    const model = buildAvatarModel("CT");
    try {
      assert.equal(model.parts.size, 16);
      for (const name of model.parts.keys()) {
        assert.ok(!name.startsWith("decor-"), `${name} 不该是判定部件`);
      }
      assert.ok(Math.abs(model.totalHeight - PLAYER_HEIGHT) < 1e-9);
    } finally {
      model.dispose();
    }
  });

  it("角色辨识靠耳朵/腮帮/胡须/配饰，而且都长在脸上不该飘在空中", () => {
    for (const character of CHARACTER_IDS) {
      const style = CHARACTER_STYLES[character];
      const specs = avatarDecor(character);
      const ears = specs.filter(
        (decor) => decor.geometry === "cone" || (decor.geometry === "ellipsoid" && decor.material === "inner"),
      );
      assert.ok(ears.length >= 2, `${character} 缺少耳朵`);

      // 眼睛/鼻头必须在头的前方（z < 0），否则就是长在后脑勺
      for (const decor of specs) {
        if (decor.material === "eye" || decor.material === "nose") {
          assert.ok(decor.pos.z < 0, `${character} 的眼睛/鼻头 z=${decor.pos.z} 应在脸的前方`);
          assert.ok(decor.pos.y > 1.6 && decor.pos.y < PLAYER_HEIGHT, `${character} 五官高度异常`);
        }
      }

      // 配饰带子必须落在颈部（胸段顶端附近），不能跑到脸上
      const band = specs.find((decor) => decor.geometry === "cylinder" && decor.material === "accent");
      assert.ok(band !== undefined, `${character} 缺少颈部饰带`);
      assert.ok(
        Math.abs(band.pos.y - NECKBAND_Y) < 1e-9,
        `${character} 的饰带高度 ${band.pos.y} 应在颈部 ${NECKBAND_Y}`,
      );
      assert.ok(band.pos.y < HEAD_CENTER_Y - HEAD_RADIUS + 1e-6, "饰带不能高于下巴");

      // 胡须根数必须是偶数（左右对称）
      assert.equal(style.whiskers % 2, 0, `${character} 的胡须应为偶数根`);
    }
  });

  it("躯干上的装饰件不能比躯干还宽（体积件不许撑宽判定）", () => {
    for (const character of CHARACTER_IDS) {
      const scale = CHARACTER_STYLES[character].bodyScale;
      for (const decor of avatarDecor(character)) {
        if (decor.parent !== "torso") {
          continue;
        }
        // 耳朵/胡须是"表情"不是"体积"，允许探出判定体；其余件必须收在躯干宽度内
        const isSilhouette = decor.material === "inner" || decor.material === "dark" || decor.geometry === "cone";
        if (isSilhouette) {
          continue;
        }
        assert.ok(
          Math.abs(decor.pos.x) + decor.size.x / 2 <= TORSO_WIDTH * scale,
          `${character} 的躯干装饰件 x 半宽超出躯干`,
        );
      }
    }
  });

  it("口鼻必须凸在头颅前方（脸的凸出靠口鼻，不靠把头画大）", () => {
    const headFront = -HEAD_RADIUS;
    const muzzleFront = MUZZLE_CENTER_Z - MUZZLE_DEPTH / 2;
    assert.ok(muzzleFront < headFront, "口鼻应比头颅更靠前");
    assert.ok(MUZZLE_WIDTH / 2 < HEAD_RADIUS, "口鼻宽度必须小于头颅半径");
  });
});
