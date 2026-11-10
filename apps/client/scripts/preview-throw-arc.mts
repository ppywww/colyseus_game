/**
 * 投掷抛物线预览（离线出图）。
 *
 * 为什么需要它：抛物线是**纯几何**，但"看起来对不对"只能靠眼睛——
 * 上一版就是因为没法看，才把 3D 小球画成了"脸前一个大圆盘 + 远处一串小水泡"。
 * 这个脚本把 `computeThrowArc` 的结果按**新渲染器的规则**（恒定屏幕像素的圆点 +
 * 落点环）投到一张 PNG 上；加 `--style old` 则按旧渲染器的规则画，方便对照。
 *
 * 用法：
 *   pnpm --filter @colyseus-fps/client exec tsx scripts/preview-throw-arc.mts --pitch 8 --out arc.png
 *   pnpm --filter @colyseus-fps/client exec tsx scripts/preview-throw-arc.mts --style old --pitch 8 --out old.png
 *
 * 参数：
 *   --pitch  俯仰角（度，正 = 抬头），默认 0
 *   --yaw    水平角（度），默认 0（朝 −Z）
 *   --speed  初速度，默认 THROW_SPEED
 *   --style  new（默认）| old
 *   --fov    垂直视角（度），默认 80（与游戏相机一致）
 *   --w/--h  分辨率，默认 960×540
 *   --out    输出 PNG
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
  EYE_HEIGHT,
  THROW_SPEED,
  obstacleColliders,
  stepGrenadePhysics,
  throwOriginOf,
  type Aabb,
} from "@colyseus-fps/shared";

import { computeThrowArc } from "../src/game/throw-arc.js";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) {
    return fallback;
  }
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function strArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const WIDTH = arg("w", 960);
const HEIGHT = arg("h", 540);
const OUT = path.resolve(strArg("out", "throw-arc.png"));
const STYLE = strArg("style", "new");
const FOV_DEG = arg("fov", 80);
const SPEED = arg("speed", THROW_SPEED);
const FUSE = arg("fuse", 1.4);
const pitch = (arg("pitch", 0) * Math.PI) / 180;
const yaw = (arg("yaw", 0) * Math.PI) / 180;

/* ---------------- 相机 / 投影 ---------------- */

const cam = { x: 0, y: EYE_HEIGHT, z: 0 };
const cosPitch = Math.cos(pitch);
// 朝向：yaw = 0 时看 −Z（与 three 的默认朝向一致）
const forward = { x: -Math.sin(yaw) * cosPitch, y: Math.sin(pitch), z: -Math.cos(yaw) * cosPitch };
const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
// up = right × forward
const up = {
  x: right.y * forward.z - right.z * forward.y,
  y: right.z * forward.x - right.x * forward.z,
  z: right.x * forward.y - right.y * forward.x,
};

const focal = HEIGHT / 2 / Math.tan((FOV_DEG * Math.PI) / 360);
const cx = WIDTH / 2;
const cy = HEIGHT / 2;

interface Projected {
  x: number;
  y: number;
  depth: number;
}

function project(point: { x: number; y: number; z: number }): Projected | null {
  const dx = point.x - cam.x;
  const dy = point.y - cam.y;
  const dz = point.z - cam.z;
  const depth = dx * forward.x + dy * forward.y + dz * forward.z;
  if (depth <= 0.05) {
    return null;
  }
  const sx = dx * right.x + dy * right.y + dz * right.z;
  const sy = dx * up.x + dy * up.y + dz * up.z;
  return { x: cx + (sx / depth) * focal, y: cy - (sy / depth) * focal, depth };
}

/* ---------------- 画布 ---------------- */

const pixels = Buffer.alloc(WIDTH * HEIGHT * 4, 255);

function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT || a <= 0) {
    return;
  }
  const i = (y * WIDTH + x) * 4;
  const alpha = Math.min(1, a);
  pixels[i] = Math.round(pixels[i]! * (1 - alpha) + r * alpha);
  pixels[i + 1] = Math.round(pixels[i + 1]! * (1 - alpha) + g * alpha);
  pixels[i + 2] = Math.round(pixels[i + 2]! * (1 - alpha) + b * alpha);
}

