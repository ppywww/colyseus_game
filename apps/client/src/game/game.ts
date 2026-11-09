/**
 * 游戏编排器：Three.js 场景 + 本地物理 + 网络同步 + HUD + 战斗表现。
 *
 * 数据流：
 *   键鼠 → 本地物理 → 15Hz 上报 transform → 服务端状态 → 其他客户端
 *   左键 → fire 意图 → 服务端弹道判定 → shot 广播（轨迹/命中）→ 表现
 *   G/F/V → throw 意图 → 服务端抛物线/爆炸结算 → grenade/explode 广播 → 表现
 *
 * 枪感要点（对标 CS 的反馈密度）：
 *   枪口火光 + 点光源照明、相机后坐（上抬 + 随机横移并回弹）、屏幕轻微抖动、
 *   动态准星扩散、弹着火花与烟尘、命中/击杀音效、受击方向提示与低血量红边。
 */

import * as THREE from "three";

import {
  BASE_SENSITIVITY,
  CLIENT_INTERPOLATION_DELAY_MS,
  EYE_HEIGHT,
  FIRE_MODES,
  MAP_BOUNDS,
  MELEE_COOLDOWN_MS,
  PLAYER_TRANSFORM_RATE_HZ,
  SLOT_ORDER,
  SPAWN_POINTS,
  THROWABLES,
  THROWABLE_TYPES,
  THROW_COOLDOWN_MS,
  WEAPON_RELOAD_MS,
  WEAPON_SLOTS,
  ZONE_LABEL,
  fireProfileOf,
  isGunSlot,
  nextSlot,
  recoilDeltaOf,
  slotOfThrowable,
  spreadHalfAngleDeg,
  spreadToPixels,
  switchDurationOf,
  throwableTypeOfSlot,
  type DamageTakenMessage,
  type ExplosionMessage,
  type FlashEffectMessage,
  type GrenadeLaunchedMessage,
  type KillMessage,
  type KnifeResultMessage,
  type PlayerTransformMessage,
  type RecoilDelta,
  type ShotMessage,
  type SmokeCloudView,
  type ThrowableType,
  type WeaponFireProfile,
  type WeaponSlot,
} from "@colyseus-fps/shared";

import type { LobbyConnection } from "../net/connection.js";
import type { PlayerState } from "../net/types.js";
import { getSettingsStore, mountSensitivitySlider, type SettingsStore } from "../ui/settings.js";
import { GameAudio } from "./audio.js";
import { CombatEffects } from "./effects.js";
import { Hud } from "./hud.js";
import { InputController } from "./input.js";
import { RemotePlayerManager } from "./remote-players.js";
import { ARENA_FOG, ARENA_SKY_COLOR, buildArena, obstacleColliders } from "./map.js";
import {
  DEFAULT_PHYSICS,
  stepPlayer,
  type MoveInput,
  type PlayerKinematics,
} from "./player-physics.js";
import { ThrowableSystem } from "./throwables.js";
import { ViewModel } from "./viewmodel.js";

const MAX_PITCH = Math.PI / 2 - 0.02;

/** 角度 → 弧度。武器参数表里的后坐力用「度」表示（人读得懂），运行时换算成弧度。 */
const DEG2RAD = Math.PI / 180;

/**
 * 准星最小张开量（像素）。
 *
 * 即使扩散为 0（刀、投掷物）准星也不能完全闭合：四根线贴在一起会糊成一个点，
 * 玩家就找不到屏幕正中心了。
 */
const CROSSHAIR_GAP_MIN_PX = 3;

/** 相机竖直 FOV（度）——准星的像素换算必须用同一个值，否则准星宽度与真实圆锥不成比例。 */
const CAMERA_FOV_Y_DEG = 80;

/**
 * 需要「边沿触发」的动作键。
 *
 * 数字键 1–6 与滚轮一起构成武器切换的两条通道：数字键直达（快、可预期），
 * 滚轮环形（顺）。两者最终都走 `selectSlot`，所以校验规则只有一份。
 */
const ACTION_KEYS: readonly string[] = [
  "KeyR",
  "KeyG",
  "KeyF",
  "KeyV",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
];

/**
 * 用最近的固定出生点决定出生朝向。
 *
 * 旧实现用 `Math.atan2(-spawn.x, -spawn.z)`（面向地图中心），会让所有玩家朝同一个点扎堆，
 * 与沙漠迷城的「T 在南朝北、CT 在北朝南」完全相反。现在按服务端出生表取 yaw。
 */
