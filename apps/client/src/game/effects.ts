/**
 * 战斗特效：服务端广播的弹道轨迹（tracer）。
 * 每条轨迹存活约 150ms 并渐隐，避免长时间开火累积对象。
 */

import * as THREE from "three";

interface Tracer {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  bornAt: number;
}

const TRACER_LIFE_MS = 150;

export class CombatEffects {
  private readonly tracers: Tracer[] = [];

  public constructor(private readonly scene: THREE.Scene) {}

  /** 添加一条从枪口到命中点的轨迹。 */
  public addTracer(origin: { x: number; y: number; z: number }, hit: { x: number; y: number; z: number }): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(origin.x, origin.y, origin.z),
      new THREE.Vector3(hit.x, hit.y, hit.z),
    ]);
    const material = new THREE.LineBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0.9,
    });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    this.tracers.push({ line, material, bornAt: performance.now() });
  }

  /** 每帧调用：渐隐并清理过期轨迹。 */
  public update(nowMs: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i] as Tracer;
      const age = nowMs - tracer.bornAt;
      if (age >= TRACER_LIFE_MS) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        tracer.material.dispose();
        this.tracers.splice(i, 1);
      } else {
        tracer.material.opacity = 0.9 * (1 - age / TRACER_LIFE_MS);
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
  }
}
