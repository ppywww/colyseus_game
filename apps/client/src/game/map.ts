/**
 * 厨房地图（80×80m，鼠猫尺度）的几何构建。
 *
 * 数据流：所有实心体块来自 `@colyseus-fps-shared` 的 `OBSTACLES`（50 段墙 + 12 栋建筑 +
 * 35 个掩体，全 AABB），客户端渲染、客户端物理（MTA 推出）与服务端弹道遮挡共用同一份数据，
 * 保证「所见即所挡」。
 *
 * **为什么只换皮、不换拓扑**：这张图的三条进攻轴（台面长台 / 中央地砖 / 桌下通道）与两个
 * 包点（灶台 / 水槽）是经过 0.5m 栅格洪泛验证的——每一块空地都可达、每条枪线长度都算过、
 * 10 个出生点都不与体块重叠。重画拓扑等于把这三类验证全部推倒重来，收益只是"看起来更像
 * 厨房"，而换材质 + 加道具同样能做到"一眼是厨房"，风险却为零。
 *
 * 性能约定（97 个体块不能变成 97 次 draw call）：
 *   - 每种 `type` 只用一个共享 `Material`，同类体块用 `InstancedMesh` 批量绘制；
 *   - 按「高度 ≥ 1.4m」再拆成投射阴影 / 不投射阴影两组（小箱子不投影，省一半 shadow pass）；
 *   - 地砖、橱柜、木箱、大理石台面全部用 `CanvasTexture` 程序化生成，零外部资源。
 */

import * as THREE from "three";

import { MAP_SIZE, OBSTACLES, obstacleColliders, type ObstacleKind, type ObstacleSpec } from "@colyseus-fps/shared";

/** 重新导出，保持既有调用方（Game / 物理）不变。 */
export { obstacleColliders };

/**
 * 厨房配色。
 *
 * 明度关系是这张图的"可玩性"基础：地面最亮（米白瓷砖）、橱柜中调（蜂蜜木）、
 * 台面最亮（大理石）、踢脚线最暗。玩家在 30m 外仍能靠明度差读出"哪是地、哪是墙"，
 * 不需要依赖贴图细节。
 */
const PALETTE = {
  /** 地砖：暖陶土，两块之间只差 6% 明度——是"手工铺的砖"，不是黑白棋盘。 */
  tileLight: "#f0ddba",
  tileDark: "#e4cda6",
  tileGrout: "#c2a273",
  tileScuff: 0xa8875c,
  /** 下柜门板（暖蜂蜜木）。 */
  cabinet: "#e0b47c",
  cabinetGroove: "#b07f4a",
  /** 吊柜：比下柜浅一档，上下两层柜子才不会糊成一片。 */
  cabinetUpper: "#e8c491",
  cabinetTop: 0xf2eadf,
  /** 踢脚：整个场景最暗的一档，负责把柜体"压"在地上。 */
  kickboard: "#7d5330",
  /** 台面石：米白带一点点暖，不能纯白（纯白在暖光下会发蓝）。 */
  marble: 0xf3e9d8,
  crate: "#c98a4e",
  crateLine: "#8d5a28",
  /** 家电外壳：冷调不锈钢，是整张图唯一的冷色，专门用来和木色对撞。 */
  appliance: "#b9c0c7",
  applianceDark: "#8e969e",
  steel: 0x8d97a3,
  ceramic: 0xf7ede0,
  terracotta: 0xc4703f,
  leaf: 0x6fa34d,
  cheese: 0xffc63d,
  tomato: 0xe8432f,
  milk: 0xfdfaf2,
  /** 桌布红白格：设计稿里最抢眼的一块颜色。 */
  gingham: "#d24a3d",
  ginghamLight: "#fdf6ee",
  /** 天花木梁。 */
  beam: "#8a5f38",
  sky: 0xf6e3c4,
  fog: 0xefd9b8,
} as const;

/**
 * 厨房墙面的分层高度（米）。
 *
 * 这是"像不像厨房"的**唯一决定因素**：真实厨房的墙永远是
 * 踢脚 → 下柜 → 台面 → 小白砖挡板 → 吊柜 → 墙漆 这个顺序，
 * 玩家不需要看清任何花纹，只靠这几条水平分界线就能读出来。
 *
 * **高度按玩家眼高定，不按"真实厨房 ×3"定**：玩家眼高 1.6m，
 * 如果照物理比例把台面放到 2.7m，平视时看到的仍然只有一堵柜门，
 * 分层全在头顶之上，等于白做。所以台面压在 0.92m（齐腰、低头可见），
 * 小白砖正好铺在 1.02–1.62 这个平视最常停留的带里。
 */
const WALL_BANDS = {
  kickboardTop: 0.12,
  counterTop: 0.9,
  counterThickness: 0.1,
  /**
   * 吊柜底面 1.85m，**必须高于玩家眼高（1.6m）至少 20cm**。
   * 第一版拍在 1.62m，结果贴着墙走的时候，视野上半屏全是吊柜的底面——
   * 一块悬空的木板，像天花板塌了一角。
   */
  backsplashTop: 1.85,
  /** 吊柜顶面 / 大瓷砖墙面起点。 */
  wallTop: 3.0,
} as const;

/** 相机背景色（厨房的暖色墙）。 */
export const ARENA_SKY_COLOR = PALETTE.sky;

/** 场景雾色与近远平面距离（视模型最远 0.97m，完全不受雾影响）。 */
export const ARENA_FOG = { color: PALETTE.fog, near: 46, far: 150 } as const;

/** 只有高度 ≥ 该值的物件才投射阴影（小箱子投影收益极低，却要跑一遍 shadow pass）。 */
const SHADOW_MIN_HEIGHT = 1.4;

/**
 * 天花板高度。
 *
 * 取 8.5m 而不是"贴墙 3–5m"：这张图有 12 栋 4–6m 的"建筑"（高柜/冰箱），
 * 天花板压到墙顶高度就会把它们的顶盖切掉，玩家会看到盒子顶面"开口"。
 * 8.5m 是能盖住全部体块、又让镜头抬头还留有压迫感的值。
 */
const CEILING_HEIGHT = 8.5;

/* ------------------------------------------------------------------ *
 * 程序化贴图（CanvasTexture，逻辑与 effects.ts 的 radialTexture 同构）
 * ------------------------------------------------------------------ */

function createCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  return context === null ? null : { canvas, context };
}

function finishTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // repeat 保持 1：真正的平铺密度由 `useWorldUv` 按世界坐标算（下面会解释为什么）
  texture.repeat.set(1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * 让贴图按**世界尺度**平铺，而不是按 UV 在 0–1 之间拉伸。
 *
 * 为什么必须这么做：橱柜墙体和木箱都画在 InstancedMesh 里——**同一份单位立方体几何**
 * 被缩放到 3m 和 30m 两种尺寸。UV 0–1 意味着 30m 的墙上只贴一张门板贴图，
 * 每个"柜门"有 15 米宽，一眼就穿帮（第一版截图里整面墙就是一片木纹）。
 *
 * 解决方案是盒子投影（box projection）：所有体块都是轴对齐矩形，法线只朝 ±X/±Y/±Z，
 * 所以按主轴直接取世界坐标的两个分量做 UV，密度处处 1:1，且仍然只有一个材质、
 * 一次 draw call。比"给每种尺寸克隆一份材质"省得多，也比逐实例传 UV 缩放简单。
 *
 * @param metersPerTile 一个贴图周期对应多少米
 */
function useWorldUv(material: THREE.MeshStandardMaterial, metersPerTile: number): void {
  const scale: number = 1 / metersPerTile;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uUvScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vArenaPos;\nvarying vec3 vArenaNormal;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 arenaPos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          arenaPos = instanceMatrix * arenaPos;
        #endif
        arenaPos = modelMatrix * arenaPos;
        vArenaPos = arenaPos.xyz;
        // 必须过一遍 modelMatrix 的旋转：地面是 PlaneGeometry 转了 −90°，
        // 它的 objectNormal 还是 (0,0,1)，直接用会把"朝上"判定成"朝前"，地砖就贴没了
        vArenaNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vArenaPos;\nvarying vec3 vArenaNormal;\nuniform float uUvScale;",
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec3 arenaAxis = abs(normalize(vArenaNormal));
          vec2 arenaUv = arenaAxis.y > 0.5
            ? vArenaPos.xz
            : (arenaAxis.x > 0.5 ? vArenaPos.zy : vArenaPos.xy);
          diffuseColor *= texture2D(map, arenaUv * uUvScale);
        #endif`,
      );
  };
  // 用了自定义 shader 片段就必须给一个稳定的缓存键，否则 three 会把两套程序混用
  material.customProgramCacheKey = () => `arena-world-uv-${scale}`;
}

/**
 * 地砖：2×2 的暖陶土方砖 + 砖缝 + 若干磨痕。
 *
 * **为什么不再是棋盘格**：黑白棋盘是仓库 / 机房 / 测试场的地面语言，
 * 它会把整张图往"仓库"那边拉——第一版截图就是被这一层带偏的。
 * 厨房地砖是同一色系的两个色阶（#f0ddba / #e4cda6），砖与砖之间只差一点明度，
 * 靠勾缝而不是靠明暗交替来分块，近看才有"这是手工铺的"感觉。
 *
 * 砖缝仍然是尺度的锚点：1.7m 一个纹理周期 = 0.85m 一块砖，
 * 玩家靠它判断台面长台有 9 米宽。
 */
function tileTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  const half = 128;

  for (let ty = 0; ty < 2; ty += 1) {
    for (let tx = 0; tx < 2; tx += 1) {
      // 不用 (tx+ty)%2：四块砖各随机取一档暖色，避免出现规则的明暗交替
      const tone = Math.random();
      context.fillStyle = tone > 0.5 ? PALETTE.tileLight : PALETTE.tileDark;
      context.fillRect(tx * half, ty * half, half, half);
      // 砖内部一圈浅色倒角：砖才有厚度，而不是一张色块
      context.strokeStyle = "rgba(255,248,235,0.5)";
      context.lineWidth = 3;
      context.strokeRect(tx * half + 6, ty * half + 6, half - 12, half - 12);
      // 砖面细微色斑：陶土砖不是均匀的。只用 3 片、透明度压到 4–8%，
      // 多了整片地会像泼过酱油
      for (let i = 0; i < 3; i += 1) {
        context.fillStyle = `rgba(186,150,104,${0.04 + Math.random() * 0.04})`;
        const size = 10 + Math.random() * 30;
        context.beginPath();
        context.ellipse(
          tx * half + Math.random() * half,
          ty * half + Math.random() * half,
          size,
          size * 0.55,
          Math.random() * Math.PI,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    }
  }

  // 砖缝：3px 浅棕，只是"分块"不是"画格子"——第一版用 5px 深棕，
  // 40m 外看过去地面像石板路的接缝
  context.strokeStyle = "rgba(190,166,128,0.75)";
  context.lineWidth = 3;
  for (let i = 0; i <= 2; i += 1) {
    const p = Math.min(255, i * half + 1);
    context.beginPath();
    context.moveTo(p, 0);
    context.lineTo(p, 256);
    context.stroke();
    context.beginPath();
    context.moveTo(0, p);
    context.lineTo(256, p);
    context.stroke();
  }

  // 磨痕与油渍：没有这一层，整片地砖会像"刚铺完的效果图"
  for (let i = 0; i < 14; i += 1) {
    context.fillStyle = "rgba(150,116,74,0.08)";
    const size = 6 + Math.random() * 26;
    context.beginPath();
    context.ellipse(Math.random() * 256, Math.random() * 256, size, size * 0.6, Math.random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }

  return finishTexture(canvas);
}

/**
 * 橱柜门板：**一扇顶天立地的竖门**铺满整张贴图。
 *
 * 这里踩过一个很典型的坑：第一版把门画成"贴图正中一个矩形、四周留边"，
 * 平铺到只有 0.78m 高的下柜上时，只截到门的中间一段，
 * 屏幕上就变成一条横向浅带 —— 看起来是抽屉，不是柜门。
 * 改成门板占满 0–256 全高之后，任何高度的柜体切出来都是"一排竖门"。
 */
function cabinetTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.cabinet;
  context.fillRect(0, 0, 256, 256);

  // 木纹（横向细线）
  for (let i = 0; i < 44; i += 1) {
    context.fillStyle = "rgba(176,112,52,0.15)";
    context.fillRect(0, Math.random() * 256, 256, 1 + Math.random() * 2);
  }

  // 左侧门缝：深线 + 紧贴的高光，门才有厚度
  context.fillStyle = "rgba(118,74,30,0.6)";
  context.fillRect(0, 0, 5, 256);
  context.fillStyle = "rgba(255,228,184,0.45)";
  context.fillRect(6, 0, 3, 256);

  // 内凹面板：外圈凹线 + 内圈高光（留边很窄，门才显得高大）
  context.strokeStyle = PALETTE.cabinetGroove;
  context.lineWidth = 5;
  context.strokeRect(26, 20, 204, 216);
  context.strokeStyle = "rgba(255,232,190,0.5)";
  context.lineWidth = 2;
  context.strokeRect(31, 25, 194, 206);

  // 竖向拉手：装在门板右侧偏上，是这个角度下最容易读出来的"柜门"信号
  context.fillStyle = "#4a3524";
  context.beginPath();
  context.roundRect(198, 52, 11, 56, 5);
  context.fill();
  context.fillStyle = "rgba(255,232,190,0.85)";
  context.fillRect(200, 56, 3, 48);

  return finishTexture(canvas);
}

/**
 * 墙面的大块浅瓷砖（吊柜以上那段，以及外墙）。
 *
 * 为什么不用纯色：吊柜以上有 2.5–3m 的空白，占了第一人称画面将近一半。
 * 纯色在那里就是"一片奶白"，把上半屏全部浪费掉；换成 0.9m 一块的大瓷砖，
 * 既有内容又安静（砖面只差 2% 明度），还给远处的距离判断提供了尺度参照。
 */
function wallPanelTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  const cell = 128;

  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      // 随机取两档极接近的奶白，砖与砖之间只差一点点，远看是一整面
      context.fillStyle = Math.random() > 0.5 ? "#f6ecda" : "#f2e7d3";
      context.fillRect(column * cell, row * cell, cell, cell);
      // 砖面上沿一道高光，砖才有釉面
      context.fillStyle = "rgba(255,255,255,0.5)";
      context.fillRect(column * cell + 3, row * cell + 3, cell - 6, 3);
    }
  }

  // 细缝：3px，浅灰，远看几乎看不见，近看才分块
  context.strokeStyle = "rgba(198,182,156,0.45)";
  context.lineWidth = 3;
  for (let i = 0; i <= 2; i += 1) {
    const p = Math.min(255, i * cell);
    context.beginPath();
    context.moveTo(p, 0);
    context.lineTo(p, 256);
    context.stroke();
    context.beginPath();
    context.moveTo(0, p);
    context.lineTo(256, p);
    context.stroke();
  }

  return finishTexture(canvas);
}

