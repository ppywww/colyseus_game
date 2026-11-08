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
  AvatarModel,
  BOB_FADE_TAU,
  BOB_RAD_PER_METER,
  FALL_DURATION_MS,
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

/** 出生地默认队伍（服务端一定下发 team，这里只是防御性兜底）。 */
function teamOf(player: PlayerState): TeamId {
  return player.team === "CT" ? "CT" : "T";
}

function createNameLabel(displayName: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    context.font = "bold 32px 'Segoe UI', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "rgba(10, 14, 22, 0.55)";
    const width = context.measureText(displayName).width + 28;
    context.fillRect(128 - width / 2, 8, width, 48);
    context.fillStyle = "#e2e8f0";
    context.fillText(displayName, 128, 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(2.2, 0.55, 1);
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

  public constructor(player: PlayerState, interpolationDelayMs: number) {
    this.model = new AvatarModel(teamOf(player));
    this.root = this.model.root;
    this.root.name = `remote-${player.sessionId}`;
    this.buffer = new InterpolationBuffer(interpolationDelayMs);

    this.label = createNameLabel(player.displayName);
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

  /** 同步非位置状态（武器槽 / 存活），立即生效，不做淡入。 */
  public syncState(player: PlayerState): void {
    if (player.weaponSlot !== this.lastWeaponSlot) {
      this.lastWeaponSlot = player.weaponSlot;
      this.model.setWeaponSlot(player.weaponSlot);
    }

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

  public dispose(): void {
    for (const avatar of this.avatars.values()) {
      avatar.dispose(this.scene);
    }
    this.avatars.clear();
  }
}
