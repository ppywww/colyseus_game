/**
 * 远端玩家渲染管理：人形化身（`avatar-model.ts`）+ 头顶名牌 + 插值驱动 +
 * 行走摆动 + 死亡倒地。
 *
 * 为什么不在这里再画一套几何：判定体、外观、第一人称视模型必须同源。
 * 所有尺寸都在 `avatar-model.ts` 里由 `PLAYER_HITBOXES` 推导，
 * 本文件只负责「把服务端状态喂给化身」与「推进动画相位」。
 */

import * as THREE from "three";

import { PLAYER_HEIGHT, type TeamId } from "@colyseus-fps/shared";

import {
  BOB_FADE_TAU,
  BOB_RAD_PER_METER,
  FALL_DURATION_MS,
  buildAvatarModelOfIndex,
  type AvatarModel,
} from "./avatar-model.js";
import { InterpolationBuffer, type TransformSample } from "./interpolation.js";
import type { PlayerState } from "../net/types.js";

/** 停走/起步的速度阈值（m/s）：低于它视为静止，相位停止推进但**不归零**。 */
const MOVE_THRESHOLD = 0.5;

/** 离地判定：插值位置的 y 超过它即视为在空中（摆幅减半）。 */
const AIRBORNE_Y = 0.05;

/** 名牌在站立/倒地时的高度。 */
const LABEL_Y_ALIVE = PLAYER_HEIGHT + 0.45;
const LABEL_Y_DEAD = 0.5;

/**
 * 右臂前甩的最大角度（弧度，约 72°）。
 *
 * 用于"挥刀"（300ms）与"投掷"（400ms）这两种一次性动作：
 * 手臂从自然下垂甩到身前再回来，是远端玩家唯一能看出"他在动手"的信号
 * （既不用新增网络字段，也不用给每个化身再建一套骨骼）。
 */
const ARM_FLING = 1.25;

/** 出生地默认队伍（服务端一定下发 team，这里只是防御性兜底）。 */
function teamOf(player: PlayerState): TeamId {
  return player.team === "CT" ? "CT" : "T";
}

/**
 * 头顶名牌：奶油纸标签 + 3px 墨线 + 硬投影，和整套 UI 是同一张纸。
 *
 * 旧版是半透明深色胶囊（FPS 常见样式），放在厨房这种明亮场景里会糊成一块灰。
 * 现在改成"贴在场景里的小纸牌"，既跟 HUD 同源，也保证亮背景上的对比度。
 */
function createNameLabel(displayName: string, team: TeamId): THREE.Sprite {
  const width = 320;
  const height = 80;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    context.font = "700 34px 'Baloo 2', 'Microsoft YaHei', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const textWidth = Math.min(width - 56, context.measureText(displayName).width);
    const plateWidth = textWidth + 48;
    const left = (width - plateWidth) / 2;
    const top = 10;
    const radius = (height - top * 2) / 2;
    context.fillStyle = "rgba(43, 27, 47, 0.35)";
    context.beginPath();
    context.roundRect(left, top + 5, plateWidth, height - top * 2, radius);
    context.fill();
    context.fillStyle = "#FFF8E9";
    context.strokeStyle = "#2B1B2F";
    context.lineWidth = 5;
    context.beginPath();
    context.roundRect(left, top, plateWidth, height - top * 2, radius);
    context.fill();
    context.stroke();
    // 队伍色小圆点：名牌读字之前先读色，混战时能少看半秒
    context.fillStyle = team === "CT" ? "#3FA9E0" : "#E8432F";
    context.beginPath();
    context.arc(left + 20, height / 2, 7, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#2B1B2F";
    context.fillText(displayName, width / 2 + 10, height / 2 - 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }),
  );
  sprite.scale.set(2.4, 0.6, 1);
  return sprite;
}

/** 单个远端玩家的场景化身。 */
class RemotePlayerAvatar {
  public readonly root: THREE.Group;
  private readonly model: AvatarModel;
  private readonly label: THREE.Sprite;
  private readonly buffer: InterpolationBuffer;
  private lastSeq = 0;

  /** 行走相位（停走时不归零，避免重新起步时腿从 0 跳回）。 */
  private bobPhase = 0;
  /** 摆幅（0–1），按 τ = 120ms 淡入淡出。 */
  private bobAmp = 0;
  private hasRendered = false;
  private prevX = 0;
  private prevZ = 0;
  private speed = 0;

  /** 倒地状态：progress 0（站立）→ 1（躺平）。 */
  private dying = false;
  private fallElapsedMs = 0;
  private alive = true;
  private lastWeaponSlot = -1;
  /** 蹲姿插值 0..1（服务端 `crouch` 布尔值的平滑版本）。 */
  private crouchAmount = 0;
  private crouchTarget = 0;

