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
  /** 飞行中的道具本体（平底锅 / 胡椒瓶 / 面粉袋，按类型从模板克隆）。 */
  mesh: THREE.Object3D;
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
  /**
   * 三种道具的飞行模型模板（每个类型一套几何 + 材质）。
   *
   * 为什么用模板克隆而不是每次 new：投掷物在 2.2 秒里可能同时有 3–4 个在飞，
   * 每次 `new CylinderGeometry(...)` 都会在 GPU 上再传一份顶点数据；
   * 克隆共享几何与材质，`remove` 时也不需要 dispose（只在整局销毁时释放一次）。
   */
  private readonly propTemplates: Record<ThrowableType, THREE.Group>;
  private readonly propMaterials: THREE.Material[] = [];
  /** 落点环的第二层（内圈）：和主环一起旋转，读起来像"瞄准标尺"。 */
  private readonly landingInner: THREE.Mesh;

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
        uColor: { value: new THREE.Color(0xff6a4d) },
        // 墨色描边：整条辅助线在米色地砖、白瓷砖、木柜上都读得出来
        uRim: { value: new THREE.Color(0x2b1b2f) },
        // CSS 像素，着色器里再乘设备像素比
        uSize: { value: 9 },
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
        uniform vec3 uRim;
        uniform float uOpacity;
        varying float vFade;
        void main() {
          // gl_PointCoord 是 0..1 的方形贴图坐标：裁成圆，并留 1 像素软边
          float d = length(gl_PointCoord - vec2(0.5));
          // 核心半径 32%、外圈是 3px 墨线。
          // 之前是纯色圆点：白点在米色天空/瓷砖上直接消失，玩家以为"线断了"。
          // 加墨边之后，任何底色上都有轮廓，读感接近 CS2 的投掷轨迹。
          float alpha = smoothstep(0.5, 0.43, d);
          if (alpha <= 0.02) {
            discard;
          }
          float core = smoothstep(0.36, 0.3, d);
          vec3 color = mix(uRim, uColor, core);
          gl_FragColor = vec4(color, alpha * vFade * uOpacity);
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

    // 内圈：一根细环，跟着主环一起脉动，让落点标记有"准星"的层次而不是一个大圈
    this.landingInner = new THREE.Mesh(
      new THREE.RingGeometry(LANDING_RING_RADIUS * 0.16, LANDING_RING_RADIUS * 0.26, 22),
      this.landingMaterial,
    );
    this.landingInner.rotation.x = -Math.PI / 2;
    this.landingInner.visible = false;
    this.landingInner.renderOrder = 3;
    this.scene.add(this.landingInner);

    this.propTemplates = this.buildPropTemplates();
  }

  /**
   * 三种投掷物的飞行模型：**平底锅 / 胡椒瓶 / 面粉袋**。
   *
   * 尺寸以 {@link GRENADE_RADIUS}（0.11m 碰撞半径）为基准放大 20%：碰撞体是隐形的，
   * 视觉略大一点才不会出现"锅沿明明贴到墙了却没弹"的观感。
   */
  private buildPropTemplates(): Record<ThrowableType, THREE.Group> {
    const make = (color: number, roughness = 0.6, metalness = 0.08): THREE.MeshStandardMaterial => {
      const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      this.propMaterials.push(material);
      return material;
    };
    const panMetal = make(0x5b5262, 0.42, 0.55);
    const wood = make(0x8a5a34, 0.8, 0.02);
    const cream = make(0xfff3e0, 0.82, 0.02);
    const cheese = make(0xffc63d, 0.55, 0.05);
    const r = GRENADE_RADIUS * 1.2;

    // 0 · 平底锅：锅面竖着（飞行时转起来才像"翻着跟头飞出去的锅"）
    const pan = new THREE.Group();
    const panBody = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.25, r * 1.15, r * 0.35, 16), panMetal);
    panBody.rotation.x = Math.PI / 2;
    pan.add(panBody);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(r * 0.22, r * 0.22, r * 1.4), wood);
    handle.position.z = r * 1.1;
    pan.add(handle);
    // 锅底那颗煎蛋：飞起来时最显眼的识别点
    const egg = new THREE.Mesh(new THREE.SphereGeometry(r * 0.5, 12, 8), cream);
    egg.scale.set(1, 0.35, 1);
    egg.position.z = -r * 0.2;
    egg.rotation.x = Math.PI / 2;
    pan.add(egg);
    const yolk = new THREE.Mesh(new THREE.SphereGeometry(r * 0.22, 10, 8), cheese);
    yolk.scale.set(1, 0.5, 1);
    yolk.position.z = -r * 0.28;
    yolk.rotation.x = Math.PI / 2;
    pan.add(yolk);

    // 1 · 胡椒瓶：瓶身 + 旋盖
    const pepper = new THREE.Group();
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.7, r * 1.7, 14), cream);
    pepper.add(bottle);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.62, r * 0.6, 14), panMetal);
    cap.position.y = r * 1.15;
    pepper.add(cap);
    pepper.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.74, r * 0.74, r * 0.2, 14), cheese));

    // 2 · 面粉袋：鼓袋 + 扎口 + 撒出来的粉
    const flour = new THREE.Group();
    const sack = new THREE.Mesh(new THREE.SphereGeometry(r * 1.05, 14, 10), cream);
    sack.scale.set(1, 1.18, 0.94);
    flour.add(sack);
    const tie = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.34, r * 0.46, r * 0.42, 12), wood);
    tie.position.y = r * 1.2;
    flour.add(tie);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r * 0.44, 10, 8), cream);
    puff.scale.set(1, 0.68, 1);
    puff.position.y = r * 1.5;
    flour.add(puff);
    // 袋子上的"面粉"印字块（没有文字，只用一块浅色标签示意）
    const label = new THREE.Mesh(new THREE.BoxGeometry(r * 0.9, r * 0.7, r * 0.02), cheese);
    label.position.z = -r * 0.92;
    flour.add(label);
    // 让袋子中心落在碰撞球心上（否则"球心在地上时袋子还悬着半截"）
    sack.position.y = -r * 0.18;

    return { frag: pan, flash: pepper, smoke: flour };
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
      // 三种道具用三种颜色，避免"以为拿的是胡椒瓶、其实是面粉袋"：
      //   平底锅 = 番茄红（危险）、胡椒瓶 = 奶酪黄（刺眼）、面粉袋 = 冰蓝（烟幕）。
      // 都用**中饱和**色：纯白在米色地砖上会消失，深色在木柜前又会糊掉。
      const color: number = type === "frag" ? 0xff6a4d : type === "flash" ? 0xffd35c : 0xa8dcf5;
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
      this.landingInner.visible = false;
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
    // 内圈永远跟主环同位置同姿态：一个"环 + 芯"的靶心比单环更容易在远处读出圆心
    this.landingInner.position.copy(this.landingRing.position);
    this.landingInner.rotation.copy(this.landingRing.rotation);
    this.landingInner.scale.copy(this.landingRing.scale);
    this.landingInner.visible = true;
  }

  public hideAimArc(): void {
    this.arcPoints.visible = false;
    this.landingRing.visible = false;
    this.landingInner.visible = false;
  }

  /** 服务端广播投掷：立刻生成本地预测的飞行体。 */
  public spawnLaunched(message: GrenadeLaunchedMessage): void {
    if (this.grenades.has(message.id)) {
      return;
    }
    // 克隆模板：几何与材质共享，只复制层级结构（成本约等于一次 group 构造）
    const mesh = this.propTemplates[message.type].clone(true);
    mesh.position.set(message.origin.x, message.origin.y, message.origin.z);
    this.scene.add(mesh);

    this.grenades.set(message.id, {
      id: message.id,
      type: message.type,
      mesh,
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
    // 几何与材质来自共享模板，这里不能 dispose（否则下一个同类道具会变成黑块）
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
    }
    this.grenades.clear();

    for (const [id, visual] of this.clouds) {
      this.destroyCloud(id, visual);
    }
    // 模板的几何只在这里释放一次（飞行体全部是共享几何的克隆）
    for (const template of Object.values(this.propTemplates)) {
      template.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
        }
      });
    }
    for (const material of this.propMaterials) {
      material.dispose();
    }
    this.smoke.dispose();
    this.scene.remove(this.arcPoints);
    this.arcGeometry.dispose();
    this.arcMaterial.dispose();
    this.scene.remove(this.landingRing);
    this.landingRing.geometry.dispose();
    this.landingMaterial.dispose();
    this.scene.remove(this.landingInner);
    this.landingInner.geometry.dispose();
  }
}
