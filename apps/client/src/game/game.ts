/**
 * 游戏编排器：Three.js 场景 + 本地物理 + 网络同步 + HUD。
 *
 * 数据流：
 *   键鼠 → 本地物理（客户端权威，S3 改服务端权威）
 *     → 15Hz 上报 transform → 服务端状态 → 其他客户端
 *   其他客户端状态 → 插值缓冲（延迟 CLIENT_INTERPOLATION_DELAY_MS）→ 远端化身
 */

import * as THREE from "three";

import {
  ARENA_RADIUS,
  CLIENT_INTERPOLATION_DELAY_MS,
  EYE_HEIGHT,
  PLAYER_TRANSFORM_RATE_HZ,
  type PlayerTransformMessage,
} from "@colyseus-fps/shared";

import type { LobbyConnection } from "../net/connection.js";
import type { PlayerState } from "../net/types.js";
import { Hud } from "./hud.js";
import { InputController } from "./input.js";
import { RemotePlayerManager } from "./remote-players.js";
import { buildArena, obstacleColliders } from "./map.js";
import {
  DEFAULT_PHYSICS,
  stepPlayer,
  type MoveInput,
  type PlayerKinematics,
} from "./player-physics.js";
import { ViewModel } from "./viewmodel.js";

const LOOK_SENSITIVITY = 0.0023;
const MAX_PITCH = Math.PI / 2 - 0.02;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly input: InputController;
  private readonly hud: Hud;
  private readonly remotePlayers: RemotePlayerManager;
  private readonly viewModel: ViewModel;
  private readonly colliders = obstacleColliders();

  private readonly kinematics: PlayerKinematics;
  private animationFrameId = 0;
  private lastFrameTime = 0;
  private transformAccumulatorMs = 0;
  private transformSeq = 0;
  private latestPlayers: readonly PlayerState[] = [];
  private disposed = false;

  public constructor(
    private readonly container: HTMLElement,
    private readonly connection: LobbyConnection,
    private readonly selfSessionId: string,
    spawn: { x: number; y: number; z: number },
  ) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1220);
    this.scene.fog = new THREE.Fog(0x0b1220, 25, ARENA_RADIUS + 25);

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
    container.append(this.renderer.domElement);

    this.scene.add(buildArena());

    this.input = new InputController(this.renderer.domElement);
    this.hud = new Hud(container);
    this.remotePlayers = new RemotePlayerManager(this.scene, CLIENT_INTERPOLATION_DELAY_MS);
    this.viewModel = new ViewModel(this.camera);

    this.kinematics = {
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      vy: 0,
      yaw: Math.atan2(-spawn.x, -spawn.z), // 面向场地中心
      pitch: 0,
      grounded: true,
    };

    this.hud.setLockOverlayVisible(true);
    this.renderer.domElement.addEventListener("click", this.handleCanvasClick);
    document.addEventListener("pointerlockchange", this.handlePointerLockChange);
    window.addEventListener("resize", this.handleResize);
  }

  private readonly handleCanvasClick = (): void => {
    if (!this.input.isPointerLocked()) {
      this.input.requestLock();
    }
  };

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
    // 视角
    const look = this.input.consumeLookDelta();
    this.kinematics.yaw -= look.dx * LOOK_SENSITIVITY;
    this.kinematics.pitch = Math.min(
      MAX_PITCH,
      Math.max(-MAX_PITCH, this.kinematics.pitch - look.dy * LOOK_SENSITIVITY),
    );

    // 移动
    const moveInput: MoveInput = {
      forward: this.input.isDown("KeyW") || this.input.isDown("ArrowUp"),
      backward: this.input.isDown("KeyS") || this.input.isDown("ArrowDown"),
      left: this.input.isDown("KeyA") || this.input.isDown("ArrowLeft"),
      right: this.input.isDown("KeyD") || this.input.isDown("ArrowRight"),
      sprint: this.input.isDown("ShiftLeft") || this.input.isDown("ShiftRight"),
      jump: this.input.isDown("Space"),
    };
    const locked = this.input.isPointerLocked();
    stepPlayer(
      this.kinematics,
      locked ? moveInput : { forward: false, backward: false, left: false, right: false, sprint: false, jump: false },
      dtSeconds,
      this.colliders,
      { ...DEFAULT_PHYSICS, arenaRadius: ARENA_RADIUS },
    );

    // 相机
    this.camera.position.set(
      this.kinematics.x,
      this.kinematics.y + EYE_HEIGHT,
      this.kinematics.z,
    );
    this.camera.rotation.set(this.kinematics.pitch, this.kinematics.yaw, 0);

    // 网络上报（固定频率，与渲染帧率解耦）
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
        yaw: this.kinematics.yaw,
        pitch: this.kinematics.pitch,
      };
      this.connection.sendTransform(message);
    }

    // 远端插值渲染（回退固定延迟，见 shared 常量）
    this.remotePlayers.render(nowMs - 0); // sample 内部已减延迟

    // 视模型摆动
    const moving =
      locked &&
      (moveInput.forward || moveInput.backward || moveInput.left || moveInput.right) &&
      this.kinematics.grounded;
    this.viewModel.update(dtSeconds, moving, this.kinematics.grounded);

    // HUD
    this.hud.update({
      position: { x: this.kinematics.x, y: this.kinematics.y, z: this.kinematics.z },
      playerCount: this.latestPlayers.length,
      remoteCount: this.remotePlayers.count(),
    });

    this.renderer.render(this.scene, this.camera);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    cancelAnimationFrame(this.animationFrameId);
    this.renderer.domElement.removeEventListener("click", this.handleCanvasClick);
    document.removeEventListener("pointerlockchange", this.handlePointerLockChange);
    window.removeEventListener("resize", this.handleResize);
    this.input.dispose();
    this.hud.dispose();
    this.remotePlayers.dispose();
    this.viewModel.dispose(this.camera);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