  /** 右臂前甩的剩余 / 总时长（毫秒）。0 表示当前没有一次性动作。 */
  private armSwingRemainingMs = 0;
  private armSwingDurationMs = 0;

  public constructor(player: PlayerState, interpolationDelayMs: number) {
    this.model = buildAvatarModelOfIndex(teamOf(player), player.character ?? 0);
    this.root = this.model.root;
    this.root.name = `remote-${player.sessionId}`;
    this.buffer = new InterpolationBuffer(interpolationDelayMs);

    this.label = createNameLabel(player.displayName, teamOf(player));
    this.label.position.y = LABEL_Y_ALIVE;
    this.root.add(this.label);

    this.model.setWeaponSlot(player.weaponSlot);
    this.lastWeaponSlot = player.weaponSlot;
    this.alive = player.alive;

    // 进房时该玩家已经是尸体（后加入的观察者 / 断线重连）：直接躺平，不播倒地动画
    if (!player.alive) {
      this.dying = true;
      this.fallElapsedMs = FALL_DURATION_MS;
      this.model.poseFall(1);
      this.label.position.y = LABEL_Y_DEAD;
    }
  }

  public pushSample(sample: TransformSample, seq: number): void {
    if (seq < this.lastSeq) {
      return; // 乱序丢弃
    }
    this.lastSeq = seq;
    this.buffer.push(sample);
  }

  /**
   * 触发一次右臂前甩（挥刀 300ms / 投掷 400ms）。
   *
   * 重复调用直接从头开始：连续挥刀时手臂应该跟着一下一下甩，而不是排队播完。
   */
  public playArmSwing(durationMs: number): void {
    this.armSwingDurationMs = Math.max(1, durationMs);
    this.armSwingRemainingMs = this.armSwingDurationMs;
  }

  /** 同步非位置状态（武器槽 / 存活 / 蹲姿），立即生效，不做淡入。 */
  public syncState(player: PlayerState): void {
    if (player.weaponSlot !== this.lastWeaponSlot) {
      this.lastWeaponSlot = player.weaponSlot;
      this.model.setWeaponSlot(player.weaponSlot);
    }

    // 蹲姿是目标值，真正的插值在 render 里做（200ms 内平滑过渡，避免一帧内模型高度突变）
    this.crouchTarget = player.crouch === true && player.alive ? 1 : 0;

    if (player.alive !== this.alive) {
      this.alive = player.alive;
      if (player.alive) {
        // 重生：瞬间复位（材质按队伍共享，无法逐 avatar 淡出）
        this.dying = false;
        this.fallElapsedMs = 0;
        this.model.resetFall();
        this.label.position.y = LABEL_Y_ALIVE;
      } else {
        this.dying = true;
        this.fallElapsedMs = 0;
      }
    }
  }

