/**
 * 战斗特效：弹道、枪口火光、弹着火花/烟尘、**弹孔**、爆炸冲击波与火光。
 *
 * 所有特效都是短生命周期的临时对象，update() 中统一渐隐与释放，
 * 避免长时间对局后对象堆积导致掉帧。
 *
 * 弹孔是唯一的例外：它必须持久（这是玩家判断"我打中了哪里、这面墙能不能穿透"的唯一线索），
 * 所以用固定容量的 {@link THREE.InstancedMesh} 环形复用，一次 draw call、零对象分配。
 */

import * as THREE from "three";

/**
 * 一条曳光。
 *
 * **不再是"从枪口到命中点的一整根静态直线"**——那玩意在移动中连发时是灾难：
 * 线画出来的那一刻，玩家的相机早就往前走了半米，静态直线会把"当时的弹道"
 * 画成"现在这个角度"，看起来就是子弹斜着飞、不从枪口出来。
 *
 * 现在它是一条**沿弹道飞过去的短拖尾**：头在 `speed` 的速度上前进，
 * 尾随其后 `streak` 米，整根线只活 `lifeMs`。眼睛读到的是"有东西从枪口射出去了"，
 * 而不是"半空里突然出现一根斜线"。
 */
interface Tracer {
  mesh: THREE.Mesh;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  distance: number;
  streak: number;
  speed: number;
  radius: number;
  bornAt: number;
  lifeMs: number;
  active: boolean;
}

interface Effect {
  object: THREE.Object3D;
  bornAt: number;
  lifeMs: number;
  update: (progress: number) => void;
  dispose: () => void;
}

/**
 * 曳光的视觉飞行速度（米/秒）。纯表现，与判定射程无关。
 *
 * 260 → 340：CS2 的曳光几乎是"一闪而过"的细线。速度压得太低时，玩家能在空中
 * 同时看到两三发并排的粗亮柱，主观感受就变成"我拿的是霰弹枪"——这也是上一版
 * 「弹道看上去像散弹枪」的主要来源之一（另一条是半径 14mm 太粗）。
 */
const TRACER_SPEED = 340;
/** 拖尾长度（米）：短到像"子弹"，长到在 30m 外也看得见一条亮线。 */
const TRACER_STREAK = 3.6;
/**
 * 曳光半径（米）。14mm → 6mm。
 *
 * 14mm 在 1080p、30m 处的投影宽度接近 3 个像素，四根并排就是一根"光柱"；
 * 6mm 投影像 1 个像素的细线——这才是 CS 里那条几乎看不见、只能靠亮度感知的曳光。
 * 再细会在高 DPI 屏上被抗锯齿吃掉，所以留了 6mm 的下限。
 */
const TRACER_RADIUS = 0.006;
/** 最短存活时间（毫秒）：贴脸打墙时不至于一帧都看不到。 */
const TRACER_MIN_LIFE_MS = 40;
/** 同时存在的曳光上限（对象池容量）。超了复用最老的一条，永不增长。 */
const TRACER_CAPACITY = 48;

const TRACER_UP = new THREE.Vector3(0, 1, 0);

/**
 * 曳光贴图：沿圆柱轴向的渐变（弹头端亮、尾部淡出）。
 *
 * `CanvasTexture` 默认 `flipY = true`，所以画布**顶部**对应 UV 的 v = 1，
 * 也就是圆柱的 +Y 端。生成时把 +Y 对准飞行方向，弹头自然就是最亮的那一头。
 */