function spawnYawFor(x: number, z: number): number {
  let bestYaw = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of SPAWN_POINTS) {
    const distance = Math.hypot(point.x - x, point.z - z);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestYaw = point.yaw;
    }
  }
  return bestYaw;
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly input: InputController;
  private readonly hud: Hud;
  private readonly remotePlayers: RemotePlayerManager;
  private readonly viewModel: ViewModel;
  private readonly effects: CombatEffects;
  private readonly throwables: ThrowableSystem;
  private readonly audio = new GameAudio();
  private readonly colliders = obstacleColliders();

  private readonly kinematics: PlayerKinematics;
  private readonly resizeObserver: ResizeObserver;
  private animationFrameId = 0;
  private lastFrameTime = 0;
  private transformAccumulatorMs = 0;
  private transformSeq = 0;
  private latestPlayers: readonly PlayerState[] = [];
  private disposed = false;

  // 战斗状态（全部以服务端下发为准）
  private lastFireAt = 0;
  /**
   * 左键是否处于按住状态（全自动扳机）。
   *
   * 只在枪械分支置位：刀/投掷物是"点一次触发一次"，按住不放不应该连挥/连扔。
   * 所有"不该继续开火"的时机都要显式清零——死亡、切枪、换弹、退出指针锁定。
   */
  private firing = false;
  private lastThrowAt = 0;
  private lastKnifeAt = 0;
  private lastRespawnSeq = 0;
  private selfAlive = true;
  private selfHp = 100;
  private selfRespawnAt = 0;
  private ammo = 0;
  private reserve = 0;
  private pistolAmmo = 0;
  private pistolReserve = 0;
  private reloadEndAt = 0;
  private frags = 0;
  private flashes = 0;
  private smokes = 0;

  // 武器槽与切枪（本地乐观 + 服务端权威）
  private weaponSlot: WeaponSlot = WEAPON_SLOTS.RIFLE;
  /** 切枪结束时刻（本机时钟，毫秒）：期间禁止开火与再次切枪。 */
  private switchEndAt = 0;
  /** 本次切枪的起点（performance.now）与总时长，用于算 `switchProgress`。 */
  private switchStartAt = 0;
  private switchDurationMs = 0;
  /** 快捷投掷前的槽位：投掷动作结束后自动切回，避免"扔完手里空着"。 */
  private slotBeforeThrow: WeaponSlot = WEAPON_SLOTS.RIFLE;
  /** 快捷投掷的自动回切定时器。 */
  private throwReturnTimer = 0;

  // 设置（灵敏度）
  private readonly settings: SettingsStore = getSettingsStore();
  private unmountSettings: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;

  // 表现状态（纯本地）
  private recoilPitch = 0;
  private recoilYaw = 0;
  /**
   * 当前连发已打出的发数（0 = 这一串还没开火）。
   *
   * 它是"喷弹形走到第几格"的游标：第 N 发的视角冲量 = `pattern[N] − pattern[N-1]`。
   * 停火后按 `sprayResetRate` 回退，让下一串从头开始——这就是"点一下重新起步"。
   */
  private shotIndex = 0;
  /** 上一发的时刻，用于判断停火间隔、驱动 `shotIndex` 回退。 */
  private lastShotAtMs = 0;
  private shake = 0;
  /**
   * 扩散游标：这一串连发已经打了几发（0 = 下一发是第一发）。
   *
   * 与服务端 `sprayIndex` 必须严格同步（同样的 +1 与归零规则），因为它决定
   * **准星张开多少像素**，而服务端用同一个数决定**圆锥半径多少度**。
   * 两边不同步的后果很具体：准星已经张到 2.6°，服务端还按 0.2° 结算，
   * 玩家会觉得"扫射反而比点射准"，而且永远练不准。
   */
  private spreadIndex = 0;
  private readonly previousPressed = new Set<string>();

  public constructor(
    private readonly container: HTMLElement,
    private readonly connection: LobbyConnection,
    private readonly selfSessionId: string,
    spawn: { x: number; y: number; z: number },
  ) {
    this.scene = new THREE.Scene();
    // 沙漠天空 + 暖沙色雾（雾 near = 40m，视模型最远 0.97m，绝不会被雾影响）
    this.scene.background = new THREE.Color(ARENA_SKY_COLOR);
    this.scene.fog = new THREE.Fog(ARENA_FOG.color, ARENA_FOG.near, ARENA_FOG.far);

    this.camera = new THREE.PerspectiveCamera(
      80,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.1,
      300,
    );
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // ACES 色调映射：把 2.0 强度的暖阳压回不溢出的范围，沙漠高光才有层次
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.append(this.renderer.domElement);

    this.scene.add(buildArena());

    this.input = new InputController(this.renderer.domElement);
    this.hud = new Hud(container);
    this.remotePlayers = new RemotePlayerManager(this.scene, CLIENT_INTERPOLATION_DELAY_MS);
    this.viewModel = new ViewModel(this.camera);
    this.effects = new CombatEffects(this.scene, this.camera);
    this.throwables = new ThrowableSystem(this.scene, this.effects);

    this.kinematics = {
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      vy: 0,
      yaw: spawnYawFor(spawn.x, spawn.z), // 面向敌方半场（T 朝北 / CT 朝南）
      pitch: 0,
      grounded: true,
    };

    this.hud.setLockOverlayVisible(true);
    this.renderer.domElement.addEventListener("click", this.handleCanvasClick);
    this.hud.lockOverlayElement.addEventListener("click", this.handleCanvasClick);
    document.addEventListener("pointerlockchange", this.handlePointerLockChange);
    document.addEventListener("pointerlockerror", this.handlePointerLockError);
    document.addEventListener("mousedown", this.handleMouseDown);
    document.addEventListener("mouseup", this.handleMouseUp);
    window.addEventListener("resize", this.handleResize);

    // ---- 设置：把持久化的灵敏度喂给输入层，并把滑块挂进 Esc 遮罩 ----
    // 大厅与游戏内共用同一个 SettingsStore，因此这里既读既同步。
    this.input.setSensitivity(this.settings.getSensitivity());
    this.unsubscribeSettings = this.settings.subscribe((snapshot) => {
      this.input.setSensitivity(snapshot.sensitivity);
    });
    this.unmountSettings = mountSensitivitySlider(this.hud.settingsContainer, this.settings);

    // 容器尺寸可能被 CSS/布局变化（而非 window resize）改变，主动监听
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.container);
    this.handleResize();
  }

  private readonly handleCanvasClick = (): void => {
    // 首次点击同时解锁音频上下文（浏览器自动播放策略要求用户手势）
    this.audio.unlock();
    if (!this.input.isPointerLocked()) {
      this.input.requestLock();
    }
  };

  private readonly handlePointerLockError = (): void => {
    console.warn("指针锁定失败：请再次点击画面（浏览器可能限制了锁定频率）");
  };

  /** 左键：枪 → 开火、刀 → 挥刀、投掷物 → 投出。全部由服务端裁定。 */
  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.input.isPointerLocked()) {
      return;
    }
    const now: number = performance.now();
    if (this.weaponSlot === WEAPON_SLOTS.KNIFE) {
      this.tryKnife(now);
      return;
    }
    const throwable = throwableTypeOfSlot(this.weaponSlot);
    if (throwable !== null) {
      this.tryThrow(throwable, now);
      return;
    }
    // 枪械：按下即扣扳机。全自动枪由主循环（`tick`）按冷却持续补发，
    // 半自动枪只在这里发这一发——按住左键不会连发。
    this.firing = true;
    this.tryFire(now);
  };

  /** 左键松开：断开扳机。全自动枪停止连发，semi 枪不受影响。 */
  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) {
      return;
    }
    this.firing = false;
  };

  /** 当前槽位的弹匣剩余（刀 / 投掷物返回 −1，表示"没有弹匣"）。 */
  private currentMag(): number {
    if (this.weaponSlot === WEAPON_SLOTS.PISTOL) {
      return this.pistolAmmo;
    }
    return this.weaponSlot === WEAPON_SLOTS.RIFLE ? this.ammo : -1;
  }

  /** 当前槽位的备弹（刀 / 投掷物返回 0）。 */
  private currentReserve(): number {
    if (this.weaponSlot === WEAPON_SLOTS.PISTOL) {
      return this.pistolReserve;
    }
    return this.weaponSlot === WEAPON_SLOTS.RIFLE ? this.reserve : 0;
  }

  /** 写入当前槽位的弹匣剩余（本地乐观扣减；刀 / 投掷物忽略）。 */
  private setCurrentMag(value: number): void {
    const next: number = Math.max(0, value);
    if (this.weaponSlot === WEAPON_SLOTS.PISTOL) {
      this.pistolAmmo = next;
    } else if (this.weaponSlot === WEAPON_SLOTS.RIFLE) {
      this.ammo = next;
    }
  }

  private tryFire(nowMs: number): void {
    if (!this.selfAlive) {
      return;
    }
    // 刀（2）与投掷物（3/4/5）的左键不是"开枪"：由挥刀 / 投掷链路处理
    if (!isGunSlot(this.weaponSlot)) {
      return;
    }
    // 切枪中不能开火（与服务端 `switchEndAt` 校验同口径，避免本地先响一枪再被丢弃）
    if (Date.now() < this.switchEndAt) {
      return;
    }
    if (this.reloadEndAt > Date.now()) {
      return;
    }

    const profile = fireProfileOf(this.weaponSlot);
    if (profile === null) {
      return;
    }
    // 冷却按武器各自口径：步枪 150ms / 手枪 300ms
    if (nowMs - this.lastFireAt < profile.cooldownMs) {
      return;
    }

    const mag: number = this.currentMag();
    if (mag <= 0) {
      // 空仓：只播放一次"咔"声，避免连点噪音
      if (nowMs - this.lastFireAt > 220) {
        this.lastFireAt = nowMs;
        this.audio.emptyClick();
      }
      return;
    }

    this.lastFireAt = nowMs;
    // 携带开火瞬间的**视角 + 位置**快照（与屏幕准星同源：含后坐偏移），
    // 服务端按 25° / 1.2m 的阈值采信，超出则回退已存值。
    this.connection.sendFire(
      this.kinematics.yaw + this.recoilYaw,
      this.kinematics.pitch + this.recoilPitch,
      { x: this.kinematics.x, y: this.kinematics.y, z: this.kinematics.z },
    );

    // 本地即时反馈（不等服务端回包，才有"跟手"的开枪感）
    this.setCurrentMag(mag - 1);
    this.effects.muzzleFlash(nowMs);
    this.audio.gunshot();
    this.viewModel.recoil(nowMs);
    this.applyRecoilImpulse(profile, nowMs);
    this.shake = Math.min(1, this.shake + 0.18);
    // 扩散游标 +1：下一发的圆锥半径由它决定（服务端用同一个数 + 同一个公式）
    this.spreadIndex += 1;
    if (this.currentMag() === 0 && this.currentReserve() > 0) {
      this.requestReload();
    }
  }

  /**
   * 施加一发的后坐冲量。
   *
   * 方向必须与"抬头"同号：`pitch` 增大 = 视线抬高（three.js 的 YXZ 相机里
   * `rotation.x > 0` 让 −Z 转向 +Y）。历史实现写成了 `-=`，等于每开一枪把枪口
   * **下压** 0.85°——幅度小、又被视模型的枪身后坐盖住，所以一直没被发现。
   *
   * 有喷弹形的枪（AK）按表走：第 N 发的冲量 = `pattern[N] − pattern[N-1]`，
   * 于是连发累计偏移严格等于表里第 N 格，图案可复现、可练习、可压枪。
   * 没有表的枪（半自动手枪）用单发随机，每次点击独立。
   */
  private applyRecoilImpulse(profile: WeaponFireProfile, nowMs: number): void {
    // 停火够久 → 两个游标一起归零（图案从头、扩散回到首发）。
    // 放在这里而不是只靠主循环，是为了不依赖"开火前恰好跑过一帧"。
    if (this.lastShotAtMs > 0 && nowMs - this.lastShotAtMs > profile.sprayResetMs) {
      this.shotIndex = 0;
      this.spreadIndex = 0;
    }
    this.lastShotAtMs = nowMs;
    const delta: RecoilDelta = recoilDeltaOf(profile, this.shotIndex);
    // `pitch` 增大 = 视线抬高（three.js 的 YXZ 相机里 `rotation.x > 0` 让 −Z 转向 +Y），
    // 所以抬头角是**加**。历史实现写成了 `-=`，等于每开一枪把枪口下压 0.85°——
    // 幅度小、又被视模型的枪身后坐盖住，一直没被发现。
    this.recoilPitch += delta.pitchDeg * DEG2RAD;
    this.recoilYaw += delta.yawDeg * DEG2RAD;
    this.shotIndex = delta.nextIndex;
  }

  /**
   * 准星张开多少像素。
   *
   * **必须**由 `spreadHalfAngleDeg`（服务端同一个函数）换算而来，不能用自己的一套
   * "每发 +7px"：那样准星张开的幅度和真实圆锥没有关系，就是又一次"准星撒谎"——
   * 上一轮"弹道不对"的根因之一正是这个（准星在抖、服务端射线是直线）。
   */
  private crosshairSpreadPx(): number {
    const profile = fireProfileOf(this.weaponSlot);
    if (profile === null) {
      // 刀 / 投掷物没有圆锥扩散，准星保持最小张开量
      return CROSSHAIR_GAP_MIN_PX;
    }
    const halfAngleDeg: number = spreadHalfAngleDeg(profile, this.spreadIndex);
    // 用画布真实高度换算：不同分辨率下"张开的角度"相同、"张开的像素"不同
    const viewportHeight: number = this.renderer.domElement.clientHeight || 720;
    return Math.max(
      CROSSHAIR_GAP_MIN_PX,
      spreadToPixels(halfAngleDeg, CAMERA_FOV_Y_DEG, viewportHeight),
    );
  }

  private requestReload(): void {
    const profile = fireProfileOf(this.weaponSlot);
    // 刀 / 投掷物没有弹匣，R 键无效
    if (!this.selfAlive || profile === null) {
      return;
    }
    if (this.currentMag() >= profile.magSize || this.currentReserve() <= 0) {
      return;
    }
    if (this.reloadEndAt > Date.now()) {
      return;
    }
    this.reloadEndAt = Date.now() + WEAPON_RELOAD_MS;
    // 换弹重置两个游标（服务端 `handleReload` 同步做同样的事）：
    // 换完第一发必须回到首发精度，否则会接着上一串的扩散继续打。
    this.shotIndex = 0;
    this.spreadIndex = 0;
    this.connection.sendReload();
    this.audio.reloadStart();
    window.setTimeout(() => {
      if (!this.disposed) {
        this.audio.reloadEnd();
      }
    }, WEAPON_RELOAD_MS - 120);
  }

  /**
   * 挥刀：只发意图，扇形判定（±35° / 2.0m / 背刺 100）全部由服务端 `melee.ts` 结算。
   *
   * 本地仍然做冷却与槽位拦截：不然连点左键会在服务端被限流静默丢弃，
   * 玩家看到的是"刀挥了但没伤害"，比直接不挥更迷惑。
   */
  private tryKnife(nowMs: number): void {
    if (!this.selfAlive) {
      return;
    }
    if (Date.now() < this.switchEndAt) {
      return;
    }
    if (nowMs - this.lastKnifeAt < MELEE_COOLDOWN_MS) {
      return;
    }
    this.lastKnifeAt = nowMs;
    // 携带挥刀瞬间的视角（与服务端 3° 校验同源）：快速转身挥刀不会砍到背后
    this.connection.sendKnife(this.kinematics.yaw + this.recoilYaw, this.kinematics.pitch + this.recoilPitch);
    this.viewModel.swing();
    this.audio.knifeSwing();
    this.shake = Math.min(1, this.shake + 0.08);
  }

  /**
   * 挥刀结果广播：自己命中 → 分级命中反馈 + thud/crit 音效；
   * 远端挥刀 → 让他的化身右臂前甩 300ms（挥空也要播，否则看不到"对面在挥刀"）。
   */
  public handleKnifeResult(message: KnifeResultMessage): void {
    if (message.attackerId === this.selfSessionId) {
      if (message.hitPlayerId === null) {
        return;
      }
      this.hud.flashHitmarker(message.backstab ? "head" : "body");
      this.hud.showZoneDamage(message.backstab ? "背刺" : "近战", message.damage);
      if (message.backstab) {
        this.audio.knifeCrit();
      } else {
        this.audio.knifeHit();
      }
      return;
    }

    this.remotePlayers.playArmSwing(message.attackerId, 300);
  }

  /** 本地是否允许切到该槽位（与服务端校验同口径，唯一区别是不发网络包）。 */
  private isSlotSelectable(slot: WeaponSlot): boolean {
    if (slot === this.weaponSlot) {
      return false;
    }
    const throwable = throwableTypeOfSlot(slot);
    if (throwable === null) {
      return true; // 枪 / 刀恒可用
    }
    return this.throwableCount(throwable) > 0;
  }

  /** 本地记着的该投掷物剩余数量（与服务端状态同步，乐观扣减过）。 */
  private throwableCount(type: ThrowableType): number {
    if (type === THROWABLE_TYPES.FRAG) {
      return this.frags;
    }
    return type === THROWABLE_TYPES.FLASH ? this.flashes : this.smokes;
  }

  /**
   * 切到指定槽位（数字键直达 / 滚轮最终都走这里）。
   *
   * @param slot 目标槽位
   * @param options.instant true = 不播切枪动画、不设冷却（快捷投掷用）
   * @param options.quiet true = 不可切时不播「咔」声（滚轮连滚时避免噪音）
   * @returns 是否真的切换了
   */
  private selectSlot(slot: WeaponSlot, options: { instant?: boolean; quiet?: boolean } = {}): boolean {
    if (!this.selfAlive || slot === this.weaponSlot) {
      return false;
    }
    if (Date.now() < this.switchEndAt) {
      return false; // 上一次切枪还没结束（与服务端拒绝条件一致）
    }
    if (!this.isSlotSelectable(slot)) {
      if (options.quiet !== true) {
        this.audio.emptyClick();
      }
      return false;
    }

    this.connection.sendWeaponSwitch(slot);
    this.applySlotLocally(slot, options.instant === true ? 0 : switchDurationOf(slot));
    return true;
  }

  /** 本地立即生效的槽位切换（不动网络、不校验）——由 {@link selectSlot} 与状态同步共用。 */
  private applySlotLocally(slot: WeaponSlot, durationMs: number): void {
    // 切枪必须松开"扳机"：否则按住左键滚轮切枪，新枪会在切枪动画结束的下一帧自动开火
    this.firing = false;
    this.weaponSlot = slot;
    this.viewModel.setWeaponSlot(slot);
    this.switchDurationMs = durationMs;
    this.switchStartAt = performance.now();
    this.switchEndAt = durationMs <= 0 ? 0 : Date.now() + durationMs;
    // 换枪即重置喷弹形：新枪的第一发必须是表头（几乎没有偏移），
    // 否则切枪后会接着上一把枪的图案打，出现"第一发就飞"的怪异手感。
    this.shotIndex = 0;
    // 扩散游标同罪：不重置的话，AK 扫了 20 发（2.6°）切手枪，第一发就散到封顶
    this.spreadIndex = 0;
  }

  /**
   * 滚轮切枪：环形找下一个**可用**槽位（跳过空投掷物槽）。
   *
   * @param direction +1 = 向后滚（AK → 手枪 → 刀 …）、−1 = 向前滚
   */
  private cycleSlot(direction: 1 | -1): void {
    const picked: WeaponSlot = nextSlot(this.weaponSlot, direction, (candidate) => this.isSlotSelectable(candidate));
    if (picked === this.weaponSlot) {
      // 整圈没有可切的槽位（弹药全打光且道具用完）：保持不动，不要乱跳
      return;
    }
    this.selectSlot(picked, { quiet: true });
  }

  /** 投掷道具：方向取当前视线（含俯仰），位置与速度由服务端裁定。 */
  private tryThrow(type: ThrowableType, nowMs: number): void {
    if (!this.selfAlive) {
      return;
    }
    if (nowMs - this.lastThrowAt < THROW_COOLDOWN_MS) {
      return;
    }
    const left: number = this.throwableCount(type);
    if (left <= 0) {
      this.audio.emptyClick();
      return;
    }

    // 快捷投掷（G/F/V）：先把手里的东西换成本次投掷物（不播切枪动画、不设冷却），
    // 这样第一人称立刻出现"握着道具"的姿态；服务端会在 THROW 处理里做同样的切槽。
    const throwSlot: WeaponSlot = slotOfThrowable(type);
    this.slotBeforeThrow = this.weaponSlot;
    this.applySlotLocally(throwSlot, 0);

    this.lastThrowAt = nowMs;
    const cosPitch = Math.cos(this.kinematics.pitch);
    const dir = {
      x: -Math.sin(this.kinematics.yaw) * cosPitch,
      y: Math.sin(this.kinematics.pitch),
      z: -Math.cos(this.kinematics.yaw) * cosPitch,
    };
    this.connection.sendThrow(type, dir);
    this.audio.throwWhoosh();
    if (type === THROWABLE_TYPES.FRAG) {
      this.frags = Math.max(0, this.frags - 1);
    } else if (type === THROWABLE_TYPES.FLASH) {
      this.flashes = Math.max(0, this.flashes - 1);
    } else {
      this.smokes = Math.max(0, this.smokes - 1);
    }

    // 投掷动作结束（= 投掷冷却）后自动切回投掷前的武器，避免"扔完手里空着"
    window.clearTimeout(this.throwReturnTimer);
    this.throwReturnTimer = window.setTimeout(() => {
      if (this.disposed || !this.selfAlive) {
        return;
      }
      if (this.weaponSlot !== throwSlot) {
        return;
      }
      const back: WeaponSlot = this.slotBeforeThrow;
      if (back === throwSlot) {
        return;
      }
      this.connection.sendWeaponSwitch(back);
      this.applySlotLocally(back, 0);
    }, THROW_COOLDOWN_MS + 50);
  }

  /**
   * 服务端弹道广播：渲染轨迹；命中玩家播血雾 + 分级命中反馈，打空/打墙播火花。
   *
   * 反馈分级（协议 v2 的 `hitZone` / `damage` 都是服务端权威值）：
   *   爆头 → 红色大 ✕ + 部位读数「头部 −100」；身体 → 白色 ✕ + 部位读数；击杀 → 由 KILL 触发放大版。
   */
  public handleShot(message: ShotMessage): void {
    // 自己的弹道从**本地视模型枪口**出发。
    //
    // 服务端回的 `origin` 是"眼睛 + 固定偏移"算出来的理论枪口，而屏幕上真正的枪口
    // 会随后坐、换弹、投掷、切枪一路动——两者在移动和连发时能差十几厘米。这正是
    // 「子弹不是从枪口出来」的观感来源：判定没错，画错了。
    const origin =
      message.shooterId === this.selfSessionId
        ? this.viewModel.getMuzzleWorldPosition()
        : message.origin;
    this.effects.addTracer(origin, message.hit);

    if (message.hitPlayerId !== null) {
      this.effects.bloodBurst(message.hit);
      if (message.shooterId === this.selfSessionId) {
        this.hud.flashHitmarker(message.hitZone === "head" ? "head" : "body");
        if (message.hitZone !== null) {
          this.hud.showZoneDamage(ZONE_LABEL[message.hitZone], message.damage);
        }
        this.audio.hitmark();
      }
      return;
    }

    // 打空（射线飞到射程尽头）不画任何东西；
    // 打墙/打地则同时出火花与弹孔，弹孔用**服务端返回的真实面法向**贴合。
    if (message.hitSurface !== "wall" || message.hitNormal === null) {
      return;
    }
    this.effects.impact(message.hit, message.hitNormal);
    this.effects.bulletHole(message.hit, message.hitNormal);
  }

  /** 击杀广播：写入播报；自己击杀时给横幅、放大的击杀标记与确认音。 */
  public handleKill(message: KillMessage): void {
    const nameOf = (id: string): string =>
      this.latestPlayers.find((player) => player.sessionId === id)?.displayName ?? id.slice(0, 6);
    const killerName = nameOf(message.killerId);
    const victimName = nameOf(message.victimId);
    const headshotMark = message.headshot ? " ⌖爆头" : "";
    this.hud.pushKillFeed(`${killerName} 击杀了 ${victimName}${headshotMark}`);

    if (message.killerId === this.selfSessionId) {
      this.hud.showKillBanner(`击杀 ${victimName}${headshotMark}`);
      this.hud.flashHitmarker("kill");
      this.audio.killConfirm();
    } else if (message.victimId === this.selfSessionId) {
      this.hud.showKillBanner(`被 ${killerName} 击杀`);
    }
  }

  /** 投掷物已投出：本地预测同一条抛物线，并让投掷者的化身右臂前甩 400ms。 */
  public handleGrenade(message: GrenadeLaunchedMessage): void {
    this.throwables.spawnLaunched(message);
    if (message.throwerId !== this.selfSessionId) {
      this.remotePlayers.playArmSwing(message.throwerId, 400);
    }
  }

  /** 投掷物生效：爆炸/闪光视觉 + 距离衰减的屏幕抖动与音效。 */
  public handleExplosion(message: ExplosionMessage): void {
    this.throwables.spawnExplosion(message);
    const config = THROWABLES[message.type];
    const distance = Math.hypot(message.x - this.kinematics.x, message.z - this.kinematics.z);
    const falloff = Math.max(0, 1 - distance / (config.radius * 2.4));

    if (message.type === THROWABLE_TYPES.FRAG) {
      this.audio.explosion();
      this.shake = Math.min(1, this.shake + 0.75 * falloff);
    } else if (message.type === THROWABLE_TYPES.SMOKE) {
      this.audio.smokePop();
    }
  }

  /** 闪光致盲：全屏白幕 + 耳鸣音。 */
  public handleFlash(message: FlashEffectMessage): void {
    this.hud.blind(message.intensity, message.durationMs);
    this.audio.flashbang();
  }

  /** 受击：红色边缘 + 指向攻击者的方向指示。 */
  public handleDamaged(message: DamageTakenMessage): void {
    const dx = message.fromX - this.kinematics.x;
    const dz = message.fromZ - this.kinematics.z;
    // 转到相机水平朝向的相对角度：0 表示正前方
    const worldAngle = Math.atan2(dx, dz);
    const playerYaw = this.kinematics.yaw;
    const relative = Math.atan2(
      Math.sin(worldAngle - playerYaw),
      Math.cos(worldAngle - playerYaw),
    );
    this.hud.showDamage(relative);
    this.audio.hurt();
    this.shake = Math.min(1, this.shake + 0.35);
  }

  /** 烟雾云团状态同步。 */
  public handleClouds(clouds: readonly SmokeCloudView[]): void {
    this.throwables.syncClouds(clouds);
  }

  private readonly handlePointerLockChange = (): void => {
    // Esc / Alt-Tab 退出锁定时 `mouseup` 可能根本不会到达页面，扳机必须在这里强制断开，
    // 否则重新锁定后玩家会"凭空"继续连发，直到下一次点击。
    if (!this.input.isPointerLocked()) {
      this.firing = false;
    }
    this.hud.setLockOverlayVisible(!this.input.isPointerLocked());
  };

  private readonly handleResize = (): void => {
    const width = this.container.clientWidth;
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  /** 由 main.ts 在每次房间状态更新时调用。 */
  public onPlayersChanged(players: readonly PlayerState[]): void {
    this.latestPlayers = players;
    this.remotePlayers.sync(players, this.selfSessionId, performance.now());
    this.hud.setPlayers(players, this.selfSessionId);

    const self = players.find((player) => player.sessionId === this.selfSessionId);
    if (!self) {
      return;
    }

    // 重生：服务端 respawnSeq 自增，本地位置吸附到新的出生点
    if (self.respawnSeq !== this.lastRespawnSeq) {
      this.lastRespawnSeq = self.respawnSeq;
      this.kinematics.x = self.x;
      this.kinematics.y = self.y;
      this.kinematics.z = self.z;
      this.kinematics.vy = 0;
      this.kinematics.yaw = spawnYawFor(self.x, self.z);
      this.kinematics.pitch = 0;
      this.recoilPitch = 0;
      this.recoilYaw = 0;
      this.shotIndex = 0;
      this.spreadIndex = 0;
    }

    // 死亡即断扳机：否则落地那一刻仍然按着左键，重生后第一帧就会"自动"打出一发
    if (!self.alive) {
      this.firing = false;
    }
    this.selfAlive = self.alive;
    this.selfHp = self.hp;
    this.selfRespawnAt = self.respawnAt;

    // ---- 武器槽：以服务端为准 ----
    // 正常情况下两边一致（本地乐观切换 + 服务端回显）。不一致只有两种可能：
    //   ① 本地那次被拒（切枪中 / 投掷物已用完）——回退到服务端槽位；
    //   ② 快捷投掷后服务端把槽位改成了投掷物——同样跟随。
    // 两种情况都**不播切枪动画**：本地已经播过了，再播一次会像卡了一下。
    if (self.weaponSlot !== this.weaponSlot) {
      this.applySlotLocally(self.weaponSlot as WeaponSlot, 0);
    }

    // 弹药/道具：本地已做乐观扣减，服务端状态更新更慢时会短暂"回跳"。
    // 刚开火/投掷后的 300ms 内保留本地较小值，其余情况一律以服务端为准。
    const now = performance.now();
    if (now - this.lastFireAt > 300 || self.ammo <= this.ammo) {
      this.ammo = self.ammo;
    }
    this.reserve = self.reserve;
    if (now - this.lastFireAt > 300 || self.pistolAmmo <= this.pistolAmmo) {
      this.pistolAmmo = self.pistolAmmo;
    }
    this.pistolReserve = self.pistolReserve;
    this.reloadEndAt = self.reloadEndAt;
    if (now - this.lastThrowAt > 300) {
      this.frags = self.frags;
      this.flashes = self.flashes;
      this.smokes = self.smokes;
    }
  }

  public start(): void {
    this.lastFrameTime = performance.now();
    const frame = (nowMs: number): void => {
      if (this.disposed) {
        return;
      }
      const dtSeconds = Math.min((nowMs - this.lastFrameTime) / 1000, 0.1);
      this.lastFrameTime = nowMs;
      this.tick(dtSeconds, nowMs);
      this.animationFrameId = requestAnimationFrame(frame);
    };
    this.animationFrameId = requestAnimationFrame(frame);
  }

  private tick(dtSeconds: number, nowMs: number): void {
    const locked = this.input.isPointerLocked();

    // 视角（鼠标）+ 后坐偏移（自动回弹）
    // `look.dx` 已经乘过灵敏度倍率（InputController 负责），这里只乘基础系数。
    // 默认灵敏度 1.0 时 `BASE_SENSITIVITY` = 旧版的 LOOK_SENSITIVITY，手感逐位不变。
    const look = this.input.consumeLookDelta();
    if (locked) {
      this.kinematics.yaw -= look.dx * BASE_SENSITIVITY;
      this.kinematics.pitch = Math.min(
        MAX_PITCH,
        Math.max(-MAX_PITCH, this.kinematics.pitch - look.dy * BASE_SENSITIVITY),
      );
    }
    // 后坐偏移回正：速率按枪各不同（AK 5.5 慢、手枪 12 快）。
    // 刀/投掷物没有 profile，退回 9（与历史行为一致）。
    const recoilProfile = fireProfileOf(this.weaponSlot);
    const recoilRate: number = recoilProfile?.recoilRecoverRate ?? 9;
    this.recoilPitch *= Math.exp(-dtSeconds * recoilRate);
    this.recoilYaw *= Math.exp(-dtSeconds * recoilRate);
    // 停火够久 → 喷弹形从头开始。CS 里"点一下重新起步"就是这个机制：
    // 松手 320ms 后下一枪是第一格（几乎无偏移），所以点射永远比乱扫准。
    if (this.shotIndex > 0 && recoilProfile !== null && nowMs - this.lastShotAtMs > recoilProfile.sprayResetMs) {
      this.shotIndex = 0;
    }
    // 扩散游标同理：停火后准星收回到首发宽度（这一点与服务端 `sprayIndex` 完全一致）
    if (this.spreadIndex > 0 && recoilProfile !== null && nowMs - this.lastShotAtMs > recoilProfile.sprayResetMs) {
      this.spreadIndex = 0;
    }
    const pitchWithRecoil = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.kinematics.pitch + this.recoilPitch));
    const yawWithRecoil = this.kinematics.yaw + this.recoilYaw;

    this.handleActionKeys(nowMs);

    // 全自动扳机：按住左键时每帧尝试补发。`tryFire` 内部有 `nowMs - lastFireAt < cooldownMs`
    // 的自我限流，所以每帧调用是安全的——它不是"每帧一发"，而是"这一帧冷却好了就发一发"。
    // 半自动枪（手枪）不进这个分支：按住不放只出按下时那一发。
    if (this.firing && locked && this.selfAlive) {
      const profile = fireProfileOf(this.weaponSlot);
      if (profile !== null && profile.fireMode === FIRE_MODES.AUTO) {
        this.tryFire(nowMs);
      }
    }

    // 移动
    const moveInput: MoveInput = {
      forward: this.input.isDown("KeyW") || this.input.isDown("ArrowUp"),
      backward: this.input.isDown("KeyS") || this.input.isDown("ArrowDown"),
      left: this.input.isDown("KeyA") || this.input.isDown("ArrowLeft"),
      right: this.input.isDown("KeyD") || this.input.isDown("ArrowRight"),
      sprint: this.input.isDown("ShiftLeft") || this.input.isDown("ShiftRight"),
      jump: this.input.isDown("Space"),
    };
    const idle: MoveInput = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false,
      jump: false,
    };
    stepPlayer(
      this.kinematics,
      locked && this.selfAlive ? moveInput : idle,
      dtSeconds,
      this.colliders,
      { ...DEFAULT_PHYSICS, bounds: MAP_BOUNDS },
    );

    // 相机（含抖动）
    this.shake *= Math.exp(-dtSeconds * 7);
    const shakeAmount = this.shake * 0.06;
    this.camera.position.set(
      this.kinematics.x + (Math.random() - 0.5) * shakeAmount,
      this.kinematics.y + EYE_HEIGHT + (Math.random() - 0.5) * shakeAmount,
      this.kinematics.z + (Math.random() - 0.5) * shakeAmount,
    );
    this.camera.rotation.set(pitchWithRecoil, yawWithRecoil, 0);

    // 网络上报（固定频率，与渲染帧率解耦）：上报含后坐的真实准心，保证"打哪中哪"
    this.transformAccumulatorMs += dtSeconds * 1000;
    const intervalMs = 1000 / PLAYER_TRANSFORM_RATE_HZ;
    if (this.transformAccumulatorMs >= intervalMs) {
      this.transformAccumulatorMs %= intervalMs;
      this.transformSeq += 1;
      const message: PlayerTransformMessage = {
        seq: this.transformSeq,
        x: this.kinematics.x,
        y: this.kinematics.y,
        z: this.kinematics.z,
        yaw: yawWithRecoil,
        pitch: pitchWithRecoil,
      };
      this.connection.sendTransform(message);
    }

    // 远端插值渲染
    this.remotePlayers.render(nowMs);
    this.throwables.update(dtSeconds, nowMs);
    this.effects.update(nowMs);

    // 视模型摆动/换弹动作
    const moving =
      locked &&
      (moveInput.forward || moveInput.backward || moveInput.left || moveInput.right) &&
      this.kinematics.grounded;
    const reloadProgress =
      this.reloadEndAt > Date.now() ? 1 - (this.reloadEndAt - Date.now()) / WEAPON_RELOAD_MS : 0;
    // 视模型：五态动画（idle / walk / fire / reload / throw）+ 切枪下压，全部由这里驱动
    this.viewModel.update(dtSeconds, {
      moving,
      sprinting: moveInput.sprint,
      grounded: this.kinematics.grounded,
      verticalSpeed: this.kinematics.vy,
      reloadProgress,
      throwing: nowMs - this.lastThrowAt < THROW_COOLDOWN_MS,
      firingAt: this.lastFireAt,
      switchProgress: this.switchProgress(),
    });
    // 让枪口火光贴着枪口帽走（后坐/换弹/投掷时一起位移）
    this.effects.setMuzzleOffset(this.viewModel.getMuzzleWorldOffset());

    this.hud.update({
      position: { x: this.kinematics.x, y: this.kinematics.y, z: this.kinematics.z },
      playerCount: this.latestPlayers.length,
      remoteCount: this.remotePlayers.count(),
      selfHp: this.selfHp,
      selfAlive: this.selfAlive,
      selfRespawnAt: this.selfRespawnAt,
      weaponSlot: this.weaponSlot,
      ammo: this.ammo,
      reserve: this.reserve,
      pistolAmmo: this.pistolAmmo,
      pistolReserve: this.pistolReserve,
      reloadProgress,
      frags: this.frags,
      flashes: this.flashes,
      smokes: this.smokes,
      spread: this.crosshairSpreadPx(),
    });

    this.renderer.render(this.scene, this.camera);
  }

  /** 边沿触发的动作键：R 换弹、G/F/V 快捷投掷、1–6 直达、滚轮环形。 */
  private handleActionKeys(nowMs: number): void {
    if (!this.input.isPointerLocked()) {
      // 未锁定时不消费边沿：把当前按住的键记为"已按下"，
      // 否则重新锁定那一刻会立刻触发一次换弹/投掷（很莫名其妙）。
      this.previousPressed.clear();
      for (const code of ACTION_KEYS) {
        if (this.input.isDown(code)) {
          this.previousPressed.add(code);
        }
      }
      return;
    }

    // 滚轮：已按 80ms 合并成单向脉冲（触控板惯性不会连续切）
    const wheel: -1 | 0 | 1 = this.input.consumeWheelStep();
    if (wheel !== 0) {
      this.cycleSlot(wheel);
    }

    for (const code of ACTION_KEYS) {
      const down: boolean = this.input.isDown(code);
      const wasDown: boolean = this.previousPressed.has(code);
      if (down && !wasDown) {
        this.handleActionKey(code, nowMs);
      }
      if (down) {
        this.previousPressed.add(code);
      } else {
        this.previousPressed.delete(code);
      }
    }
  }

  /** 单个动作键的分派（保持 handleActionKeys 只做边沿检测）。 */
  private handleActionKey(code: string, nowMs: number): void {
    if (code === "KeyR") {
      this.requestReload();
      return;
    }
    if (code === "KeyG") {
      this.tryThrow(THROWABLE_TYPES.FRAG, nowMs);
      return;
    }
    if (code === "KeyF") {
      this.tryThrow(THROWABLE_TYPES.FLASH, nowMs);
      return;
    }
    if (code === "KeyV") {
      this.tryThrow(THROWABLE_TYPES.SMOKE, nowMs);
      return;
    }
    const slot: WeaponSlot | null = Game.slotFromKeyCode(code);
    if (slot !== null) {
      // 数字键直达：空槽只播「咔」声，不切换（selectSlot 内部处理）
      this.selectSlot(slot);
    }
  }

  /** `Digit1`–`Digit6` / `Numpad1`–`Numpad6` → 槽位；其他按键返回 null。 */
  private static slotFromKeyCode(code: string): WeaponSlot | null {
    const match: RegExpExecArray | null = /^(?:Digit|Numpad)([1-6])$/.exec(code);
    if (match === null) {
      return null;
    }
    const index: number = Number(match[1]) - 1;
    return SLOT_ORDER[index] ?? null;
  }

  /** 切枪动画进度 0→1（无切枪时恒 0，视模型据此下压/抬回）。 */
  private switchProgress(): number {
    if (this.switchDurationMs <= 0) {
      return 0;
    }
    const elapsed: number = performance.now() - this.switchStartAt;
    return Math.min(1, Math.max(0, elapsed / this.switchDurationMs));
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    cancelAnimationFrame(this.animationFrameId);
    window.clearTimeout(this.throwReturnTimer);
    this.unsubscribeSettings?.();
    this.unmountSettings?.();
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("click", this.handleCanvasClick);
    this.hud.lockOverlayElement.removeEventListener("click", this.handleCanvasClick);
    document.removeEventListener("pointerlockchange", this.handlePointerLockChange);
    document.removeEventListener("pointerlockerror", this.handlePointerLockError);
    document.removeEventListener("mousedown", this.handleMouseDown);
    document.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("resize", this.handleResize);
    this.input.dispose();
    this.hud.dispose();
    this.remotePlayers.dispose();
    this.throwables.dispose();
    this.effects.dispose();
    this.viewModel.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
