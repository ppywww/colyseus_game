/**
 * 投掷物表现层：
 *   - 服务端广播「已投出」后，客户端按同一套常量本地模拟抛物线（视觉即时，无抖动）；
 *   - 爆炸点、烟雾位置以服务端消息/状态为准，不回传客户端计算结果；
 *   - 烟雾云按状态中的 expiresAt 自行淡入淡出。
 */

import * as THREE from "three";

import {
  GRENADE_RADIUS,
  THROWABLES,
  obstacleColliders,
  stepGrenadePhysics,
  type Aabb,
  type ExplosionMessage,
  type GrenadeLaunchedMessage,
  type SmokeCloudView,
  type ThrowableType,
} from "@colyseus-fps/shared";

import { CombatEffects } from "./effects.js";
import { ARC_MAX_POINTS, computeThrowArc } from "./throw-arc.js";

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

/** 落点环的世界半径（米）：画面里的最小尺寸由 {@link LANDING_RING_MIN_NDC} 兜底。 */
const LANDING_RING_RADIUS = 0.3;

/**
 * 落点环的**最小半屏占比**（NDC，1 = 半个屏幕高）。
 *
 * 换算成 1080p 大约是 40px 半径：不管扔多远，玩家都能一眼看到"雷会停在这儿"。
 * 不兜底的话，18m 外的环只有 20px 宽，会被点阵和地面纹理吃掉。
 */
const LANDING_RING_MIN_NDC = 0.075;

/**
 * 手雷弹道用的掩体 AABB（与客户端物理、服务端弹道遮挡同一份数据）。
 * 只算一次：地图是静态的，没必要每帧重建上百个盒子。
 */