/** 柔边圆点（模拟着色器里的 smoothstep 边缘）。 */
function dot(x: number, y: number, radius: number, r: number, g: number, b: number, alpha: number): void {
  const minX = Math.max(0, Math.floor(x - radius - 1));
  const maxX = Math.min(WIDTH - 1, Math.ceil(x + radius + 1));
  const minY = Math.max(0, Math.floor(y - radius - 1));
  const maxY = Math.min(HEIGHT - 1, Math.ceil(y + radius + 1));
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      const edge = Math.min(1, Math.max(0, (radius - d) / Math.max(0.75, radius * 0.35)));
      blend(px, py, r, g, b, alpha * edge);
    }
  }
}

function line(from: Projected, to: Projected, r: number, g: number, b: number, alpha: number): void {
  const steps = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    // 近处线段不要用直线插值糊弄：深度线性插值已经足够画地板网格
    dot(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 0.7, r, g, b, alpha);
  }
}

// 天空（对齐游戏里的暖色雾）
for (let y = 0; y < HEIGHT; y += 1) {
  const t = y / HEIGHT;
  const r = Math.round(252 - 18 * t);
  const g = Math.round(232 - 26 * t);
  const b = Math.round(196 - 30 * t);
  for (let x = 0; x < WIDTH; x += 1) {
    const i = (y * WIDTH + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  }
}

// 地面：地平线以下填沙色。地平线 = 与眼睛同高、无穷远处的点的投影
// （旧版这里写死 cy，低头时地面填色和网格线对不上，看起来像"地平线裂成两层"）
const horizon = project({ x: cam.x, y: cam.y, z: -1e5 });
const horizonY = horizon === null ? cy : horizon.y;
for (let y = Math.max(0, Math.floor(horizonY)); y < HEIGHT; y += 1) {
  const t = (y - horizonY) / Math.max(1, HEIGHT - horizonY);
  const shade = 0.78 + 0.22 * (1 - t);
  for (let x = 0; x < WIDTH; x += 1) {
    const i = (y * WIDTH + x) * 4;
    pixels[i] = Math.round(196 * shade + 40);
    pixels[i + 1] = Math.round(182 * shade + 40);
    pixels[i + 2] = Math.round(150 * shade + 36);
  }
}

// 地板网格（每 2m 一条），提供纵深参照
for (let k = -10; k <= 10; k += 1) {
  for (let segment = 0; segment < 24; segment += 1) {
    const z0 = 1 + segment * 2.5;
    const z1 = z0 + 2.5;
    const a = project({ x: k * 2, y: 0, z: -z0 });
    const b = project({ x: k * 2, y: 0, z: -z1 });
    if (a !== null && b !== null) {
      line(a, b, 120, 108, 84, 0.5);
    }
  }
}
for (let k = 1; k <= 26; k += 1) {
  const z = -k * 2.5;
  const a = project({ x: -20, y: 0, z });
  const b = project({ x: 20, y: 0, z });
  if (a !== null && b !== null) {
    line(a, b, 120, 108, 84, 0.5);
  }
}

/* ---------------- 轨迹 ---------------- */

const dir = { x: -Math.sin(yaw) * cosPitch, y: Math.sin(pitch), z: -Math.cos(yaw) * cosPitch };
const origin = throwOriginOf(cam.x, cam.y - EYE_HEIGHT, cam.z, dir, EYE_HEIGHT);
const colliders: readonly Aabb[] = obstacleColliders();
const arc = computeThrowArc(origin, dir, SPEED, colliders, FUSE);

// 与渲染器同色（`type === "smoke"` 的 0x3d8ce8）；旧风格当时用的是 0x9fd4ff，这里统一成同一色便于对照
const LINE = { r: 61, g: 140, b: 232 };

if (STYLE === "new") {
  // 与着色器一致：恒定 7 CSS 像素直径 → 半径 3.5（这里 1 单位 = 1 像素）
  const radius = 3;
  const count = arc.points.length;
  for (let index = 0; index < count; index += 1) {
    const projected = project(arc.points[index]!);
    if (projected === null) {
      continue;
    }
    const fade = 1 - 0.55 * (count <= 1 ? 0 : index / (count - 1));
    dot(projected.x, projected.y, radius, LINE.r, LINE.g, LINE.b, 0.95 * fade);
  }

  if (arc.endpoint !== null) {
    // 与渲染器一致：环的世界半径随距离放大，保证屏幕上的最小尺寸
    const projY = 1 / Math.tan((FOV_DEG * Math.PI) / 360);
    const ringDistance = Math.hypot(
      arc.endpoint.x - cam.x,
      arc.endpoint.y - cam.y,
      arc.endpoint.z - cam.z,
    );
    const ringRadius = Math.max(0.3, (0.075 * ringDistance) / projY);
    if (arc.atGround) {
      // 贴地：环平铺在地面上（画成世界空间里的水平圆）
      const center = { x: arc.endpoint.x, z: arc.endpoint.z, y: arc.endpoint.y - 0.11 + 0.02 };
      const segments = 28;
      let previous = null as Projected | null;
      for (let s = 0; s <= segments; s += 1) {
        const angle = (s / segments) * Math.PI * 2;
        const point = project({
          x: center.x + Math.cos(angle) * ringRadius,
          y: center.y,
          z: center.z + Math.sin(angle) * ringRadius,
        });
        if (previous !== null && point !== null) {
          line(previous, point, LINE.r, LINE.g, LINE.b, 0.75);
        }
        previous = point;
      }
    } else {
      // 空中引爆：环正对镜头（屏幕空间圆，半径按透视缩放）
      const center = project(arc.endpoint);
      if (center !== null) {
        const radius = Math.max(2, (ringRadius * focal) / center.depth);
        for (let s = 0; s <= 48; s += 1) {
          const angle = (s / 48) * Math.PI * 2;
          dot(
            center.x + Math.cos(angle) * radius,
            center.y + Math.sin(angle) * radius,
            0.9,
            LINE.r,
            LINE.g,
            LINE.b,
            0.75,
          );
        }
      }
    }
  }
} else {
  // 旧渲染器：每 0.1s 一个 3D 小球（半径 4.5cm），按透视缩放
  const body = {
    x: origin.x,
    y: origin.y,
    z: origin.z,
    vx: dir.x * SPEED,
    vy: dir.y * SPEED,
    vz: dir.z * SPEED,
  };
  let drawn = 0;
  for (let frame = 0; frame < 260 && drawn < 40; frame += 1) {
    stepGrenadePhysics(body, 1 / 60, colliders);
    if (frame % 6 !== 0) {
      continue;
    }
    const projected = project({ x: body.x, y: body.y, z: body.z });
    drawn += 1;
    if (projected === null) {
      continue;
    }
    const radius = Math.max(0.8, (0.045 * focal) / projected.depth);
    const fade = 1 - (drawn / 40) * 0.45;
    dot(projected.x, projected.y, radius, LINE.r, LINE.g, LINE.b, 0.62 * fade);
  }
}

// 准星（屏幕正中）
for (let offset = -6; offset <= 6; offset += 1) {
  blend(Math.round(cx) + offset, Math.round(cy), 240, 245, 250, 0.9);
  blend(Math.round(cx), Math.round(cy) + offset, 240, 245, 250, 0.9);
}

/* ---------------- PNG 输出 ---------------- */

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
  pixels.copy(raw, y * (WIDTH * 4 + 1) + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;
ihdr[9] = 6;
writeFileSync(
  OUT,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);

const landingText = arc.endpoint === null
  ? "无生效点"
  : `生效点 (${arc.endpoint.x.toFixed(2)}, ${arc.endpoint.y.toFixed(2)}, ${arc.endpoint.z.toFixed(2)})` +
    `，距出手 ${Math.hypot(arc.endpoint.x - origin.x, arc.endpoint.z - origin.z).toFixed(2)}m` +
    `，${arc.atGround ? "贴地" : "空中"}`;
const firstProjected = arc.points.length > 0 ? project(arc.points[0]!) : null;
const lastProjected = arc.points.length > 0 ? project(arc.points[arc.points.length - 1]!) : null;
if (firstProjected !== null && lastProjected !== null) {
  console.log(
    `屏幕位置：首个点 (${firstProjected.x.toFixed(0)}, ${firstProjected.y.toFixed(0)})` +
      ` → 末点 (${lastProjected.x.toFixed(0)}, ${lastProjected.y.toFixed(0)})`,
  );
}
console.log(`${STYLE} 风格：${arc.points.length} 个点，${landingText}`);
console.log(`已输出 ${OUT}`);