function tracerTexture(width = 8, height = 64): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.3, "rgba(255,238,186,0.9)");
    gradient.addColorStop(1, "rgba(255,206,120,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 弹孔保留数量上限。超过后从最旧的开始覆盖（环形缓冲）。 */
const BULLET_HOLE_CAPACITY = 96;

/** 弹孔贴片沿法向的偏移（米）：太小会 z-fighting，太大会浮在表面。 */
const BULLET_HOLE_OFFSET = 0.012;

/** 弹孔直径区间（米）。 */
const BULLET_HOLE_SIZE_MIN = 0.075;
const BULLET_HOLE_SIZE_RANGE = 0.045;

/**
 * 程序化生成弹孔贴图：中心黑洞 + 环状崩裂 + 外圈浅色粉尘。
 *
 * 全部用 Canvas 画，不依赖外部资源——贴图资源一旦 404，弹孔会变成纯白方块，
 * 比没有弹孔更难看。
 */
function bulletHoleTexture(size = 64): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const center = size / 2;

    // 外圈粉尘：浅灰，边缘极淡，让弹孔"嵌"进墙面而不是贴纸
    const dust = context.createRadialGradient(center, center, size * 0.12, center, center, center);
    dust.addColorStop(0, "rgba(210,200,185,0.85)");
    dust.addColorStop(0.55, "rgba(160,150,138,0.45)");
    dust.addColorStop(1, "rgba(120,112,102,0)");
    context.fillStyle = dust;
    context.fillRect(0, 0, size, size);

    // 中心黑洞：纯黑 + 微小的不规则边，避免看起来像几何圆
    context.fillStyle = "rgba(12,10,9,0.96)";
    context.beginPath();
    const points = 14;
    for (let i = 0; i < points; i += 1) {
      const angle = (i / points) * Math.PI * 2;
      const jitter = 0.28 + Math.random() * 0.12;
      const radius = center * jitter;
      const x = center + Math.cos(angle) * radius;
      const y = center + Math.sin(angle) * radius;
      if (i === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.closePath();
    context.fill();

    // 崩裂细纹：从洞心向外发散的几条短线
    context.strokeStyle = "rgba(90,82,74,0.5)";
    context.lineWidth = 1;
    for (let i = 0; i < 6; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const inner = center * (0.3 + Math.random() * 0.08);
      const outer = center * (0.55 + Math.random() * 0.3);
      context.beginPath();
      context.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
      context.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
      context.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

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
  /** 曳光对象池（容量固定，按需创建，永不增长）。 */
  private readonly tracers: Tracer[] = [];
  private readonly tracerGeometry: THREE.CylinderGeometry;
  private readonly tracerMaterial: THREE.MeshBasicMaterial;
  /** 复用的临时向量：每条曳光每帧都要算一次位置，不能分配。 */
  private readonly scratchPosition = new THREE.Vector3();
  private readonly effects: Effect[] = [];
  private readonly sparkTexture: THREE.Texture;
  private readonly smokeTexture: THREE.Texture;
  private readonly flashTexture: THREE.Texture;
  private readonly bloodTexture: THREE.Texture;
  private readonly muzzle: THREE.Sprite;
  private readonly muzzleLight: THREE.PointLight;
  private muzzleUntil = 0;
  /** 弹孔实例化网格（容量固定，环形复用，永不增长）。 */
  private readonly bulletHoles: THREE.InstancedMesh;
  /** 下一个要写入的弹孔槽位。 */
  private bulletHoleCursor = 0;
  /** 复用的临时对象，避免每发子弹都 new 一遍矩阵/四元数。 */
  private readonly holeMatrix = new THREE.Matrix4();
  private readonly holePosition = new THREE.Vector3();
  private readonly holeQuaternion = new THREE.Quaternion();
  private readonly holeScale = new THREE.Vector3();
  private readonly holeNormal = new THREE.Vector3();
  private readonly holeRotation = new THREE.Quaternion();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  public constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    this.sparkTexture = radialTexture("rgba(255,236,180,1)", "rgba(255,150,40,0)");
    this.smokeTexture = radialTexture("rgba(210,214,222,0.95)", "rgba(150,156,168,0)");
    this.flashTexture = radialTexture("rgba(255,246,214,1)", "rgba(255,170,60,0)");
    this.bloodTexture = radialTexture("rgba(214,38,38,1)", "rgba(110,8,8,0)");

    // 曳光：一根单位圆柱（半径 1 / 高 1 / 沿 +Y），共用几何与材质，
    // 每条只靠 scale 设半径与长度、靠四元数把 +Y 转到飞行方向。
    this.tracerGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.tracerMaterial = new THREE.MeshBasicMaterial({
      map: tracerTexture(),
      color: 0xffe6a8,
      transparent: true,
      // 0.92 → 0.62：加色混合下 0.92 会把细线糊成一团亮斑，压到 0.62 才有"细而亮"的
      // 观感；配合半径 6mm，远处就是一条一像素的暖色线。
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

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

    // 弹孔：一次 draw call 画满整个弹匣都不心疼。初始 count=0，打一发加一个实例。
    const holeGeometry = new THREE.PlaneGeometry(1, 1);
    const holeMaterial = new THREE.MeshBasicMaterial({
      map: bulletHoleTexture(),
      transparent: true,
      depthWrite: false,
      // 稍微往前推一点，避免和墙面共面时的深度精度打架
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.bulletHoles = new THREE.InstancedMesh(holeGeometry, holeMaterial, BULLET_HOLE_CAPACITY);
    this.bulletHoles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bulletHoles.count = 0;
    this.bulletHoles.frustumCulled = false;
    this.bulletHoles.renderOrder = 1;
    // 先把全部实例写成零缩放：某些 three 版本在 count 增长时会把未初始化的槽位
    // 当成单位矩阵，在原点画出一堆大弹孔。
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < BULLET_HOLE_CAPACITY; i += 1) {
      this.bulletHoles.setMatrixAt(i, hidden);
    }
    this.bulletHoles.instanceMatrix.needsUpdate = true;
    this.scene.add(this.bulletHoles);
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

  /**
   * 弹道曳光：从 `origin` 沿 `hit` 方向飞一条短拖尾。
   *
   * @param origin 起点。**必须是开火那一刻的枪口世界坐标**，不是收到广播时的枪口
   *   （两者在移动中能差半米，见 `Game#handleShot`）。
   * @param hit 终点。服务端权威命中点，世界坐标，画完为止。
   * @param options.speed 飞行速度（米/秒），默认 {@link TRACER_SPEED}；
   *   本地的"出膛曳光"用更慢的值，让玩家看得见枪口那一下。
   * @param options.streak 拖尾长度（米），默认 {@link TRACER_STREAK}。
   * @returns 弹头飞到 `hit` 需要的毫秒数（贴脸命中返回 0）。
   *   调用方用它把"弹孔/血雾"推迟到子弹真正飞到时再出现——
   *   曳光还在半路上、弹孔就已经贴在墙上，是比"没有弹孔"更容易被看穿的假。
   */
  public addTracer(
    origin: { x: number; y: number; z: number },
    hit: { x: number; y: number; z: number },
    options: { speed?: number; streak?: number; radius?: number } = {},
  ): number {
    const dx: number = hit.x - origin.x;
    const dy: number = hit.y - origin.y;
    const dz: number = hit.z - origin.z;
    const distance: number = Math.hypot(dx, dy, dz);
    // 贴脸（枪口已经插进墙里）时不画：零长度线在屏幕上就是一个亮点，反而像 bug
    if (distance < 0.05) {
      return 0;
    }

    const tracer: Tracer = this.acquireTracer();
    tracer.origin.set(origin.x, origin.y, origin.z);
    tracer.dir.set(dx / distance, dy / distance, dz / distance);
    tracer.distance = distance;
    tracer.streak = Math.min(options.streak ?? TRACER_STREAK, distance);
    tracer.speed = Math.max(20, options.speed ?? TRACER_SPEED);
    tracer.radius = options.radius ?? TRACER_RADIUS;
    tracer.bornAt = performance.now();
    tracer.lifeMs = Math.max(
      TRACER_MIN_LIFE_MS,
      ((distance + tracer.streak) / tracer.speed) * 1000,
    );
    tracer.active = true;
    tracer.mesh.visible = true;
    // 圆柱的 +Y 转到弹道方向；之后只改 scale/position，不再动旋转。
    tracer.mesh.quaternion.setFromUnitVectors(TRACER_UP, tracer.dir);
    this.placeTracer(tracer, 0);
    return (distance / tracer.speed) * 1000;
  }

  /** 从池里取一条可用曳光：优先后台对象 → 新对象（未满）→ 最老的一条。 */
  private acquireTracer(): Tracer {
    for (const tracer of this.tracers) {
      if (!tracer.active) {
        return tracer;
      }
    }
    if (this.tracers.length < TRACER_CAPACITY) {
      const mesh = new THREE.Mesh(this.tracerGeometry, this.tracerMaterial);
      mesh.name = "tracer";
      mesh.visible = false;
      // 从枪口出发的细线很容易被视锥体裁掉（包围球在帧与帧之间跳），关掉最省心
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      const tracer: Tracer = {
        mesh,
        origin: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 0, -1),
        distance: 0,
        streak: TRACER_STREAK,
        speed: TRACER_SPEED,
        radius: TRACER_RADIUS,
        bornAt: 0,
        lifeMs: 0,
        active: false,
      };
      this.tracers.push(tracer);
      return tracer;
    }
    let oldest: Tracer = this.tracers[0] as Tracer;
    for (const tracer of this.tracers) {
      if (tracer.bornAt < oldest.bornAt) {
        oldest = tracer;
      }
    }
    return oldest;
  }

  /** 把曳光摆到 `ageMs` 时刻的姿态：头在前、尾在后，尾到头就是这一帧的可见长度。 */
  private placeTracer(tracer: Tracer, ageMs: number): void {
    const travelled: number = (ageMs / 1000) * tracer.speed;
    const head: number = Math.min(tracer.distance, travelled);
    const tail: number = Math.min(tracer.distance, Math.max(0, travelled - tracer.streak));
    const length: number = head - tail;
    if (length <= 1e-4) {
      tracer.mesh.visible = false;
      return;
    }
    tracer.mesh.visible = true;
    tracer.mesh.scale.set(tracer.radius, length, tracer.radius);
    this.scratchPosition
      .copy(tracer.origin)
      .addScaledVector(tracer.dir, (head + tail) / 2);
    tracer.mesh.position.copy(this.scratchPosition);
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

  /**
   * 弹孔：在命中面上贴一枚持久的洞（容量 96，打满后覆盖最旧的）。
   *
   * 三个必须做对的细节：
   *   1. **朝向用法向**，不是弹道方向。斜着打墙时"弹道反方向"会让贴片浮在空中；
   *   2. 沿法向外推 {@link BULLET_HOLE_OFFSET}，否则与墙面共面会闪烁（z-fighting）；
   *   3. 绕法向随机转一个角度，否则同一个洞反复贴会出现明显的重复图案。
   */
  public bulletHole(
    point: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
  ): void {
    this.holeNormal.set(normal.x, normal.y, normal.z);
    if (this.holeNormal.lengthSq() < 1e-9) {
      // 非法法向（理论上不会发生）：直接朝上，至少不会画出 NaN 矩阵
      this.holeNormal.set(0, 1, 0);
    }
    this.holeNormal.normalize();

    this.holePosition.set(
      point.x + this.holeNormal.x * BULLET_HOLE_OFFSET,
      point.y + this.holeNormal.y * BULLET_HOLE_OFFSET,
      point.z + this.holeNormal.z * BULLET_HOLE_OFFSET,
    );

    // PlaneGeometry 的正面朝 +Z：把 +Z 旋到法向，再绕法向随机自转
    this.holeQuaternion.setFromUnitVectors(this.zAxis, this.holeNormal);
    this.holeRotation.setFromAxisAngle(this.holeNormal, Math.random() * Math.PI * 2);
    this.holeQuaternion.premultiply(this.holeRotation);

    const size = BULLET_HOLE_SIZE_MIN + Math.random() * BULLET_HOLE_SIZE_RANGE;
    this.holeScale.set(size, size, 1);

    this.holeMatrix.compose(this.holePosition, this.holeQuaternion, this.holeScale);
    this.bulletHoles.setMatrixAt(this.bulletHoleCursor, this.holeMatrix);
    this.bulletHoles.instanceMatrix.needsUpdate = true;

    this.bulletHoleCursor = (this.bulletHoleCursor + 1) % BULLET_HOLE_CAPACITY;
    if (this.bulletHoles.count < BULLET_HOLE_CAPACITY) {
      this.bulletHoles.count += 1;
    }
  }

  /** 清空全部弹孔（重开一局 / 换图时调用，避免上一局残留）。 */
  public clearBulletHoles(): void {
    this.bulletHoleCursor = 0;
    this.bulletHoles.count = 0;
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

  /**
   * 命中玩家：血雾（0.25s，红色粒子向后上方溅开）。
   *
   * 与 {@link impact} 的区别：血雾**不反弹**、不受重力主导，而是从命中点沿弹道方向
   * 继续向前扩散并快速淡出 —— 这是玩家判断"打中了身体"而不是"打在墙上"的关键反馈。
   */
  public bloodBurst(point: { x: number; y: number; z: number }): void {
    const now = performance.now();
    const group = new THREE.Group();
    group.position.set(point.x, point.y, point.z);

    const count = 14;
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < count; i += 1) {
      velocities.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * 1.8,
          (Math.random() - 0.2) * 1.4,
          (Math.random() - 0.5) * 1.8,
        ).multiplyScalar(1.6 + Math.random() * 1.9),
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      map: this.bloodTexture,
      size: 0.13,
      transparent: true,
      depthWrite: false,
      color: 0xc41f1f,
    });
    const particles = new THREE.Points(geometry, material);
    group.add(particles);

    const mist = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.bloodTexture, transparent: true, opacity: 0.65, depthWrite: false }),
    );
    mist.scale.setScalar(0.32);
    group.add(mist);

    this.scene.add(group);

    const lifeMs = 250;
    this.effects.push({
      object: group,
      bornAt: now,
      lifeMs,
      update: (progress: number) => {
        const attribute = geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < count; i += 1) {
          const velocity = velocities[i] as THREE.Vector3;
          attribute.setXYZ(
            i,
            velocity.x * progress * 0.22,
            velocity.y * progress * 0.22 - 1.1 * progress * progress * 0.22,
            velocity.z * progress * 0.22,
          );
        }
        attribute.needsUpdate = true;
        material.opacity = 1 - progress;
        mist.scale.setScalar(0.32 + progress * 0.5);
        mist.material.opacity = 0.65 * (1 - progress);
      },
      dispose: () => {
        geometry.dispose();
        material.dispose();
        mist.material.dispose();
      },
    });
  }

  /** 手雷爆炸：火光、冲击波圆环、上扬烟团。 */  public explosion(point: { x: number; y: number; z: number }, radius: number): void {
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

    for (const tracer of this.tracers) {
      if (!tracer.active) {
        continue;
      }
      // 出生时间用 performance.now()，而 update 收到的是 rAF 时间戳（同一时间轴，
      // 但 rAF 的戳可能比"本帧内某次 performance.now()"早几毫秒）→ 夹到 0 防止倒飞
      const age = Math.max(0, nowMs - tracer.bornAt);
      if (age >= tracer.lifeMs) {
        tracer.active = false;
        tracer.mesh.visible = false;
        continue;
      }
      this.placeTracer(tracer, age);
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
      this.scene.remove(tracer.mesh);
    }
    this.tracers.length = 0;
    this.tracerGeometry.dispose();
    this.tracerMaterial.map?.dispose();
    this.tracerMaterial.dispose();

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
    this.bloodTexture.dispose();
  }
}
