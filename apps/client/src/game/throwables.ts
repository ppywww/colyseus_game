/**
 * 投掷物表现层：
 *   - 服务端广播「已投出」后，客户端按同一套常量本地模拟抛物线（视觉即时，无抖动）；
 *   - 爆炸点、烟雾位置以服务端消息/状态为准，不回传客户端计算结果；
 *   - 烟雾云按状态中的 expiresAt 自行淡入淡出。
 */

import * as THREE from "three";

import {
  MAP_BOUNDS,
  GRENADE_BOUNCE,
  GRENADE_GRAVITY,
  GRENADE_RADIUS,
  THROWABLES,
  type ExplosionMessage,
  type GrenadeLaunchedMessage,
  type SmokeCloudView,
  type ThrowableType,
} from "@colyseus-fps/shared";

import { CombatEffects } from "./effects.js";

interface LocalGrenade {
  id: number;
  type: ThrowableType;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

interface SmokeVisual {
  id: string;
  group: THREE.Group;
  sprites: THREE.Sprite[];
  expiresAt: number;
  bornAt: number;
}

const SMOKE_SPRITE_COUNT = 14;

/** 生成柔和的烟团贴图（径向渐变 + 轻微噪点感）。 */
function smokeTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(232,235,240,0.95)");
    gradient.addColorStop(0.5, "rgba(206,211,220,0.55)");
    gradient.addColorStop(1, "rgba(180,186,196,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ThrowableSystem {
  private readonly grenades = new Map<number, LocalGrenade>();
  private readonly clouds = new Map<string, SmokeVisual>();
  private readonly smoke = smokeTexture();
  private readonly grenadeGeometry = new THREE.SphereGeometry(GRENADE_RADIUS, 12, 10);

  public constructor(
    private readonly scene: THREE.Scene,
    private readonly effects: CombatEffects,
  ) {}

  /** 服务端广播投掷：立刻生成本地预测的飞行体。 */
  public spawnLaunched(message: GrenadeLaunchedMessage): void {
    if (this.grenades.has(message.id)) {
      return;
    }
    const config = THROWABLES[message.type];
    const material = new THREE.MeshStandardMaterial({
      color: config.color,
      roughness: 0.55,
      metalness: 0.35,
      emissive: config.color,
      emissiveIntensity: message.type === "frag" ? 0.25 : 0.1,
    });
    const mesh = new THREE.Mesh(this.grenadeGeometry, material);
    mesh.position.set(message.origin.x, message.origin.y, message.origin.z);
    this.scene.add(mesh);

    this.grenades.set(message.id, {
      id: message.id,
      type: message.type,
      mesh,
      material,
      x: message.origin.x,
      y: message.origin.y,
      z: message.origin.z,
      vx: message.velocity.x,
      vy: message.velocity.y,
      vz: message.velocity.z,
    });
  }

  /** 服务端广播生效：播放对应视觉，并移除本地飞行体。 */
  public spawnExplosion(message: ExplosionMessage): void {
    this.removeGrenade(message.id);
    const point = { x: message.x, y: message.y, z: message.z };

    if (message.type === "frag") {
      this.effects.explosion(point, message.radius);
    } else if (message.type === "flash") {
      this.effects.flashBurst(point);
    }
    // 烟雾云由状态同步驱动渲染，这里不再额外生成
  }

  /** 按服务端状态同步烟雾云（新增/移除/过期）。 */
  public syncClouds(clouds: readonly SmokeCloudView[]): void {
    const seen = new Set<string>();
    for (const cloud of clouds) {
      seen.add(cloud.id);
      if (!this.clouds.has(cloud.id)) {
        this.createCloud(cloud);
      }
    }
    for (const [id, visual] of this.clouds) {
      if (!seen.has(id)) {
        this.destroyCloud(id, visual);
      }
    }
  }

  private createCloud(cloud: SmokeCloudView): void {
    const group = new THREE.Group();
    group.position.set(cloud.x, 0.7, cloud.z);
    const sprites: THREE.Sprite[] = [];

    for (let i = 0; i < SMOKE_SPRITE_COUNT; i += 1) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.smoke,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      const angle = (i / SMOKE_SPRITE_COUNT) * Math.PI * 2 + Math.random() * 0.4;
      const radius = cloud.radius * (0.25 + Math.random() * 0.55);
      sprite.position.set(Math.cos(angle) * radius, (Math.random() - 0.3) * 1.6, Math.sin(angle) * radius);
      const scale = cloud.radius * (0.9 + Math.random() * 0.7);
      sprite.scale.set(scale, scale, 1);
      group.add(sprite);
      sprites.push(sprite);
    }

    this.scene.add(group);
    this.clouds.set(cloud.id, {
      id: cloud.id,
      group,
      sprites,
      expiresAt: cloud.expiresAt,
      bornAt: performance.now(),
    });
  }

