/**
 * 竞技场地图：几何构建（three.js）。
 *
 * 布局借鉴 web-multiplayer-template 的简洁风格：圆形场地 + 边界 +
 * 对称掩体箱。障碍物数据已上移到 @colyseus-fps/shared，
 * 客户端渲染/物理与服务端弹道遮挡共用同一数据源。
 */

import * as THREE from "three";

import { ARENA_RADIUS, OBSTACLES, obstacleColliders } from "@colyseus-fps/shared";

/** 重新导出，保持既有调用方（Game / 物理）不变。 */
export { obstacleColliders };

/** 构建竞技场场景，返回可加入 scene 的根节点。 */
export function buildArena(): THREE.Group {
  const root = new THREE.Group();
  root.name = "arena";

  // 地面：深色圆盘 + 网格线（借鉴 three.js FPS 示例的 GridHelper 风格）
  const floorGeometry = new THREE.CircleGeometry(ARENA_RADIUS, 64);
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a202c,
    roughness: 0.95,
    metalness: 0,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  const grid = new THREE.GridHelper(ARENA_RADIUS * 2, 30, 0x3b82f6, 0x2d3748);
  grid.position.y = 0.02;
  root.add(grid);

  // 边界围墙：内视圆柱面 + 发光顶线
  const wallGeometry = new THREE.CylinderGeometry(
    ARENA_RADIUS,
    ARENA_RADIUS,
    6,
    64,
    1,
    true,
  );
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b3548,
    roughness: 0.8,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.9,
  });
  const wall = new THREE.Mesh(wallGeometry, wallMaterial);
  wall.position.y = 3;
  root.add(wall);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(ARENA_RADIUS, 0.08, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x3b82f6 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 6;
  root.add(rim);

  // 掩体箱
  for (const obstacle of OBSTACLES) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(obstacle.width, obstacle.height, obstacle.depth),
      new THREE.MeshStandardMaterial({ color: obstacle.color, roughness: 0.85 }),
    );
    mesh.position.set(obstacle.x, obstacle.height / 2, obstacle.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);

    // 顶边描线，增强体积感
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x7aa2f7, transparent: true, opacity: 0.35 }),
    );
    edges.position.copy(mesh.position);
    root.add(edges);
  }

  // 灯光：半球光 + 主方向光（带阴影）
  const hemisphere = new THREE.HemisphereLight(0x9db4d4, 0x1a202c, 0.9);
  root.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(30, 48, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -ARENA_RADIUS - 5;
  sun.shadow.camera.right = ARENA_RADIUS + 5;
  sun.shadow.camera.top = ARENA_RADIUS + 5;
  sun.shadow.camera.bottom = -ARENA_RADIUS - 5;
  sun.shadow.camera.far = 120;
  root.add(sun);

  return root;
}