/**
 * 家电外壳：拉丝不锈钢 + 竖门缝 + 横长拉手 + 一行铭牌。
 *
 * 12 栋建筑全是 4–7m 的实心大块，包成木柜会和 50 段墙糊成一片。
 * 换成冰箱 / 烤箱的冷调不锈钢，是整张图**唯一的冷色**——
 * 玩家在 40m 外就能靠"哪里发冷"判断方位，这正是原来白瓷砖想干的事，
 * 但白瓷砖没有"这是厨房"的语义，不锈钢有。
 */
function applianceTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.appliance;
  context.fillRect(0, 0, 256, 256);

  // 拉丝：横向极细的明暗条
  for (let i = 0; i < 90; i += 1) {
    const y = Math.random() * 256;
    context.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.16)" : "rgba(110,120,132,0.14)";
    context.fillRect(0, y, 256, 1);
  }

  // 竖门缝：两扇对开门
  context.fillStyle = "rgba(96,104,114,0.75)";
  context.fillRect(126, 0, 4, 256);
  context.fillStyle = "rgba(255,255,255,0.5)";
  context.fillRect(120, 0, 3, 256);
  context.fillRect(133, 0, 3, 256);

  // 横向长拉手：冰箱最经典的识别特征（竖着放会像晾衣杆）
  for (const x of [40, 170]) {
    context.fillStyle = PALETTE.applianceDark;
    context.beginPath();
    context.roundRect(x, 108, 46, 12, 5);
    context.fill();
    context.fillStyle = "rgba(255,255,255,0.55)";
    context.fillRect(x + 3, 110, 40, 3);
  }

  // 铭牌
  context.fillStyle = "rgba(92,100,110,0.55)";
  context.beginPath();
  context.roundRect(108, 236, 40, 10, 3);
  context.fill();

  return finishTexture(canvas);
}

/**
 * 红白格纹桌布（gingham）：设计稿里最抢眼的一块颜色。
 *
 * 玩法上它包在原有的 `crate` 掩体外面——箱子还是那个箱子、碰撞一寸没动，
 * 但"掀着桌布的矮桌"一出现，玩家立刻知道自己在厨房而不是仓库。
 */
function ginghamTexture(): THREE.Texture | null {
  const created = createCanvas(128);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.ginghamLight;
  context.fillRect(0, 0, 128, 128);

  const cell = 32;
  // 横竖两组半透明红条叠加 → 交点更深，就是 gingham 的经典三阶
  context.fillStyle = "rgba(210,74,61,0.45)";
  for (let i = 0; i < 4; i += 1) {
    context.fillRect(0, i * cell, 128, cell / 2);
    context.fillRect(i * cell, 0, cell / 2, 128);
  }

  // 布纹：横向极细的褶皱线
  for (let i = 0; i < 40; i += 1) {
    context.fillStyle = "rgba(160,60,50,0.06)";
    context.fillRect(0, Math.random() * 128, 128, 1);
  }

  return finishTexture(canvas);
}

/**
 * 墙面小白砖（subway tile）：白底 + 错缝横向长条 + 细灰缝。
 *
 * 为什么不用地面那张棋盘贴图凑合：棋盘格是 50% 明暗交替，贴到 6m 高的立柱上
 * 会变成一面**黑白棋盘**，读起来像国际象棋盘而不是瓷砖。小白砖靠细缝分隔，
 * 远看是"整体发白的一段墙"，正好和蜂蜜木柜体拉开明度差。
 */
function wallTileTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  const rowHeight = 64;
  const brickWidth = 128;

  context.fillStyle = "#f4efe2";
  context.fillRect(0, 0, 256, 256);

  // 错缝：奇数行整体右移半个砖宽
  for (let row = 0; row < 4; row += 1) {
    const offset = row % 2 === 0 ? 0 : brickWidth / 2;
    for (let column = -1; column < 3; column += 1) {
      const x = column * brickWidth + offset + 3;
      const y = row * rowHeight + 3;
      context.fillStyle = "#fbf7ee";
      context.fillRect(x, y, brickWidth - 6, rowHeight - 6);
      // 砖面上沿一道极浅的高光，砖才有釉面的厚度
      context.fillStyle = "rgba(255,255,255,0.75)";
      context.fillRect(x, y, brickWidth - 6, 2);
    }
  }

  // 灰缝
  context.strokeStyle = "rgba(190,178,156,0.55)";
  context.lineWidth = 3;
  for (let row = 0; row <= 4; row += 1) {
    context.beginPath();
    context.moveTo(0, row * rowHeight);
    context.lineTo(256, row * rowHeight);
    context.stroke();
  }

  return finishTexture(canvas);
}

