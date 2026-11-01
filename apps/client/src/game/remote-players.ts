/**
 * 远端玩家渲染管理：胶囊体化身 + 头顶名牌 + 插值驱动。
 * 视觉风格借鉴 web-multiplayer-template 的「豆子人」思路，用胶囊体简化建模。
 */

import * as THREE from "three";

import { PLAYER_HEIGHT } from "@colyseus-fps/shared";

import { InterpolationBuffer, type TransformSample } from "./interpolation.js";
import type { PlayerState } from "../net/types.js";

/** 由 sessionId 稳定生成化身颜色（HSL 哈希）。 */
export function avatarColor(sessionId: string): THREE.Color {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return new THREE.Color().setHSL((hash % 360) / 360, 0.55, 0.55);
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
  private readonly buffer: InterpolationBuffer;
  private lastSeq = 0;

  public constructor(
    sessionId: string,
    displayName: string,
    interpolationDelayMs: number,
  ) {
    this.root = new THREE.Group();
    this.root.name = `remote-${sessionId}`;
    this.buffer = new InterpolationBuffer(interpolationDelayMs);

    const color = avatarColor(sessionId);

    // 身体胶囊
    const bodyHeight = PLAYER_HEIGHT - 0.6;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, bodyHeight, 6, 14),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
    );
    body.position.y = 0.3 + bodyHeight / 2;
    body.castShadow = true;
    this.root.add(body);

    // 朝向指示（眼部色块），让队友能看到对方视线方向
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.14, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4 }),
    );
    visor.position.set(0, PLAYER_HEIGHT - 0.42, -0.32);
    this.root.add(visor);

    const label = createNameLabel(displayName);
    label.position.y = PLAYER_HEIGHT + 0.45;
    this.root.add(label);
  }

  public pushSample(sample: TransformSample, seq: number): void {
    if (seq < this.lastSeq) {
      return; // 乱序丢弃
    }
    this.lastSeq = seq;
    this.buffer.push(sample);
  }

  /** 按渲染时刻插值并写入场景变换。 */
  public render(renderTimeMs: number): void {
    const transform = this.buffer.sample(renderTimeMs);
    if (!transform) {
      return;
    }
    this.root.position.set(transform.x, transform.y, transform.z);
    this.root.rotation.y = transform.yaw;
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.root);
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        object.geometry?.dispose?.();
        const material = object.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) {
          material.forEach((m) => m.dispose());
        } else {
          material.dispose();
        }
      }
    });
  }
}

/** 管理所有远端玩家的增删改与逐帧渲染。 */
export class RemotePlayerManager {
  private readonly avatars = new Map<string, RemotePlayerAvatar>();

  public constructor(
    private readonly scene: THREE.Scene,
    private readonly interpolationDelayMs: number,
  ) {}

  /**
   * 与最新玩家列表对齐：新玩家建化身、已有玩家压入插值样本、离场玩家移除。
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
        avatar = new RemotePlayerAvatar(
          player.sessionId,
          player.displayName,
          this.interpolationDelayMs,
        );
        this.avatars.set(player.sessionId, avatar);
        this.scene.add(avatar.root);
      }

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

  public render(renderTimeMs: number): void {
    for (const avatar of this.avatars.values()) {
      avatar.render(renderTimeMs);
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
