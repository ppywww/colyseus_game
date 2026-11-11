/**
 * 视模型「离线出图」工具：把第一人称视模型直接软件光栅化成 PNG，用来做目视验收。
 *
 * 为什么不用浏览器截图：本机没有 Playwright/浏览器内核依赖，装一套只为了看一眼刀
 * 成本太高；而视模型是纯几何 + 平光材质，写个 60 行的三角形光栅器就够判断
 * 「轮廓对不对、有没有出画、手上是不是握着刀」。
 *
 * 用法：
 *   pnpm --filter @colyseus-fps/client exec tsx scripts/preview-viewmodel.mts --slot 2 --out knife.png
 *   pnpm --filter @colyseus-fps/client exec tsx scripts/preview-viewmodel.mts --slot 2 --twirl 3310 --out knife-mid.png
 *   pnpm --filter @colyseus-fps/client exec tsx scripts/preview-viewmodel.mts --slot 0 --out rifle.png
 *   pnpm --filter @colyseus-fps/client exec tsx scripts/preview-viewmodel.mts --target avatar --team CT --out ct.png
 *
 * 参数：
 *   --target  viewmodel（第一人称武器，默认）| avatar（第三人称人物）
 *   --slot    武器槽位（0 步枪 / 1 手枪 / 2 匕首 / 3–5 投掷物），默认 0
 *   --twirl   匕首转刀相位（毫秒，0–3620），默认静置（<3000 都在静置段）
 *   --swing   挥刀已进行毫秒数（0–260），默认 260（已结束）
 *   --reload  换弹进度 0–1，默认 0
 *   --team    avatar 模式的队伍（T / CT），默认 CT
 *   --yaw     avatar 模式的朝向（弧度），默认 0 = 正面对镜头
 *   --out     输出 PNG 路径，默认 preview.png
 *   --w/--h   分辨率，默认 640×360
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";

import * as THREE from "three";

import { characterIndexOf, characterOfIndex } from "@colyseus-fps/shared";

import { ViewModel, KNIFE_TWIRL_CYCLE_MS, KNIFE_TWIRL_GAP_MS } from "../src/game/viewmodel.js";
import { AvatarModel } from "../src/game/avatar-model.js";

/* ---------------- 参数 ---------------- */

