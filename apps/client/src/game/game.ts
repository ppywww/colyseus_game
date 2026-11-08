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
  CLIENT_INTERPOLATION_DELAY_MS,
  EYE_HEIGHT,
  MAP_BOUNDS,
  PLAYER_TRANSFORM_RATE_HZ,
  SPAWN_POINTS,
  THROWABLES,
  THROWABLE_TYPES,
  THROW_COOLDOWN_MS,
  WEAPON_COOLDOWN_MS,
  WEAPON_MAG_SIZE,
  WEAPON_RELOAD_MS,
  type DamageTakenMessage,
  type ExplosionMessage,
  type FlashEffectMessage,
  type GrenadeLaunchedMessage,
  type KillMessage,
  type PlayerTransformMessage,
  type ShotMessage,
  type SmokeCloudView,
  type ThrowableType,
} from "@colyseus-fps/shared";

import type { LobbyConnection } from "../net/connection.js";
import type { PlayerState } from "../net/types.js";
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

const LOOK_SENSITIVITY = 0.0023;
const MAX_PITCH = Math.PI / 2 - 0.02;

/** 开火后坐强度（弧度）。 */
const RECOIL_PITCH = 0.016;
const RECOIL_YAW = 0.006;

/** 准星扩散：基础值、每发增量、移动增量、回弹速度（像素/秒）。 */
const SPREAD_BASE = 3;
const SPREAD_PER_SHOT = 7;
const SPREAD_MOVE = 4;
const SPREAD_RECOVER_PER_SECOND = 26;

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
  private lastThrowAt = 0;
  private lastRespawnSeq = 0;
  private selfAlive = true;
  private selfHp = 100;
  private selfRespawnAt = 0;
  private ammo = WEAPON_MAG_SIZE;
  private reserve = 0;
  private reloadEndAt = 0;
  private frags = 0;
  private flashes = 0;
  private smokes = 0;

  // 表现状态（纯本地）
  private recoilPitch = 0;
  private recoilYaw = 0;
  private shake = 0;
  private spread = SPREAD_BASE;
  private readonly pressed = new Set<string>();
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
    window.addEventListener("resize", this.handleResize);

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

  /** 左键开火：仅发送意图，弹道与伤害由服务端裁定。 */
  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.input.isPointerLocked()) {
      return;
    }
    this.tryFire(performance.now());
  };

  private tryFire(nowMs: number): void {
    if (!this.selfAlive) {
      return;
    }
    if (nowMs - this.lastFireAt < WEAPON_COOLDOWN_MS) {
      return;
    }
    if (this.ammo <= 0) {
      // 空仓：只播放一次"咔"声，避免连点噪音
      if (nowMs - this.lastFireAt > 220) {
        this.lastFireAt = nowMs;
        this.audio.emptyClick();
      }
      return;
    }
    if (this.reloadEndAt > Date.now()) {
      return;
    }

    this.lastFireAt = nowMs;
    // 携带开火瞬间的视角快照（与屏幕准星同源：含后坐偏移），服务端 ±3° 内采信
    this.connection.sendFire(this.kinematics.yaw + this.recoilYaw, this.kinematics.pitch + this.recoilPitch);

    // 本地即时反馈（不等服务端回包，才有"跟手"的开枪感）
    this.ammo = Math.max(0, this.ammo - 1);
    this.effects.muzzleFlash(nowMs);
    this.audio.gunshot();
    this.viewModel.recoil(nowMs);
    this.recoilPitch -= RECOIL_PITCH;
    this.recoilYaw += (Math.random() - 0.5) * RECOIL_YAW * 2;
    this.shake = Math.min(1, this.shake + 0.18);
    this.spread = Math.min(26, this.spread + SPREAD_PER_SHOT);
    if (this.ammo === 0 && this.reserve > 0) {
      this.requestReload();
    }
  }

  private requestReload(): void {
    if (!this.selfAlive || this.ammo >= WEAPON_MAG_SIZE || this.reserve <= 0) {
      return;
    }
    if (this.reloadEndAt > Date.now()) {
      return;
    }
    this.reloadEndAt = Date.now() + WEAPON_RELOAD_MS;
    this.connection.sendReload();
    this.audio.reloadStart();
    window.setTimeout(() => {
      if (!this.disposed) {
        this.audio.reloadEnd();
      }
    }, WEAPON_RELOAD_MS - 120);
  }

  /** 投掷道具：方向取当前视线（含俯仰），位置与速度由服务端裁定。 */
  private tryThrow(type: ThrowableType, nowMs: number): void {
    if (!this.selfAlive) {
      return;
    }
    if (nowMs - this.lastThrowAt < 700) {
      return;
    }
    const left = type === THROWABLE_TYPES.FRAG ? this.frags : type === THROWABLE_TYPES.FLASH ? this.flashes : this.smokes;
    if (left <= 0) {
      return;
    }

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
  }

  /** 服务端弹道广播：渲染轨迹；自己命中时给命中反馈，打空时出火花。 */
  public handleShot(message: ShotMessage): void {
    this.effects.addTracer(message.origin, message.hit);

    if (message.hitPlayerId !== null) {
      if (message.shooterId === this.selfSessionId) {
        this.hud.flashHitmarker();
        this.audio.hitmark();
      }
      return;
    }

    // 打空/打墙：命中点火花，法线近似取弹道反方向
    const dx = message.hit.x - message.origin.x;
    const dy = message.hit.y - message.origin.y;
    const dz = message.hit.z - message.origin.z;
    const length = Math.hypot(dx, dy, dz) || 1;
    this.effects.impact(message.hit, { x: -dx / length, y: -dy / length, z: -dz / length });
  }

  /** 击杀广播：写入播报；自己击杀时给横幅与确认音。 */
  public handleKill(message: KillMessage): void {
    const nameOf = (id: string): string =>
      this.latestPlayers.find((player) => player.sessionId === id)?.displayName ?? id.slice(0, 6);
    const killerName = nameOf(message.killerId);
    const victimName = nameOf(message.victimId);
    this.hud.pushKillFeed(`${killerName} 击杀了 ${victimName}`);

    if (message.killerId === this.selfSessionId) {
      this.hud.showKillBanner(`击杀 ${victimName}`);
      this.audio.killConfirm();
    } else if (message.victimId === this.selfSessionId) {
      this.hud.showKillBanner(`被 ${killerName} 击杀`);
    }
  }

  /** 投掷物已投出：本地预测同一条抛物线。 */
  public handleGrenade(message: GrenadeLaunchedMessage): void {
    this.throwables.spawnLaunched(message);
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
    }

    this.selfAlive = self.alive;
    this.selfHp = self.hp;
    this.selfRespawnAt = self.respawnAt;

    // 弹药/道具：本地已做乐观扣减，服务端状态更新更慢时会短暂"回跳"。
    // 刚开火/投掷后的 300ms 内保留本地较小值，其余情况一律以服务端为准。
    const now = performance.now();
    if (now - this.lastFireAt > 300 || self.ammo <= this.ammo) {
      this.ammo = self.ammo;
    }
    this.reserve = self.reserve;
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
    const look = this.input.consumeLookDelta();
    if (locked) {
      this.kinematics.yaw -= look.dx * LOOK_SENSITIVITY;
      this.kinematics.pitch = Math.min(
        MAX_PITCH,
        Math.max(-MAX_PITCH, this.kinematics.pitch - look.dy * LOOK_SENSITIVITY),
      );
    }
    this.recoilPitch *= Math.exp(-dtSeconds * 9);
    this.recoilYaw *= Math.exp(-dtSeconds * 9);
    const pitchWithRecoil = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.kinematics.pitch + this.recoilPitch));
    const yawWithRecoil = this.kinematics.yaw + this.recoilYaw;

    this.handleActionKeys(nowMs);

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
    // 视模型：五态动画（idle / walk / fire / reload / throw）全部由这里驱动
    this.viewModel.update(dtSeconds, {
      moving,
      sprinting: moveInput.sprint,
      grounded: this.kinematics.grounded,
      verticalSpeed: this.kinematics.vy,
      reloadProgress,
      throwing: nowMs - this.lastThrowAt < THROW_COOLDOWN_MS,
      firingAt: this.lastFireAt,
    });
    // 让枪口火光贴着枪口帽走（后坐/换弹/投掷时一起位移）
    this.effects.setMuzzleOffset(this.viewModel.getMuzzleWorldOffset());

    // 准星扩散回弹
    const baseSpread = SPREAD_BASE + (moving ? SPREAD_MOVE : 0);
    this.spread = Math.max(baseSpread, this.spread - SPREAD_RECOVER_PER_SECOND * dtSeconds);

    this.hud.update({
      position: { x: this.kinematics.x, y: this.kinematics.y, z: this.kinematics.z },
      playerCount: this.latestPlayers.length,
      remoteCount: this.remotePlayers.count(),
      selfHp: this.selfHp,
      selfAlive: this.selfAlive,
      selfRespawnAt: this.selfRespawnAt,
      ammo: this.ammo,
      reserve: this.reserve,
      reloadProgress,
      frags: this.frags,
      flashes: this.flashes,
      smokes: this.smokes,
      spread: this.spread,
    });

    this.renderer.render(this.scene, this.camera);
  }

  /** 边沿触发的动作键：R 换弹、G/F/V 投掷。 */
  private handleActionKeys(nowMs: number): void {
    if (!this.input.isPointerLocked()) {
      this.previousPressed.clear();
      this.pressed.clear();
      for (const code of ["KeyR", "KeyG", "KeyF", "KeyV"]) {
        if (this.input.isDown(code)) {
          this.previousPressed.add(code);
        }
      }
      return;
    }

    for (const code of ["KeyR", "KeyG", "KeyF", "KeyV"]) {
      const down = this.input.isDown(code);
      const wasDown = this.previousPressed.has(code);
      if (down && !wasDown) {
        if (code === "KeyR") {
          this.requestReload();
        } else if (code === "KeyG") {
          this.tryThrow(THROWABLE_TYPES.FRAG, nowMs);
        } else if (code === "KeyF") {
          this.tryThrow(THROWABLE_TYPES.FLASH, nowMs);
        } else {
          this.tryThrow(THROWABLE_TYPES.SMOKE, nowMs);
        }
      }
      if (down) {
        this.previousPressed.add(code);
      } else {
        this.previousPressed.delete(code);
      }
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("click", this.handleCanvasClick);
    this.hud.lockOverlayElement.removeEventListener("click", this.handleCanvasClick);
    document.removeEventListener("pointerlockchange", this.handlePointerLockChange);
    document.removeEventListener("pointerlockerror", this.handlePointerLockError);
    document.removeEventListener("mousedown", this.handleMouseDown);
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