const GRENADE_COLLIDERS: readonly Aabb[] = obstacleColliders();

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

  /* ---------------- 投掷抛物线辅助 ---------------- */

  /**
   * 辅助线上的点。
   *
   * 用 `THREE.Points` + 自定义 shader，**屏幕像素恒定**，而不是 3D 小球：
   * 3D 小球会被透视缩放——出手点离眼睛只有 45cm，那颗球在 1080p 下能画成 150px 的
   * 大圆盘糊在屏幕正中；而 20m 外的点只有 2px，整条线看起来像"一串越来越小的水泡"。
   * 恒定像素才是"瞄准辅助线"该有的读感（CS2 的投掷轨迹、Valorant 的技能路径都是这么画的）。
   */
  private readonly arcPoints: THREE.Points;
  private readonly arcGeometry: THREE.BufferGeometry;
  private readonly arcPositions: Float32Array;
  private readonly arcFades: Float32Array;
  private readonly arcMaterial: THREE.ShaderMaterial;
  /** 生效点环：玩家真正想看的是"雷会在这儿生效"，不是一个渐隐的点。 */
  private readonly landingRing: THREE.Mesh;
  private readonly landingMaterial: THREE.MeshBasicMaterial;
  private arcType: ThrowableType | null = null;

  public constructor(
    private readonly scene: THREE.Scene,
    private readonly effects: CombatEffects,
  ) {
    this.arcPositions = new Float32Array(ARC_MAX_POINTS * 3);
    this.arcFades = new Float32Array(ARC_MAX_POINTS);
    this.arcGeometry = new THREE.BufferGeometry();
    this.arcGeometry.setAttribute("position", new THREE.BufferAttribute(this.arcPositions, 3));
    this.arcGeometry.setAttribute("aFade", new THREE.BufferAttribute(this.arcFades, 1));
    this.arcGeometry.setDrawRange(0, 0);

    this.arcMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x3d8ce8) },
        // CSS 像素，着色器里再乘设备像素比
        uSize: { value: 7 },
        uPixelRatio: { value: 1 },
        uOpacity: { value: 0.95 },
      },
      vertexShader: `
        attribute float aFade;
        uniform float uSize;
        uniform float uPixelRatio;
        varying float vFade;
        void main() {
          vFade = aFade;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          // 不做距离衰减：点的大小是"屏幕像素"，与远近无关
          gl_PointSize = uSize * uPixelRatio;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vFade;
        void main() {
          // gl_PointCoord 是 0..1 的方形贴图坐标：裁成圆，并留 1 像素软边
          float d = length(gl_PointCoord - vec2(0.5));
          float alpha = smoothstep(0.5, 0.34, d);
          if (alpha <= 0.02) {
            discard;
          }
          gl_FragColor = vec4(uColor, alpha * vFade * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      // 仍然参与深度测试：被墙、箱子挡住时辅助线要跟着消失，
      // 否则会出现"隔墙能看见落点"的透视挂效果。
      depthTest: true,
    });

    this.arcPoints = new THREE.Points(this.arcGeometry, this.arcMaterial);
    this.arcPoints.frustumCulled = false;
    this.arcPoints.visible = false;
    this.arcPoints.name = "throw-arc";
    this.arcPoints.renderOrder = 3;
    this.scene.add(this.arcPoints);

    this.landingMaterial = new THREE.MeshBasicMaterial({
      color: 0x3d8ce8,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // 用 Ring 而不是实心圆：环不遮挡落点下方的地面细节，也更容易和"点"区分开。
    this.landingRing = new THREE.Mesh(
      // 环带占外径的 34%：缩到最小尺寸时也有 5px 厚，远距离不会细成一根线
      new THREE.RingGeometry(LANDING_RING_RADIUS * 0.66, LANDING_RING_RADIUS, 28),
      this.landingMaterial,
    );
    this.landingRing.rotation.x = -Math.PI / 2;
    this.landingRing.visible = false;
    this.landingRing.name = "throw-arc-landing";
    this.landingRing.renderOrder = 3;
    this.scene.add(this.landingRing);
  }

  /**
   * 更新投掷抛物线辅助线。
   *
   * 几何完全交给 {@link computeThrowArc}（和"雷会飞到哪里"是同一份计算），
   * 这里只做两件事：把点搬进 GPU 缓冲、把落点环摆到预测停下的位置。
   *
   * @param origin 出手点（用 shared 的 `throwOriginOf` 算，与服务端出膛点一致）
   * @param dir 归一化投掷方向
   * @param speed 初速度
   * @param type 投掷物类型（决定颜色与**引信时长**——烟雾 1.4s 就起烟，不按引信截断的线会骗人）
   * @param camera 相机（空中引爆时落点环要正对镜头；不传就平铺）
   */
  public updateAimArc(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    speed: number,
    type: ThrowableType,
    camera: THREE.Camera | null = null,
  ): void {
    if (this.arcType !== type) {
      this.arcType = type;
      // 三种投掷物用不同颜色，避免"以为拿的是闪、其实是烟"
      // 三种投掷物用三种颜色，避免"以为拿的是闪、其实是烟"。
      // 都用**中饱和**色：浅色点在米色天空上看不见，深色点在暗墙上又看不见。
      const color: number = type === "frag" ? 0xff8a3d : type === "flash" ? 0xf5f9ff : 0x3d8ce8;
      (this.arcMaterial.uniforms.uColor?.value as THREE.Color).setHex(color);
      this.landingMaterial.color.setHex(color);
    }

    const arc = computeThrowArc(
      origin,
      dir,
      speed,
      GRENADE_COLLIDERS,
      THROWABLES[type].fuseMs / 1000,
    );
    const count = arc.points.length;

    for (let index = 0; index < count; index += 1) {
      const point = arc.points[index]!;
      this.arcPositions[index * 3] = point.x;
      this.arcPositions[index * 3 + 1] = point.y;
      this.arcPositions[index * 3 + 2] = point.z;
      // 越远越淡：尾巴收干净，落点环才站出来当主角
      this.arcFades[index] = 1 - 0.55 * (count <= 1 ? 0 : index / (count - 1));
    }
    this.arcGeometry.setDrawRange(0, count);
    (this.arcGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.arcGeometry.getAttribute("aFade") as THREE.BufferAttribute).needsUpdate = true;

    // 材质里存的是 CSS 像素，乘上设备像素比才是真实帧缓冲像素（高分屏不糊、低分屏不虚）
    this.arcMaterial.uniforms.uPixelRatio!.value =
      typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    this.arcPoints.visible = count > 0;

    if (arc.endpoint === null) {
      this.landingRing.visible = false;
      return;
    }

    // 环的**屏幕尺寸**要兜个底：18m 外的 0.3m 圆环只有 20px，正好被点阵盖住，
    // 等于白画。这里按投影矩阵把"最小屏幕尺寸"折回世界尺寸，距离越远环越大，
    // 位置仍然精确（只是标记变大，像地图 pin 那样）。
    const pulse = 1 + 0.06 * Math.sin(performance.now() / 180);
    let scale = pulse;
    if (camera !== null) {
      const projY = camera.projectionMatrix.elements[5] as number;
      const distance = camera.position.distanceTo(
        new THREE.Vector3(arc.endpoint.x, arc.endpoint.y, arc.endpoint.z),
      );
      if (projY > 1e-6 && distance > 0.1) {
        const minWorldRadius = (LANDING_RING_MIN_NDC * distance) / projY;
        scale *= Math.max(1, minWorldRadius / LANDING_RING_RADIUS);
      }
    }
    this.landingRing.scale.setScalar(scale);
    if (arc.atGround) {
      // 静止/贴地：环平铺在支撑面上（body.y = 支撑面 + 半径，抬 2cm 防 z-fighting）
      this.landingRing.position.set(
        arc.endpoint.x,
        arc.endpoint.y - GRENADE_RADIUS + 0.02,
        arc.endpoint.z,
      );
      this.landingRing.rotation.set(-Math.PI / 2, 0, 0);
    } else {
      // 空中引爆（引信到点时雷还在飞）：平铺的环会被看成"地上有个圈"，
      // 所以改成正对镜头的圆环，读作"这里会炸"。
      this.landingRing.position.set(arc.endpoint.x, arc.endpoint.y, arc.endpoint.z);
      if (camera !== null) {
        this.landingRing.lookAt(camera.position);
      } else {
        this.landingRing.rotation.set(-Math.PI / 2, 0, 0);
      }
    }
    this.landingRing.visible = true;
  }

  public hideAimArc(): void {
    this.arcPoints.visible = false;
    this.landingRing.visible = false;
  }

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

  /** 每帧：推进本地抛物线（与服务端共用 shared 的 stepGrenadePhysics），并做烟雾淡入淡出。 */
  public update(dtSeconds: number, nowMs: number): void {
    for (const grenade of this.grenades.values()) {
      // 物理与服务端 `stepGrenade` 是**同一个函数**（shared 的 `stepGrenadePhysics`）：
      // 重力、地面反弹、64 个掩体 AABB 的推出反弹、场地边界一次全做，
      // 因此本地预测不会再出现"手雷直线穿墙飞进掩体"的视觉脱节。
      stepGrenadePhysics(grenade, dtSeconds, GRENADE_COLLIDERS);

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
    this.scene.remove(this.arcPoints);
    this.arcGeometry.dispose();
    this.arcMaterial.dispose();
    this.scene.remove(this.landingRing);
    this.landingRing.geometry.dispose();
    this.landingMaterial.dispose();
  }
}