  private destroyCloud(id: string, visual: SmokeVisual): void {
    this.scene.remove(visual.group);
    for (const sprite of visual.sprites) {
      sprite.material.dispose();
    }
    this.clouds.delete(id);
  }

  private removeGrenade(id: number): void {
    const grenade = this.grenades.get(id);
    if (grenade === undefined) {
      return;
    }
    this.scene.remove(grenade.mesh);
    grenade.material.dispose();
    this.grenades.delete(id);
  }

  /** 每帧：推进本地抛物线（约 20Hz 精度的指数积分），并做烟雾淡入淡出。 */
  public update(dtSeconds: number, nowMs: number): void {
    for (const grenade of this.grenades.values()) {
      grenade.vy -= GRENADE_GRAVITY * dtSeconds;
      grenade.x += grenade.vx * dtSeconds;
      grenade.y += grenade.vy * dtSeconds;
      grenade.z += grenade.vz * dtSeconds;

      if (grenade.y < GRENADE_RADIUS) {
        grenade.y = GRENADE_RADIUS;
        if (grenade.vy < 0) {
          grenade.vy = -grenade.vy * GRENADE_BOUNCE;
          grenade.vx *= 0.82;
          grenade.vz *= 0.82;
          if (Math.abs(grenade.vy) < 0.6) {
            grenade.vy = 0;
          }
        }
      }

      // 场地边界：矩形反弹（逐轴 clamp + 对应速度分量反向），与服务端 stepGrenade 完全一致。
      // 圆形钳制在 64×64 矩形地图里会把角落的手雷"吸"向中心，导致客户端预测与服务端位置打架。
      const maxX = MAP_BOUNDS.maxX - GRENADE_RADIUS;
      const minX = MAP_BOUNDS.minX + GRENADE_RADIUS;
      const maxZ = MAP_BOUNDS.maxZ - GRENADE_RADIUS;
      const minZ = MAP_BOUNDS.minZ + GRENADE_RADIUS;
      if (grenade.x > maxX) {
        grenade.x = maxX;
        grenade.vx = -Math.abs(grenade.vx) * GRENADE_BOUNCE;
      } else if (grenade.x < minX) {
        grenade.x = minX;
        grenade.vx = Math.abs(grenade.vx) * GRENADE_BOUNCE;
      }
      if (grenade.z > maxZ) {
        grenade.z = maxZ;
        grenade.vz = -Math.abs(grenade.vz) * GRENADE_BOUNCE;
      } else if (grenade.z < minZ) {
        grenade.z = minZ;
        grenade.vz = Math.abs(grenade.vz) * GRENADE_BOUNCE;
      }

      grenade.mesh.position.set(grenade.x, grenade.y, grenade.z);
      grenade.mesh.rotation.x += dtSeconds * 8;
      grenade.mesh.rotation.z += dtSeconds * 6;
    }

    for (const [id, visual] of this.clouds) {
      const age = nowMs - visual.bornAt;
      const remain = visual.expiresAt - nowMs;
      if (remain <= 0) {
        this.destroyCloud(id, visual);
        continue;
      }
      const fadeIn = Math.min(1, age / 500);
      const fadeOut = Math.min(1, remain / 2000);
      const opacity = 0.55 * fadeIn * fadeOut;
      for (const sprite of visual.sprites) {
        sprite.material.opacity = opacity;
      }
      visual.group.rotation.y += dtSeconds * 0.05;
    }
  }

  public dispose(): void {
    for (const grenade of this.grenades.values()) {
      this.scene.remove(grenade.mesh);
      grenade.material.dispose();
    }
    this.grenades.clear();

    for (const [id, visual] of this.clouds) {
      this.destroyCloud(id, visual);
    }
    this.grenadeGeometry.dispose();
    this.smoke.dispose();
  }
}