  /**
   * 按渲染时刻插值并推进动画。
   *
   * @param renderTimeMs 插值采样时刻（本地 `performance.now()` 减去插值延迟）
   * @param dtSeconds 本帧时长（由管理器统一算好，避免每个 avatar 各算一次）
   */
  public render(renderTimeMs: number, dtSeconds: number): void {
    const transform = this.buffer.sample(renderTimeMs);
    if (transform) {
      this.root.position.set(transform.x, transform.y, transform.z);
      this.root.rotation.y = transform.yaw;

      // 水平速度由插值后的位置差算出（不新增网络字段）
      if (this.hasRendered && dtSeconds > 0) {
        const moved = Math.hypot(transform.x - this.prevX, transform.z - this.prevZ);
        this.speed = moved / dtSeconds;
      }
      this.prevX = transform.x;
      this.prevZ = transform.z;
      this.hasRendered = true;

      // 相位推进 + 摆幅淡入（停走时速度≈0，相位自然停止，不归零）
      const moving = this.speed > MOVE_THRESHOLD;
      this.bobPhase += this.speed * BOB_RAD_PER_METER * dtSeconds;
      const target = moving ? 1 : 0;
      const k = 1 - Math.exp(-dtSeconds / BOB_FADE_TAU);
      this.bobAmp += (target - this.bobAmp) * k;
      const airborne = transform.y > AIRBORNE_Y;
      this.model.poseLocomotion(this.bobPhase, this.bobAmp * (airborne ? 0.5 : 1));

      // ---- 蹲姿 ----
      // 压扁比例与服务端判定体一致（1 − 0.37 = CROUCH_HEIGHT_SCALE）：
      // 玩家看到的"蹲下去多少"就是"判定体矮了多少"，不会出现"看着蹲了却被打头"。
      // 屈膝/屈髋是纯视觉补充，让动作读起来是"蹲"而不是"缩小的模型"。
      const crouchK = 1 - Math.exp(-dtSeconds / 0.07);
      this.crouchAmount += (this.crouchTarget - this.crouchAmount) * crouchK;
      const crouch = this.crouchAmount;
      if (crouch > 0.002) {
        this.model.root.scale.y = 1 - 0.37 * crouch;
        const { hipL, hipR, kneeL, kneeR, torsoPivot } = this.model.rig;
        hipL.rotation.x -= 0.85 * crouch;
        hipR.rotation.x -= 0.85 * crouch;
        kneeL.rotation.x += 1.6 * crouch;
        kneeR.rotation.x += 1.6 * crouch;
        torsoPivot.rotation.x += 0.22 * crouch;
      } else if (this.model.root.scale.y !== 1) {
        this.model.root.scale.y = 1;
      }

      // 一次性动作（挥刀 / 投掷）在 poseLocomotion 之后再叠加：
      // 它每帧都会把 shoulderR.rotation.x 写回摆动值，所以这里的 -= 不会累积。
      if (this.armSwingRemainingMs > 0) {
        const progress = 1 - this.armSwingRemainingMs / this.armSwingDurationMs;
        const swing = Math.sin(Math.PI * Math.min(1, Math.max(0, progress)));
        this.model.rig.shoulderR.rotation.x -= ARM_FLING * swing;
        this.armSwingRemainingMs = Math.max(0, this.armSwingRemainingMs - dtSeconds * 1000);
      }
    }

    if (this.dying) {
      this.fallElapsedMs = Math.min(FALL_DURATION_MS, this.fallElapsedMs + dtSeconds * 1000);
      const progress = this.fallElapsedMs / FALL_DURATION_MS;
      this.model.poseFall(progress);
      this.label.position.y = LABEL_Y_ALIVE + (LABEL_Y_DEAD - LABEL_Y_ALIVE) * progress;
    }
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.root);
    this.label.material.map?.dispose();
    this.label.material.dispose();
    // 材质按队伍共享，这里只释放本 avatar 独占的几何体
    this.model.dispose();
  }
}

/** 管理所有远端玩家的增删改与逐帧渲染。 */
export class RemotePlayerManager {
  private readonly avatars = new Map<string, RemotePlayerAvatar>();
  private lastRenderMs = 0;

  public constructor(
    private readonly scene: THREE.Scene,
    private readonly interpolationDelayMs: number,
  ) {}

  /**
   * 与最新玩家列表对齐：新玩家建化身、已有玩家压入插值样本 + 同步武器/存活状态、离场玩家移除。
   * nowMs 为采样本地时间戳（performance.now()）。
   */
  public sync(players: readonly PlayerState[], selfSessionId: string, nowMs: number): void {
    const seen = new Set<string>();

    for (const player of players) {
      if (player.sessionId === selfSessionId) {
        continue;
      }
      seen.add(player.sessionId);

      let avatar = this.avatars.get(player.sessionId);
      if (!avatar) {
        avatar = new RemotePlayerAvatar(player, this.interpolationDelayMs);
        this.avatars.set(player.sessionId, avatar);
        this.scene.add(avatar.root);
      }

      avatar.syncState(player);
      avatar.pushSample(
        {
          t: nowMs,
          x: player.x,
          y: player.y,
          z: player.z,
          yaw: player.yaw,
          pitch: player.pitch,
        },
        player.seq,
      );
    }

    for (const [sessionId, avatar] of this.avatars) {
      if (!seen.has(sessionId)) {
        avatar.dispose(this.scene);
        this.avatars.delete(sessionId);
      }
    }
  }

  /** 每帧渲染（dt 由上一帧的渲染时刻推算，调用方只需传 nowMs）。 */
  public render(renderTimeMs: number): void {
    const dtSeconds = this.lastRenderMs === 0
      ? 0
      : Math.min(0.1, Math.max(0, (renderTimeMs - this.lastRenderMs) / 1000));
    this.lastRenderMs = renderTimeMs;
    for (const avatar of this.avatars.values()) {
      avatar.render(renderTimeMs, dtSeconds);
    }
  }

  public count(): number {
    return this.avatars.size;
  }

  /**
   * 让某个远端玩家做一次右臂前甩（挥刀 / 投掷）。
   *
   * @param sessionId 动作发起者；不认识的 id（已离场 / 自己）静默忽略
   * @param durationMs 动作时长（毫秒）：挥刀 300、投掷 400
   */
  public playArmSwing(sessionId: string, durationMs: number): void {
    this.avatars.get(sessionId)?.playArmSwing(durationMs);
  }

  public dispose(): void {
    for (const avatar of this.avatars.values()) {
      avatar.dispose(this.scene);
    }
    this.avatars.clear();
  }
}