/** 木箱：竖向木纹 + 铁皮包角（厨房里的储物箱）。 */
function crateTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.crate;
  context.fillRect(0, 0, 256, 256);

  context.fillStyle = PALETTE.crateLine;
  for (let i = 0; i < 12; i += 1) {
    context.fillRect((i / 12) * 256 + Math.random() * 4, 0, 3, 256);
  }
  // 边框条
  context.fillStyle = "rgba(141,90,40,0.75)";
  context.fillRect(0, 0, 256, 14);
  context.fillRect(0, 242, 256, 14);
  context.fillRect(0, 0, 14, 256);
  context.fillRect(242, 0, 14, 256);

  return finishTexture(canvas);
}

/**
 * 窗外的天空：竖向渐变（上浅蓝、下暖白）。
 *
 * 只贴在一张 7×2.2m 的平面上，却决定了整面墙是"室内有一扇窗"还是
 * "墙上糊了一张白纸"。渐变的对比不能大——它是要被当成背景看的。
 */
function windowSkyTexture(): THREE.Texture | null {
  const created = createCanvas(128);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  const gradient = context.createLinearGradient(0, 0, 0, 128);
  gradient.addColorStop(0, "#cfe6f2");
  gradient.addColorStop(0.45, "#e8f2ee");
  gradient.addColorStop(1, "#fff6e0");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  // 远处一点树影/屋脊的暗示，纯渐变会像色卡
  context.fillStyle = "rgba(150,178,150,0.22)";
  context.beginPath();
  context.ellipse(96, 96, 44, 22, 0, 0, Math.PI * 2);
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 共享材质（模块级单例：重新进房时复用，不会重复创建贴图）
 * ------------------------------------------------------------------ */

interface ArenaMaterials {
  tile: THREE.MeshStandardMaterial;
  /** 下柜门（墙裙段），0.85m 一扇门。 */
  cabinet: THREE.MeshStandardMaterial;
  /** 吊柜门：同一张贴图，但一扇门放到 1.3m——上下两排柜门尺寸不同才不会糊成一片。 */
  cabinetUpper: THREE.MeshStandardMaterial;
  /** 踢脚：深木纯色，把柜体"压"在地面上。 */
  kickboard: THREE.MeshStandardMaterial;
  /** 台面石。 */
  marble: THREE.MeshStandardMaterial;
  /** 后挡板小白砖。 */
  backsplash: THREE.MeshStandardMaterial;
  /** 吊柜以上的墙漆（奶白）。 */
  wallPaint: THREE.MeshStandardMaterial;
  /** 家电外壳（冰箱 / 烤箱）。 */
  appliance: THREE.MeshStandardMaterial;
  /** 储物木箱。 */
  crate: THREE.MeshStandardMaterial;
  /** 格纹桌布（包在部分矮掩体外面）。 */
  gingham: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  ceramic: THREE.MeshStandardMaterial;
  terracotta: THREE.MeshStandardMaterial;
  leaf: THREE.MeshStandardMaterial;
  cheese: THREE.MeshStandardMaterial;
  tomato: THREE.MeshStandardMaterial;
  milk: THREE.MeshStandardMaterial;
  beam: THREE.MeshStandardMaterial;
  scuff: THREE.MeshBasicMaterial;
}

let cachedMaterials: ArenaMaterials | null = null;

function arenaMaterials(): ArenaMaterials {
  if (cachedMaterials !== null) {
    return cachedMaterials;
  }

  const tile = tileTexture();
  const cabinet = cabinetTexture();
  const crate = crateTexture();
  const matte = (color: number, roughness = 0.86): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });

  const tileMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tile, roughness: 0.5, metalness: 0.03 });
  const cabinetMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: cabinet, roughness: 0.7, metalness: 0.03 });
  // 吊柜必须克隆：`useWorldUv` 把平铺密度烘进了 shader，共享材质就改不了尺度
  const cabinetUpperMaterial = cabinetMaterial.clone();
  cabinetUpperMaterial.color = new THREE.Color(1.06, 1.05, 1.03);
  const crateMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: crate, roughness: 0.78, metalness: 0.02 });
  const backsplashMaterial = new THREE.MeshStandardMaterial({
    color: 0xfffdf6,
    map: wallTileTexture(),
    roughness: 0.34,
    metalness: 0.02,
  });
  const applianceMaterial = new THREE.MeshStandardMaterial({
    // 金属度必须压到 0.18：这张图**没有环境贴图**，metalness 一高就没有东西可反射，
    // 不锈钢会在暖光下渲染成"黑铁块"（第一版俯视图里 12 栋建筑全是黑箱子）。
    // 靠贴图里的拉丝明暗去做金属感，比靠 PBR 参数可靠。
    color: 0xffffff,
    map: applianceTexture(),
    roughness: 0.44,
    metalness: 0.18,
  });
  const ginghamMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: ginghamTexture(),
    roughness: 0.92,
    metalness: 0,
  });
  const wallPanelMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: wallPanelTexture(),
    roughness: 0.46,
    metalness: 0.02,
  });

  // 平铺密度必须**和分层高度对齐**，否则一扇门会被切成"横向浅带"：
  // 下柜 0.78m 高 → 周期 0.8m（≈ 一扇门）、吊柜 0.98m 高 → 周期 1.0m（≈ 一扇门）
  useWorldUv(tileMaterial, 1.7);
  useWorldUv(cabinetMaterial, 0.8);
  useWorldUv(cabinetUpperMaterial, 1.15);
  useWorldUv(crateMaterial, 1.5);
  useWorldUv(backsplashMaterial, 0.9);
  useWorldUv(applianceMaterial, 1.7);
  useWorldUv(ginghamMaterial, 0.75);
  useWorldUv(wallPanelMaterial, 1.8);

  cachedMaterials = {
    tile: tileMaterial,
    cabinet: cabinetMaterial,
    cabinetUpper: cabinetUpperMaterial,
    kickboard: matte(0x9c6c40, 0.82),
    marble: new THREE.MeshStandardMaterial({ color: PALETTE.marble, roughness: 0.3, metalness: 0.05 }),
    backsplash: backsplashMaterial,
    wallPaint: wallPanelMaterial,
    appliance: applianceMaterial,
    crate: crateMaterial,
    gingham: ginghamMaterial,
    steel: new THREE.MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.3, metalness: 0.7 }),
    ceramic: new THREE.MeshStandardMaterial({ color: PALETTE.ceramic, roughness: 0.24, metalness: 0.02 }),
    terracotta: matte(PALETTE.terracotta, 0.92),
    leaf: new THREE.MeshStandardMaterial({ color: PALETTE.leaf, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
    cheese: matte(PALETTE.cheese, 0.6),
    tomato: matte(PALETTE.tomato, 0.55),
    milk: matte(PALETTE.milk, 0.35),
    beam: matte(0xa88055, 0.9),
    scuff: new THREE.MeshBasicMaterial({ color: PALETTE.tileScuff, transparent: true, opacity: 0.05, depthWrite: false }),
  };

  return cachedMaterials;
}

