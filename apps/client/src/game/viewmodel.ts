/**
 * 第一人称枪械视模型：几何体拼装 + 移动摆动 + 开火后坐 + 换弹动画。
 * 思路借鉴 ThreeJS_FPS_2.0 的「枪挂相机」做法（gunHolder attached to camera）。
 */

import * as THREE from "three";

export class ViewModel {
  private readonly holder: THREE.Group;
  private readonly magazine: THREE.Mesh;
  private bobPhase = 0;
  private recoilOffset = 0;
  private recoilRotation = 0;
  private reloadPhase = 0;

  public constructor(camera: THREE.Camera) {
    this.holder = new THREE.Group();
    this.holder.name = "viewmodel";

    const gunMetal = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.5 });
    const gunDark = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({
      color: 0x3b82f6,
      roughness: 0.4,
      emissive: 0x1d4ed8,
      emissiveIntensity: 0.6,
    });

    // 机匣
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.42), gunMetal);
    // 枪管
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), gunDark);
    barrel.position.set(0, 0.02, -0.34);
    // 握把
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.09), gunDark);
    grip.position.set(0, -0.12, 0.12);
    grip.rotation.x = 0.3;
    // 弹匣（换弹时下沉）
    this.magazine = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.07), gunDark);
    this.magazine.position.set(0, -0.1, -0.02);
    // 瞄具发光点
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), accent);
    sight.position.set(0, 0.085, -0.1);

    this.holder.add(receiver, barrel, grip, this.magazine, sight);
    this.holder.position.set(0.24, -0.22, -0.45);
    camera.add(this.holder);
  }

  /** 开火后坐：枪身后顶 + 轻微上抬，指数回弹。 */
  public recoil(): void {
    this.recoilOffset = 0.075;
    this.recoilRotation = 0.09;
  }

  /** moving：是否正在移动（用于摆动）； grounded 预留落地回弹。 */
  public update(dtSeconds: number, moving: boolean, _grounded: boolean, reloadProgress = 0): void {
    if (moving) {
      this.bobPhase += dtSeconds * 9;
    }
    this.recoilOffset *= Math.exp(-dtSeconds * 14);
    this.recoilRotation *= Math.exp(-dtSeconds * 12);

    // 换弹动作：枪身下压并侧倾，弹匣下沉再回位
    const target = reloadProgress > 0 ? 1 : 0;
    this.reloadPhase += (target - this.reloadPhase) * Math.min(1, dtSeconds * 10);
    const reloadDrop = this.reloadPhase * 0.12;
    const reloadTilt = this.reloadPhase * 0.35;
    this.magazine.position.y = -0.1 - this.reloadPhase * 0.1 * Math.sin(Math.PI * reloadProgress);

    const bobX = Math.sin(this.bobPhase) * 0.008;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.01;
    this.holder.position.set(
      0.24 + bobX,
      -0.22 + bobY + this.recoilRotation * 0.12 - reloadDrop,
      -0.45 + this.recoilOffset,
    );
    this.holder.rotation.set(this.recoilRotation - reloadTilt, 0, reloadTilt * 0.4);
  }

  public dispose(camera: THREE.Camera): void {
    camera.remove(this.holder);
    this.holder.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
  }
}
