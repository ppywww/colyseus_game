/**
 * 战斗特效：弹道、枪口火光、弹着火花/烟尘、爆炸冲击波与火光。
 *
 * 所有特效都是短生命周期的临时对象，update() 中统一渐隐与释放，
 * 避免长时间对局后对象堆积导致掉帧。
 */

import * as THREE from "three";

interface Tracer {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  bornAt: number;
}

interface Effect {
  object: THREE.Object3D;
  bornAt: number;
  lifeMs: number;
  update: (progress: number) => void;
  dispose: () => void;
}

const TRACER_LIFE_MS = 110;

/**
 * 枪口火光在相机坐标系中的基准位置（fov 80 单 pass 方案，见参考文档 2.6.1）。
 * 运行时会被 {@link CombatEffects#setMuzzleOffset} 用视模型枪口挂点的实时偏移覆盖，
 * 这里的值只作为「视模型还没初始化好」时的兜底。
 */
const MUZZLE_OFFSET = { x: 0.205, y: -0.169, z: -0.997 } as const;

/** 点光源位置：比火光 sprite 略靠近相机、略高，方便照亮墙面。 */
const MUZZLE_LIGHT_OFFSET = { x: 0.205, y: -0.165, z: -0.985 } as const;

/** 火光 sprite 缩放区间：0.22 占屏高 13.5%，0.28 ≈ 15.9%（旧值 0.45 会占 27.6%，明显过大）。 */
const MUZZLE_SCALE_MIN = 0.22;
const MUZZLE_SCALE_RANGE = 0.06;