function arg(name: string, fallback: number): number {
  const argv = process.argv;
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= argv.length) {
    return fallback;
  }
  const parsed = Number(argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const WIDTH = Math.max(160, Math.trunc(arg("w", 640)));
const HEIGHT = Math.max(90, Math.trunc(arg("h", 360)));
const SLOT = Math.trunc(arg("slot", 0));
const TWIRL_MS = arg("twirl", KNIFE_TWIRL_GAP_MS);
const SWING_MS = arg("swing", 260);
const RELOAD = arg("reload", 0);
const OUT = path.resolve(strArg("out", "preview.png"));
const TARGET = strArg("target", "viewmodel");
const TEAM = strArg("team", "CT") === "T" ? "T" : "CT";
const CHARACTER = characterOfIndex(characterIndexOf(strArg("character", "tom")));
const YAW = arg("yaw", 0);
const DEBUG_COLORS = process.argv.includes("--debug-colors");

/* ---------------- 场景 ---------------- */

const camera = new THREE.PerspectiveCamera(80, WIDTH / HEIGHT, 0.1, 100);
let rootObject: THREE.Object3D;

if (TARGET === "avatar") {
  // 第三人称人物：45° 视角、站远一点，正对角色正面（角色前方 = −Z，所以相机放 −Z）
  camera.fov = 40;
  camera.position.set(Math.sin(YAW) * 0.01 + 0.55, 1.18, -2.75);
  camera.lookAt(0, 0.98, 0);
  const avatar = new AvatarModel(TEAM, CHARACTER);
  avatar.root.rotation.y = YAW;
  avatar.root.updateMatrixWorld(true);
  rootObject = avatar.root;
} else {
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  const viewmodel = new ViewModel(camera);
  viewmodel.setWeaponSlot(SLOT);

  // 把内部计时器推到目标相位：update 的 dt 上限 0.1s，所以按 16.6ms 一帧步进。
  const FRAME_MS = 1000 / 60;
  const STATE = {
    moving: false,
    grounded: true,
    reloadProgress: RELOAD,
    throwing: false,
    firingAt: 0,
  };
  // 相位对齐：内部相位从 KNIFE_TWIRL_GAP_MS 起算，先跑 1.2s 让 idle 呼吸稳定，
  // 再补足到达目标相位所需的时长（取模保证不会多跑一整圈）。
  // 注意：settle 阶段也在推进相位，所以要把 settle 一起算进取模，否则会多绕一圈回静置段。
  const startPhase = KNIFE_TWIRL_GAP_MS;
  const settleMs = 1200;
  const advanceMs =
    (((TWIRL_MS - startPhase - settleMs) % KNIFE_TWIRL_CYCLE_MS) + KNIFE_TWIRL_CYCLE_MS) %
    KNIFE_TWIRL_CYCLE_MS;
  let elapsedMs = 0;
  const targetMs = settleMs + advanceMs;
  while (elapsedMs < targetMs) {
    viewmodel.update(FRAME_MS / 1000, STATE);
    elapsedMs += FRAME_MS;
  }
  // 挥刀相位：公开 API 只有 swing()，这里为了确定性手动定位
  if (SWING_MS < 260) {
    viewmodel.swing();
    let swingElapsed = 0;
    while (swingElapsed < SWING_MS) {
      viewmodel.update(FRAME_MS / 1000, STATE);
      swingElapsed += FRAME_MS;
    }
  }
  rootObject = viewmodel.visualRoot;
}

camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();
rootObject.updateMatrixWorld(true);

/* ---------------- 软光栅 ---------------- */

const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
// 背景：中性灰摄影棚底（**故意用中灰**：深色手套与浅色刃口要同时看得清，
// 用深色背景会让 dopplerDeep 和手套一起糊掉，等于白测）
for (let y = 0; y < HEIGHT; y += 1) {
  const t = y / HEIGHT;
  const r = Math.round(128 - 26 * t);
  const g = Math.round(136 - 26 * t);
  const b = Math.round(148 - 26 * t);
  for (let x = 0; x < WIDTH; x += 1) {
    const i = (y * WIDTH + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
}

interface Triangle {
  /** 三个顶点的屏幕坐标（x0,y0,x1,y1,x2,y2）。 */
  verts: [number, number, number, number, number, number];
  /** 三个顶点的相机空间深度（更负 = 更远）。 */
  depths: [number, number, number];
  r: number;
  g: number;
  b: number;
}

const triangles: Triangle[] = [];
let debugIndex = 0;
// 主光方向必须跟着相机走：视模型的相机在原点朝 −Z，人物模式的相机在 −Z 朝 +Z。
// 用一条固定光，总有一个模式是"背着光"——正面全变成 45% 亮度，肤色/毛色根本判不出来。
const lightDir = new THREE.Vector3(-0.38, 0.72, TARGET === "avatar" ? -0.58 : 0.55).normalize();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const normal = new THREE.Vector3();
const edge1 = new THREE.Vector3();
const edge2 = new THREE.Vector3();

function toScreen(v: THREE.Vector3): { x: number; y: number; z: number } {
  const cameraSpace = v.clone().applyMatrix4(camera.matrixWorldInverse);
  const projected = v.clone().project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * WIDTH,
    y: (0.5 - projected.y * 0.5) * HEIGHT,
    z: cameraSpace.z,
  };
}

rootObject.traverse((object: THREE.Object3D) => {
  if (!(object instanceof THREE.Mesh) || !object.visible) {
    return;
  }
  // 逐级检查父节点可见性（THREE 的 visible 不会递归影响 children.visible 字段）
  let cursor: THREE.Object3D | null = object;
  while (cursor !== null) {
    if (!cursor.visible) {
      return;
    }
    cursor = cursor.parent;
  }
  // --debug-colors：每个 mesh 一套高饱和色，用来定位"画面上这条奇怪的东西是谁"
  const debugColor = DEBUG_COLORS
    ? new THREE.Color().setHSL((debugIndex * 0.147) % 1, 0.85, 0.55)
    : null;
  if (debugColor !== null) {
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    box.getSize(size);
    console.log(
      `debug #${debugIndex} ${(object.name || "(unnamed)").padEnd(20)} hsl(${((debugIndex * 0.147) % 1 * 360).toFixed(0)}) size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)})`,
    );
    debugIndex += 1;
  }
  // 一个 mesh 可能挂材质数组（`ExtrudeGeometry` 的刀刃就是「大面 + 侧壁」两个 group），
  // 这里按 group 取材质，否则预览图会把刃口的亮白丢掉，看到的是错的。
  const materialList = Array.isArray(object.material) ? object.material : [object.material];
  const geometry = object.geometry;
  const groups = geometry.groups;
  const materialFor = (vertexStart: number): THREE.Material => {
    if (materialList.length === 1) {
      return materialList[0]!;
    }
    const group = groups.find(
      (candidate: { start: number; count: number; materialIndex?: number }) =>
        vertexStart >= candidate.start && vertexStart < candidate.start + candidate.count,
    );
    return materialList[group?.materialIndex ?? 0] ?? materialList[0]!;
  };
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const triangleCount = index !== null ? index.count / 3 : position.count / 3;

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = index !== null ? index.getX(t * 3) : t * 3;
    const i1 = index !== null ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index !== null ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(position, i0).applyMatrix4(object.matrixWorld);
    b.fromBufferAttribute(position, i1).applyMatrix4(object.matrixWorld);
    c.fromBufferAttribute(position, i2).applyMatrix4(object.matrixWorld);

    const material = materialFor(index !== null ? i0 : t * 3) as THREE.MeshStandardMaterial;
    const baseColor = debugColor ?? material.color ?? new THREE.Color(0xcccccc);

    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    normal.crossVectors(edge1, edge2).normalize();
    const lambert = Math.max(0, normal.dot(lightDir));
    const shade = 0.45 + 0.55 * lambert;
    const emissive = material.emissive !== undefined
      ? material.emissive.clone().multiplyScalar(material.emissiveIntensity ?? 0)
      : new THREE.Color(0, 0, 0);

    const sa = toScreen(a);
    const sb = toScreen(b);
    const sc = toScreen(c);
    if (sa.z > -0.01 || sb.z > -0.01 || sc.z > -0.01) {
      continue;
    }
    triangles.push({
      verts: [sa.x, sa.y, sb.x, sb.y, sc.x, sc.y],
      depths: [sa.z, sb.z, sc.z],
      r: Math.min(255, baseColor.r * 255 * shade + emissive.r * 255),
      g: Math.min(255, baseColor.g * 255 * shade + emissive.g * 255),
      b: Math.min(255, baseColor.b * 255 * shade + emissive.b * 255),
    });
  }
});

// 先用画家算法排序（省掉大半 z 测试），再逐像素做 z-buffer 判定。
// 只靠排序的话，互相穿插的两个盒子（比如战术背心压在躯干表面上）会画出假接缝。
triangles.sort((left, right) => {
  const leftDepth = (left.depths[0] + left.depths[1] + left.depths[2]) / 3;
  const rightDepth = (right.depths[0] + right.depths[1] + right.depths[2]) / 3;
  return leftDepth - rightDepth;
});

// 相机空间 z 是负数，越大越近 → 初值取 −Infinity
const zbuffer = new Float32Array(WIDTH * HEIGHT).fill(-Infinity);

function fillTriangle(
  verts: [number, number, number, number, number, number],
  depths: [number, number, number],
  r: number,
  g: number,
  b: number,
): void {
  const x0 = verts[0]!;
  const y0 = verts[1]!;
  const x1 = verts[2]!;
  const y1 = verts[3]!;
  const x2 = verts[4]!;
  const y2 = verts[5]!;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(y0, y1, y2)));
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) {
    return;
  }
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const w0 = ((x1 - x0) * (cy - y0) - (cx - x0) * (y1 - y0)) / area;
      const w1 = ((cx - x0) * (y2 - y0) - (x2 - x0) * (cy - y0)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) {
        continue;
      }
      const index = py * WIDTH + px;
      const z = w0 * depths[0] + w1 * depths[1] + w2 * depths[2];
      if (z <= zbuffer[index]!) {
        continue;
      }
      zbuffer[index] = z;
      const i = index * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
    }
  }
}

for (const triangle of triangles) {
  fillTriangle(triangle.verts, triangle.depths, triangle.r, triangle.g, triangle.b);
}

/* ---------------- PNG 编码（RGBA，filter 0） ---------------- */

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const raw = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  raw[y * (WIDTH * 4 + 1)] = 0;
  Buffer.from(pixels.buffer, y * WIDTH * 4, WIDTH * 4).copy(raw, y * (WIDTH * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(OUT, png);
console.log(`已输出 ${OUT}（槽位 ${SLOT}，三角面 ${triangles.length} 个）`);