/* ------------------------------------------------------------------ *
 * 通用实例化辅助
 * ------------------------------------------------------------------ */

type InstancePlacer = (
  spec: ObstacleSpec,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  scale: THREE.Vector3,
) => void;

/**
 * 把一批同材质体块画成 InstancedMesh：按「高度 ≥ 1.4m」拆成投影 / 不投影两组。
 * 同类物件共享同一份 geometry 与 material，因此 draw call 与数量无关。
 */
function addInstances(
  root: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  specs: readonly ObstacleSpec[],
  place: InstancePlacer,
): void {
  const groups: Array<{ specs: ObstacleSpec[]; castsShadow: boolean }> = [
    { specs: specs.filter((spec) => spec.height >= SHADOW_MIN_HEIGHT), castsShadow: true },
    { specs: specs.filter((spec) => spec.height < SHADOW_MIN_HEIGHT), castsShadow: false },
  ];

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const matrix = new THREE.Matrix4();

  for (const group of groups) {
    if (group.specs.length === 0) {
      continue;
    }
    const mesh = new THREE.InstancedMesh(geometry, material, group.specs.length);
    group.specs.forEach((spec, index) => {
      position.set(0, 0, 0);
      quaternion.identity();
      scale.set(1, 1, 1);
      place(spec, position, quaternion, scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = group.castsShadow;
    mesh.receiveShadow = group.castsShadow;
    root.add(mesh);
  }
}

/** 以 AABB 尺寸放置一个单位立方 / 单位圆柱（几何体底面在 y=0，故中心抬到 height/2）。 */
function placeAabb(spec: ObstacleSpec, position: THREE.Vector3, _quaternion: THREE.Quaternion, scale: THREE.Vector3): void {
  position.set(spec.x, spec.height / 2, spec.z);
  scale.set(spec.width, spec.height, spec.depth);
}

function specsOfType(type: ObstacleKind): ObstacleSpec[] {
  return OBSTACLES.filter((obstacle) => obstacle.type === type);
}

/* ------------------------------------------------------------------ *
 * 装饰件（全部只做视觉，不写进 OBSTACLES、不参与碰撞）
 * ------------------------------------------------------------------ */

/** 地面油渍：6–8 片半透明浅棕圆，制造使用痕迹（单个 InstancedMesh）。 */
function addFloorScuffs(root: THREE.Group): void {
  const count = 3;
  const geometry = new THREE.CircleGeometry(1, 20);
  const mesh = new THREE.InstancedMesh(geometry, arenaMaterials().scuff, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  for (let i = 0; i < count; i += 1) {
    const radius = 1.0 + Math.random() * 1.4;
    position.set((Math.random() - 0.5) * 62, 0.012 + i * 0.0008, (Math.random() - 0.5) * 62);
    scale.set(radius, radius * (0.7 + Math.random() * 0.5), 1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = false;
  root.add(mesh);
}

/**
 * 墙体分层：给每一段墙按真实厨房的剖面套上
 * 踢脚 → 下柜 → 台面 → 小白砖挡板 → 吊柜 → 墙漆。
 *
 * **为什么用"额外一层薄壳"而不是在 shader 里按世界 Y 换贴图**：
 * 一个 `MeshStandardMaterial` 只能绑一张 map，要在 shader 里按高度选图得先做图集、
 * 再手写采样与段内 UV 换算——出错时的表现是"整面墙变粉"这种极难定位的问题。
 * 套壳是纯几何：每层都是一个比原体块外扩 3–9cm 的盒子，只覆盖自己的高度区间，
 * 尺度、材质、UV 各自独立，改一层绝不影响别层，而且同类体块仍然合并成
 * **一个** InstancedMesh——增加的是 6 次 draw call，不是 50 次。
 *
 * 外扩量是刻意排过序的（挡板 3cm < 下柜 5cm < 踢脚 7cm < 吊柜 9cm < 台面 16cm）：
 * 相邻两层只要错开 ≥2cm 就不会 z-fighting，同时台面探出最多，
 * 才能在 2.6m 的高度看到一条真正的"台面檐口"。
 */
function addWallBands(root: THREE.Group): void {
  const materials = arenaMaterials();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const walls = specsOfType("wall");

  /**
   * 四道外墙单独处理。
   *
   * 它们有 80m 长——做成"一整排 100 扇橱柜门"是荒谬的，而且窗必须开在外墙上，
   * 内墙那套分层壳（吊柜外扩 9cm）会把窗整块盖住。
   * 所以外墙只做「踢脚 → 木护墙板 → 墙漆」，窗直接贴在墙漆带里。
   */
  const isOuterWall = (spec: ObstacleSpec): boolean =>
    spec.id === "N" || spec.id === "S" || spec.id === "W" || spec.id === "E";
  const outerWalls = walls.filter(isOuterWall);
  const innerWalls = walls.filter((spec) => !isOuterWall(spec));

  /** 铺一层：从 bottom 开始，到 min(top, 墙高) 结束。 */
  const band = (
    layer: readonly ObstacleSpec[],
    material: THREE.Material,
    bottom: number,
    top: (spec: ObstacleSpec) => number,
    outset: number,
  ): void => {
    // 必须先过滤掉"够不到这一层"的体块。
    // 全图有 5 段 1.1m 高的矮掩体：如果直接 clamp 到 2cm 去画，
    // 吊柜层会在 1.86m、墙漆层会在 3.0m 各生成一块**悬空的板**——
    // 第一版截图里那两块"天上掉下来的白板"就是这个 bug。
    const applicable = layer.filter((spec) => Math.min(top(spec), spec.height) > bottom);
    if (applicable.length === 0) {
      return;
    }
    addInstances(root, geometry, material, applicable, (spec, position, _quaternion, scale) => {
      const ceiling = Math.min(top(spec), spec.height);
      const height = ceiling - bottom;
      position.set(spec.x, bottom + height / 2, spec.z);
      scale.set(spec.width + outset, height, spec.depth + outset);
    });
  };

  const counterBottom = WALL_BANDS.counterTop;
  const counterTop = WALL_BANDS.counterTop + WALL_BANDS.counterThickness;

  // ---- 内墙：完整的厨房剖面 ----
  // 0 · 下柜门：**从地面直接起**，不做独立踢脚层。
  // 踢脚本来是深色、又比柜体突出 3.5cm，在 30m 长的墙上透视成一条"近黑棕"的带子，
  // 从墙边走过去会占掉半个屏幕，被读成"地面变了一块颜色"——真实厨房的踢脚只有 10cm 高、
  // 房间只有 4m 深，所以没这个问题；这张图的墙是 30m，同一个细节会被放大 8 倍。
  band(innerWalls, materials.cabinet, 0, () => counterBottom, 0.03);
  // 2 · 台面（探出 8cm，最宽的一层）
  band(innerWalls, materials.marble, counterBottom, () => counterTop, 0.11);
  // 3 · 后挡板小白砖（正好铺在眼高）
  band(innerWalls, materials.backsplash, counterTop, () => WALL_BANDS.backsplashTop, 0.03);
  // 4 · 吊柜
  band(innerWalls, materials.cabinetUpper, WALL_BANDS.backsplashTop, () => WALL_BANDS.wallTop, 0.09);
  // 5 · 墙漆（吊柜以上直到墙顶）
  band(innerWalls, materials.wallPaint, WALL_BANDS.wallTop, (spec) => spec.height, 0.02);

  // ---- 外墙：护墙板 + 大瓷砖（窗开在瓷砖带上）----
  // 外墙**不做踢脚**：80m 长、0.22m 高的一条深色带，在 1.6m 眼高下正好横贯下半屏，
  // 会被读成"地面有一块变色的区域"，而不是"墙脚"。护墙板直接从地面起。
  band(outerWalls, materials.cabinet, 0, () => 1.1, 0.05);
  band(outerWalls, materials.wallPaint, 1.1, (spec) => spec.height, 0.03);
}

/**
 * 家电帽：12 栋建筑换成冰箱 / 烤箱之后，顶部不该再有大理石台面。
 *
 * 只加两样：一圈**深色压边**（0.12m 高，外扩 3cm）让体块有"机器外壳"的边缘，
 * 和一条比机身矮 2cm 的**不锈钢顶盖**（冰箱顶是平的，可以放东西，
 * 但玩家跳不上去，纯视觉）。
 */
function addApplianceCaps(root: THREE.Group): void {
  const materials = arenaMaterials();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const buildings = specsOfType("building");

  // 顶部压边：只做一条**内收**的深色檐（不再外扩）。
  // 外扩 2cm 的钢板从 6m 高处往下看是一条白线，从下往上看却是一块悬空的板。
  addInstances(root, geometry, materials.appliance, buildings, (spec, position, _quaternion, scale) => {
    position.set(spec.x, spec.height - 0.06, spec.z);
    scale.set(spec.width + 0.04, 0.12, spec.depth + 0.04);
  });
  // 底脚：一道 0.16m 的深色阴影缝，机器才不像"插在地上"
  addInstances(root, geometry, materials.kickboard, buildings, (spec, position, _quaternion, scale) => {
    position.set(spec.x, 0.08, spec.z);
    scale.set(spec.width + 0.04, 0.16, spec.depth + 0.04);
  });
}

/**
 * 箱顶摆件：奶酪楔 / 盘子 / 番茄 / 牛奶瓶。
 *
 * 为什么只放在**箱子**顶上：箱子是 1.1–1.6m 的矮掩体，玩家跳上去、蹲在后面，
 * 顶上放东西既合理（厨房里就是随手一放），又能给"这块能跳"一个视觉暗示。
 * 四类物件按箱子序号轮换，只用 4 个 InstancedMesh（4 次 draw call）。
 */
function addCounterProps(root: THREE.Group, crates: readonly ObstacleSpec[]): void {
  if (crates.length === 0) {
    return;
  }
  const materials = arenaMaterials();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();

  const buckets: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material; specs: ObstacleSpec[]; y: number }> = [
    // 奶酪楔：三棱柱（ConeGeometry 3 边）躺倒
    { geometry: new THREE.ConeGeometry(0.17, 0.13, 3), material: materials.cheese, specs: [], y: 0.2 },
    // 盘子
    { geometry: new THREE.CylinderGeometry(0.16, 0.14, 0.026, 16), material: materials.ceramic, specs: [], y: 0.013 },
    // 番茄
    { geometry: new THREE.SphereGeometry(0.085, 12, 10), material: materials.tomato, specs: [], y: 0.085 },
    // 牛奶瓶
    { geometry: new THREE.CylinderGeometry(0.058, 0.07, 0.25, 12), material: materials.milk, specs: [], y: 0.125 },
  ];
  crates.forEach((crate, index) => {
    (buckets[index % buckets.length] as (typeof buckets)[number]).specs.push(crate);
  });

  for (const bucket of buckets) {
    if (bucket.specs.length === 0) {
      continue;
    }
    const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.specs.length);
    bucket.specs.forEach((crate, index) => {
      // 摆在箱顶靠里一点，且每件略有偏差（整齐排列会像棋盘而不是厨房）
      const offsetX = (Math.random() - 0.5) * (crate.width * 0.4);
      const offsetZ = (Math.random() - 0.5) * (crate.depth * 0.4);
      position.set(crate.x + offsetX, crate.height + bucket.y, crate.z + offsetZ);
      euler.set(0, Math.random() * Math.PI * 2, 0);
      quaternion.setFromEuler(euler);
      if (bucket.material === materials.cheese) {
        // 三棱柱躺倒才是"楔形奶酪"，立着是根柱子
        euler.set(Math.PI / 2, 0, Math.random() * Math.PI);
        quaternion.setFromEuler(euler);
      }
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    root.add(mesh);
  }
}

/**
 * 盆栽香草（替换原来的棕榈树）。
 *
 * 陶盆 + 6 片放射状叶片：在厨房里这是窗台上的那盆罗勒/迷迭香，
 * 在玩法上它仍然是"占一个 0.6m 见方的掩体"——视觉换了，碰撞体一个都没动。
 */
function addHerbPots(root: THREE.Group, pots: readonly ObstacleSpec[]): void {
  if (pots.length === 0) {
    return;
  }
  const materials = arenaMaterials();
  const potGeometry = new THREE.CylinderGeometry(0.34, 0.26, 0.6, 12);
  addInstances(root, potGeometry, materials.terracotta, pots, (spec, position, _quaternion, scale) => {
    position.set(spec.x, 0.3, spec.z);
    scale.set(spec.width / 0.6, 0.5, spec.depth / 0.6);
  });

  const leavesPerPot = 7;
  const leafGeometry = new THREE.BoxGeometry(0.1, 0.02, 0.9);
  const leaves = new THREE.InstancedMesh(leafGeometry, materials.leaf, pots.length * leavesPerPot);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const quaternion = new THREE.Quaternion();

  pots.forEach((pot, potIndex) => {
    for (let i = 0; i < leavesPerPot; i += 1) {
      const angle = (i / leavesPerPot) * Math.PI * 2 + potIndex * 0.5;
      const tilt = (28 + Math.random() * 26) * (Math.PI / 180);
      position.set(
        pot.x + Math.cos(angle) * 0.3,
        0.56 + Math.random() * 0.12,
        pot.z + Math.sin(angle) * 0.3,
      );
      euler.set(tilt, Math.PI / 2 - angle, 0, "YXZ");
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      leaves.setMatrixAt(potIndex * leavesPerPot + i, matrix);
    }
  });
  leaves.instanceMatrix.needsUpdate = true;
  leaves.castShadow = true;
  root.add(leaves);
}

/** 手推餐车（原"市集推车"）：不锈钢车体 + 两只轮 + 上层托盘。 */
function addTrolleys(root: THREE.Group, carts: readonly ObstacleSpec[]): void {
  if (carts.length === 0) {
    return;
  }
  const materials = arenaMaterials();

  const wheelGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.08, 14);
  const wheelQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const wheels = new THREE.InstancedMesh(wheelGeometry, materials.steel, carts.length * 2);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  carts.forEach((cart, index) => {
    const axleX = cart.x - cart.width * 0.28;
    const halfDepth = Math.max(cart.depth / 2 - 0.02, 0.15);
    for (let side = 0; side < 2; side += 1) {
      position.set(axleX, 0.34, cart.z + (side === 0 ? -halfDepth : halfDepth));
      matrix.compose(position, wheelQuaternion, scale);
      wheels.setMatrixAt(index * 2 + side, matrix);
    }
  });
  wheels.instanceMatrix.needsUpdate = true;
  wheels.castShadow = true;
  root.add(wheels);

  // 上层托盘：比车体小一圈，读作"推车上那块不锈钢板"
  const trayGeometry = new THREE.BoxGeometry(1, 1, 1);
  addInstances(root, trayGeometry, materials.ceramic, carts, (cart, pos, quat, scl) => {
    pos.set(cart.x, cart.height - 0.04, cart.z);
    scl.set(cart.width + 0.16, 0.06, cart.depth + 0.14);
    quat.identity();
  });
}

/**
 * 天花木梁。
 *
 * 只做一件事：抬头时不是一片纯色。梁必须**细而浅**——
 * 第一版做了 9 根 40cm 的深棕梁，在 8.5m 高度透视成"体育馆屋顶"，
 * 比不装还压抑。5 根 28cm、颜色提到 #a88055 之后就只是"老房子的屋顶结构"。
 */
function addCeilingBeams(root: THREE.Group): void {
  const materials = arenaMaterials();
  const beamCount = 5;
  const span = MAP_SIZE - 4;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, materials.beam, beamCount);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let i = 0; i < beamCount; i += 1) {
    position.set(0, CEILING_HEIGHT - 0.12, -MAP_SIZE / 2 + 6 + (i * (MAP_SIZE - 12)) / (beamCount - 1));
    scale.set(span, 0.26, 0.3);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  root.add(mesh);
}

/** 一扇窗的内侧参数：位置 + 朝向（法线指向房间内）。 */
interface WindowSpec {
  x: number;
  z: number;
  rotY: number;
}

/**
 * 窗户 + 地面光斑。
 *
 * 窗是"厨房"最强的氛围道具：墙上有窗、地上有斜光，哪怕别的都还是盒子，
 * 玩家也会先认成"室内"。所以窗刻意开在 **1.2–2.8m 的吊柜带**——
 * 正是真实厨房窗台的高度，平视就在视线里。
 *
 * 全部只做视觉：不写进 OBSTACLES、不参与碰撞。光斑贴在地面 y=0.02，
 * 用加色混合，叠在地砖上像被晒白的一块。
 */
function addWindows(root: THREE.Group): void {
  const materials = arenaMaterials();
  const edge = MAP_SIZE / 2 - 2.06;
  const windows: WindowSpec[] = [
    // 南墙（z = +edge，法线朝 −z）
    { x: -22, z: edge, rotY: Math.PI },
    { x: 0, z: edge, rotY: Math.PI },
    { x: 22, z: edge, rotY: Math.PI },
    // 北墙（z = −edge，法线朝 +z）
    { x: -24, z: -edge, rotY: 0 },
    { x: 0, z: -edge, rotY: 0 },
    { x: 24, z: -edge, rotY: 0 },
    // 西墙（x = −edge，法线朝 +x）
    { x: -edge, z: -24, rotY: Math.PI / 2 },
    { x: -edge, z: 2, rotY: Math.PI / 2 },
    { x: -edge, z: 26, rotY: Math.PI / 2 },
    // 东墙（x = +edge，法线朝 −x）
    { x: edge, z: -24, rotY: -Math.PI / 2 },
    { x: edge, z: 2, rotY: -Math.PI / 2 },
    { x: edge, z: 26, rotY: -Math.PI / 2 },
  ];

  const width = 7;
  const height = 2.2;
  const centerY = 2.3;

  // 玻璃：不受光的基础材质，是"外面很亮"的唯一来源。
  // 纯白会像糊了一张纸；给一个上蓝下暖白的渐变，才像"窗外是白天"。
  const paneMaterial = new THREE.MeshBasicMaterial({ map: windowSkyTexture() });
  const paneGeometry = new THREE.PlaneGeometry(width, height);
  const panes = new THREE.InstancedMesh(paneGeometry, paneMaterial, windows.length);
  // 窗框：上下两根横挡 + 两侧竖框，深木纯色（用柜门贴图会把窗框切成木纹碎片）
  const frameGeometry = new THREE.BoxGeometry(1, 1, 1);
  const frames = new THREE.InstancedMesh(frameGeometry, materials.kickboard, windows.length * 4);
  // 地面光斑：加色混合的半透明矩形
  const patchGeometry = new THREE.PlaneGeometry(width * 1.4, 4.2);
  const patchMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe9b4,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const patches = new THREE.InstancedMesh(patchGeometry, patchMaterial, windows.length);

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const floorQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

  windows.forEach((win, index) => {
    euler.set(0, win.rotY, 0);
    quaternion.setFromEuler(euler);
    position.set(win.x, centerY, win.z);
    matrix.compose(position, quaternion, scale);
    panes.setMatrixAt(index, matrix);

    // 窗框：沿窗的局部 x（横向）排三根竖挺、两根横挡
    const dirX = Math.cos(win.rotY);
    const dirZ = -Math.sin(win.rotY);
    let slot = 0;
    const placeFrame = (offsetAlong: number, y: number, w: number, h: number): void => {
      position.set(win.x + dirX * offsetAlong, y, win.z + dirZ * offsetAlong);
      scale.set(w, h, 0.16);
      matrix.compose(position, quaternion, scale);
      frames.setMatrixAt(index * 4 + slot, matrix);
      slot += 1;
    };
    placeFrame(0, centerY + height / 2, width + 0.3, 0.14);
    placeFrame(0, centerY - height / 2, width + 0.3, 0.14);
    placeFrame(-width / 2, centerY, 0.14, height);
    placeFrame(width / 2, centerY, 0.14, height);

    // 光斑：落在窗内侧 3.2m 处的地面上（朝房间里偏）
    position.set(win.x - dirX * 3.2, 0.02, win.z - dirZ * 3.2);
    scale.set(1, 1, 1);
    matrix.compose(position, floorQuaternion, scale);
    patches.setMatrixAt(index, matrix);
  });

  for (const mesh of [panes, frames, patches]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
  }
  panes.renderOrder = -1;
  patches.renderOrder = 1;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */
/** 构建厨房场景，返回可加入 scene 的根节点（含地面、体块、装饰与灯光）。 */
export function buildArena(): THREE.Group {
  const root = new THREE.Group();
  root.name = "arena";
  const materials = arenaMaterials();

  // ---- 地面：一整块 80×80 瓷砖（repeat 24 ≈ 每 3.3m 一个纹理周期 = 4 块 0.83m 砖） ----
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE), materials.tile);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // ---- 天花板：只是"封顶"，不参与任何玩法 ----
  // 没有它，镜头往上一抬就是一片纯色天空——玩家会觉得这是室外靶场而不是厨房。
  // 用不受光材质是故意的：天花板在 8.5m 高，主光从上方打下来，按物理算它应该是全黑的
  // （所以这里显式不许它投影），而在真实厨房里天花板是被漫反射照亮的顶面。
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE),
    new THREE.MeshBasicMaterial({ color: 0xe9d7b6 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = CEILING_HEIGHT;
  ceiling.castShadow = false;
  ceiling.receiveShadow = false;
  root.add(ceiling);

  addFloorScuffs(root);

  // ---- 体块：按 type 分派，每种只画 1–2 次 ----
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);

  // 墙体与家电只铺"素体"：真正让它们像厨房的是下面 addWallBands 的分层壳。
  // 这里保留一层是为了兜住分层的接缝（也是没有装壳时唯一可见的一层）。
  addInstances(root, boxGeometry, materials.cabinet, specsOfType("wall"), placeAabb);
  // 12 栋大件家电：冷调不锈钢，是整张图唯一的冷色，40m 外靠"哪里发冷"定方位
  addInstances(root, boxGeometry, materials.appliance, specsOfType("building"), placeAabb);
  // 矮掩体两种身份：铺格纹桌布的矮桌 / 储物木箱。
  //
  // **桌布只给 1.1m 的矮箱**：全图还有一批 1.6m 的高箱，给它们铺桌布，
  // 桌面正好卡在玩家眼高（1.6m）上，贴过去就是一大块挡在脸上的深色板。
  // 桌子本来也不该有 1.6m 高。
  const crates = specsOfType("crate");
  const drapedTables: ObstacleSpec[] = [];
  const woodenCrates: ObstacleSpec[] = [];
  crates.forEach((spec, index) => {
    if (spec.height <= 1.2 && index % 2 === 0) {
      drapedTables.push(spec);
    } else {
      woodenCrates.push(spec);
    }
  });
  addInstances(root, boxGeometry, materials.crate, woodenCrates, placeAabb);
  addInstances(root, boxGeometry, materials.gingham, drapedTables, placeAabb);
  // 桌面：只有垂下来的桌布、没有桌面，会读成"立着一匹布"。
  // 用白石台面而不是深木——深色大块贴在眼前会让整片下半屏变暗。
  addInstances(root, boxGeometry, materials.marble, drapedTables, (spec, position, _quaternion, scale) => {
    position.set(spec.x, spec.height + 0.03, spec.z);
    scale.set(spec.width + 0.1, 0.06, spec.depth + 0.1);
  });
  // 石台（拱柱位置：改成切菜案台）
  addInstances(root, boxGeometry, materials.marble, specsOfType("arch"), placeAabb);
  // 餐车车体
  const carts = specsOfType("cart");
  addInstances(root, boxGeometry, materials.steel, carts, placeAabb);
  // 陶罐（替代油桶）：圆柱，两种色交替，仍只占 2 次 draw call
  const jars = specsOfType("barrel");
  addInstances(
    root,
    new THREE.CylinderGeometry(0.5, 0.48, 1, 14),
    materials.terracotta,
    jars.filter((_spec, index) => index % 2 === 0),
    placeAabb,
  );
  addInstances(
    root,
    new THREE.CylinderGeometry(0.5, 0.46, 1, 14),
    materials.ceramic,
    jars.filter((_spec, index) => index % 2 === 1),
    placeAabb,
  );

  // ---- 装饰件（全部无碰撞）----
  addWallBands(root);
  addApplianceCaps(root);
  addCounterProps(root, crates);
  addHerbPots(root, specsOfType("palm"));
  addTrolleys(root, carts);
  addCeilingBeams(root);
  addWindows(root);

  // ---- 灯光：室内暖光（顶部主灯 + 环境反弹）----
  // 比沙漠版更低的天光强度、更高的环境色温：厨房是"白炽灯下"而不是"正午太阳下"，
  // 阴影因此更软、色温更暖，和 UI 的奶油纸是同一个色系。
  // 地面反弹色不能太棕：0xc2a281 会让所有阴影区的地砖变成"土色"，
  // 靠 0xdcc8a9 把阴影抬回暖灰，阴影里仍然看得清砖缝
  const hemisphere = new THREE.HemisphereLight(0xfff4e0, 0xdcc8a9, 1.3);
  root.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff1d6, 1.45);
  sun.position.set(46, 66, 34);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -46;
  sun.shadow.camera.right = 46;
  sun.shadow.camera.top = 46;
  sun.shadow.camera.bottom = -46;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0006;
  root.add(sun);
  root.add(sun.target);

  // 补光：从西侧打一盏弱暖光，避免背光面死黑（室内有墙反弹，不该出现纯黑块）
  const fill = new THREE.DirectionalLight(0xffd9a8, 0.35);
  fill.position.set(-40, 30, -30);
  root.add(fill);

  return root;
}