/** 生成径向渐变贴图（火花 / 烟雾 / 枪口火光共用）。 */
function radialTexture(inner: string, outer: string, size = 64): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, inner);
    gradient.addColorStop(0.45, inner);
    gradient.addColorStop(1, outer);
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class CombatEffects {
  private readonly tracers: Tracer[] = [];
  private readonly effects: Effect[] = [];
  private readonly sparkTexture: THREE.Texture;
  private readonly smokeTexture: THREE.Texture;
  private readonly flashTexture: THREE.Texture;
  private readonly muzzle: THREE.Sprite;
  private readonly muzzleLight: THREE.PointLight;
  private muzzleUntil = 0;

  public constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    this.sparkTexture = radialTexture("rgba(255,236,180,1)", "rgba(255,150,40,0)");
    this.smokeTexture = radialTexture("rgba(210,214,222,0.95)", "rgba(150,156,168,0)");
    this.flashTexture = radialTexture("rgba(255,246,214,1)", "rgba(255,170,60,0)");

    this.muzzle = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flashTexture,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      }),
    );
    this.muzzle.scale.set(MUZZLE_SCALE_MIN, MUZZLE_SCALE_MIN, 1);
    this.muzzle.position.set(MUZZLE_OFFSET.x, MUZZLE_OFFSET.y, MUZZLE_OFFSET.z);
    this.muzzle.visible = false;
    this.camera.add(this.muzzle);

    this.muzzleLight = new THREE.PointLight(0xffd9a0, 0, 14, 2);
    this.muzzleLight.position.set(MUZZLE_LIGHT_OFFSET.x, MUZZLE_LIGHT_OFFSET.y, MUZZLE_LIGHT_OFFSET.z);
    this.camera.add(this.muzzleLight);
  }

  /**
   * 同步枪口火光的挂点（相机坐标系）。
   *
   * 视模型每帧把枪口挂点的世界位置换算回相机空间后传进来，火光与点光源因此
   * 会跟着后坐、换弹、投掷一起动——这是「火光始终贴在枪口帽正前方」的关键。
   */
  public setMuzzleOffset(offset: { x: number; y: number; z: number }): void {
    this.muzzle.position.set(offset.x, offset.y, offset.z);
    this.muzzleLight.position.set(offset.x, offset.y + 0.004, offset.z + 0.012);
  }

  /** 弹道轨迹：从枪口到命中点的短促亮线。 */
  public addTracer(origin: { x: number; y: number; z: number }, hit: { x: number; y: number; z: number }): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(origin.x, origin.y, origin.z),
      new THREE.Vector3(hit.x, hit.y, hit.z),
    ]);
    const material = new THREE.LineBasicMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    this.tracers.push({ line, material, bornAt: performance.now() });
  }

  /** 枪口火光：短促亮度脉冲 + 点光源照亮环境（CS 式反馈的关键）。 */
  public muzzleFlash(nowMs: number): void {
    this.muzzleUntil = nowMs + 45;
    this.muzzle.visible = true;
    this.muzzle.material.rotation = Math.random() * Math.PI;
    const scale = MUZZLE_SCALE_MIN + Math.random() * MUZZLE_SCALE_RANGE;
    this.muzzle.scale.set(scale, scale, 1);
    this.muzzleLight.intensity = 9;
  }

  /** 弹着点：火花四溅 + 短暂烟尘（打墙/打空时使用）。 */
  public impact(point: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }): void {
    const now = performance.now();
    const group = new THREE.Group();
    group.position.set(point.x, point.y, point.z);

    const sparkCount = 10;
    const positions = new Float32Array(sparkCount * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < sparkCount; i += 1) {
      const velocity = new THREE.Vector3(
        normal.x + (Math.random() - 0.5) * 1.6,
        normal.y + Math.random() * 1.4,
        normal.z + (Math.random() - 0.5) * 1.6,
      ).multiplyScalar(2 + Math.random() * 3);
      velocities.push(velocity);
    }
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const sparkMaterial = new THREE.PointsMaterial({
      map: this.sparkTexture,
      size: 0.11,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: 0xffd28a,
    });
    const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
    group.add(sparks);

    const puff = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.smokeTexture, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    puff.scale.set(0.4, 0.4, 1);
    puff.position.set(normal.x * 0.05, normal.y * 0.05 + 0.05, normal.z * 0.05);
    group.add(puff);

    this.scene.add(group);

    const lifeMs = 320;
    this.effects.push({
      object: group,
      bornAt: now,
      lifeMs,
      update: (progress: number) => {
        const attribute = sparkGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < sparkCount; i += 1) {
          const velocity = velocities[i] as THREE.Vector3;
          attribute.setXYZ(
            i,
            velocity.x * progress * 0.32,
            velocity.y * progress * 0.32 - 2.4 * progress * progress * 0.32,
            velocity.z * progress * 0.32,
          );
        }
        attribute.needsUpdate = true;
        sparkMaterial.opacity = 1 - progress;
        puff.scale.setScalar(0.4 + progress * 0.6);
        puff.material.opacity = 0.5 * (1 - progress);
      },
      dispose: () => {
        sparkGeometry.dispose();
        sparkMaterial.dispose();
        puff.material.dispose();
      },
    });
  }

  /** 手雷爆炸：火光、冲击波圆环、上扬烟团。 */
  public explosion(point: { x: number; y: number; z: number }, radius: number): void {
    const now = performance.now();
    const group = new THREE.Group();
    group.position.set(point.x, Math.max(0.2, point.y), point.z);

    const light = new THREE.PointLight(0xffb347, 60, radius * 3.2, 2);
    light.position.set(0, 0.6, 0);
    group.add(light);

    const fireball = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flashTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    fireball.scale.setScalar(1.4);
    group.add(fireball);

    const ringGeometry = new THREE.RingGeometry(0.6, 0.85, 48);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    const puffs: THREE.Sprite[] = [];
    for (let i = 0; i < 8; i += 1) {
      const puff = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.smokeTexture, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      const angle = (i / 8) * Math.PI * 2;
      puff.position.set(Math.cos(angle) * 0.5, 0.3 + Math.random() * 0.4, Math.sin(angle) * 0.5);
      puff.scale.setScalar(0.9);
      group.add(puff);
      puffs.push(puff);
    }

    this.scene.add(group);

    const lifeMs = 900;
    this.effects.push({
      object: group,
      bornAt: now,
      lifeMs,
      update: (progress: number) => {
        light.intensity = 60 * (1 - progress) ** 2;
        fireball.scale.setScalar(1.4 + progress * 2.6);
        fireball.material.opacity = Math.max(0, 1 - progress * 1.6);
        ring.scale.setScalar(1 + progress * radius * 0.9);
        ringMaterial.opacity = 0.75 * (1 - progress);
        for (const puff of puffs) {
          puff.position.y += 0.012;
          puff.scale.setScalar(0.9 + progress * 2.2);
          puff.material.opacity = 0.55 * (1 - progress);
        }
      },
      dispose: () => {
        ringGeometry.dispose();
        ringMaterial.dispose();
        fireball.material.dispose();
        for (const puff of puffs) {
          puff.material.dispose();
        }
      },
    });
  }

  /** 闪光弹爆点：白炽球体（真正的致盲由 HUD 全屏遮罩完成）。 */
  public flashBurst(point: { x: number; y: number; z: number }): void {
    const now = performance.now();
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flashTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    sprite.position.set(point.x, Math.max(0.3, point.y), point.z);
    sprite.scale.setScalar(1);
    this.scene.add(sprite);

    const light = new THREE.PointLight(0xffffff, 90, 26, 2);
    light.position.copy(sprite.position);
    this.scene.add(light);

    this.effects.push({
      object: sprite,
      bornAt: now,
      lifeMs: 420,
      update: (progress: number) => {
        sprite.scale.setScalar(1 + progress * 6);
        sprite.material.opacity = 1 - progress;
        light.intensity = 90 * (1 - progress) ** 2;
      },
      dispose: () => {
        sprite.material.dispose();
        this.scene.remove(light);
        light.dispose();
      },
    });
  }

  /** 每帧：维护枪口火光衰减与所有临时特效生命周期。 */
  public update(nowMs: number): void {
    if (this.muzzleUntil > 0) {
      const remain = this.muzzleUntil - nowMs;
      if (remain <= 0) {
        this.muzzle.visible = false;
        this.muzzleLight.intensity = 0;
        this.muzzleUntil = 0;
      } else {
        this.muzzleLight.intensity = 9 * Math.min(1, remain / 45);
      }
    }

    for (let i = this.tracers.length - 1; i >= 0; i -= 1) {
      const tracer = this.tracers[i] as Tracer;
      const age = nowMs - tracer.bornAt;
      if (age >= TRACER_LIFE_MS) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        tracer.material.dispose();
        this.tracers.splice(i, 1);
      } else {
        tracer.material.opacity = 0.85 * (1 - age / TRACER_LIFE_MS);
      }
    }

    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i] as Effect;
      const progress = (nowMs - effect.bornAt) / effect.lifeMs;
      if (progress >= 1) {
        this.scene.remove(effect.object);
        effect.dispose();
        this.effects.splice(i, 1);
      } else {
        effect.update(progress);
      }
    }
  }

  public dispose(): void {
    for (const tracer of this.tracers) {
      this.scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.material.dispose();
    }
    this.tracers.length = 0;

    for (const effect of this.effects) {
      this.scene.remove(effect.object);
      effect.dispose();
    }
    this.effects.length = 0;

    this.camera.remove(this.muzzle);
    this.muzzle.material.dispose();
    this.camera.remove(this.muzzleLight);
    this.muzzleLight.dispose();
    this.sparkTexture.dispose();
    this.smokeTexture.dispose();
    this.flashTexture.dispose();
  }
}
