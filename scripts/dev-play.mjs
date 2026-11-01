/**
 * 一键试玩脚本：关闭残留 dev 进程 -> 启动服务端 + 客户端 -> 打开两个浏览器窗口。
 *
 * 用法：
 *   pnpm play
 *
 * 环境变量（均可选）：
 *   SERVER_PORT  服务端端口，默认 2567
 *   CLIENT_PORT  客户端端口，默认 5173
 *   PLAY_URL     客户端页面地址，默认 http://localhost:5173
 *   DRY_RUN=1    只启动服务并检测端口，不打开浏览器（自测用）
 *   SELF_TEST=1  端口就绪后立即退出（自动清理，用于脚本自测）
 *
 * Ctrl+C 会连带杀掉服务端/客户端进程树。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 2567);
const CLIENT_PORT = Number(process.env.CLIENT_PORT ?? 5173);
const PLAY_URL = process.env.PLAY_URL ?? `http://localhost:${CLIENT_PORT}`;
const DRY_RUN = process.env.DRY_RUN === "1";
const SELF_TEST = process.env.SELF_TEST === "1";

const isWindows = process.platform === "win32";
const children = [];

function log(message) {
  console.log(`[play] ${message}`);
}

/** 执行命令并收集输出。 */
function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args.join(" ")} 失败: ${error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** 查找占用端口的 PID 列表（仅 Windows 用 netstat；其他平台暂不支持则返回空）。 */
async function findPidsOnPort(port) {
  if (!isWindows) {
    return [];
  }
  const { stdout } = await run("netstat", ["-ano"]);
  const pids = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) {
      continue;
    }
    // 形如 "  TCP    0.0.0.0:2567   0.0.0.0:0   LISTENING   12345"
    const parts = line.trim().split(/\s+/);
    const local = parts[1] ?? "";
    const pid = Number(parts[parts.length - 1]);
    if (local.endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/** 杀掉占用指定端口的残留进程（含进程树）。 */
async function killPortOccupants(port, label) {
  let pids;
  try {
    pids = await findPidsOnPort(port);
  } catch {
    log(`无法检测端口 ${port} 占用情况，跳过清理`);
    return;
  }
  for (const pid of pids) {
    if (pid === process.pid) {
      continue;
    }
    try {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
      log(`已关闭占用 ${label}端口 ${port} 的残留进程 (PID ${pid})`);
    } catch {
      log(`关闭残留进程 PID ${pid} 失败，请手动检查端口 ${port}`);
    }
  }
}

/** 轮询等待端口可建立 TCP 连接（监听即就绪；Colyseus 对 GET / 不回标准响应）。 */
function waitForPort(port, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        log(`${label}端口 ${port} 已就绪`);
        resolve();
      });
      socket.once("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`${label}端口 ${port} 等待超时（服务可能启动失败，请查看上方输出）`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** 启动 pnpm 子进程并记录，便于退出时清理。 */
function spawnPnpm(args, name) {
  // Windows 上 .cmd 必须通过 shell 启动（Node 安全限制）；命令拼成单串避免参数转义告警。
  const child = spawn(`pnpm ${args.join(" ")}`, {
    cwd: rootDir,
    stdio: "inherit",
    shell: true,
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0 && !shuttingDown) {
      log(`警告: ${name} 进程已退出（代码 ${code}）`);
    }
  });
  children.push({ child, name });
  return child;
}

let shuttingDown = false;

/** 退出清理：Windows 用 taskkill /T 杀整棵进程树。 */
async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("正在关闭服务端与客户端…");
  await Promise.all(
    children.map(async ({ child, name }) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        if (isWindows) {
          await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
        } else {
          child.kill("SIGTERM");
        }
        log(`${name} 已关闭`);
      } catch {
        log(`${name} 关闭失败（PID ${child.pid}），请手动结束`);
      }
    }),
  );
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

/** 打开浏览器窗口；优先 Chrome/Edge/Firefox 的新窗口模式。 */
async function openBrowserWindow(url) {
  if (!isWindows) {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    { exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: ["--new-window", url] },
    { exe: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", args: ["--new-window", url] },
    { exe: path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"), args: ["--new-window", url] },
    { exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", args: ["--new-window", url] },
    { exe: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", args: ["--new-window", url] },
    { exe: "C:\\Program Files\\Mozilla Firefox\\firefox.exe", args: ["-new-window", url] },
  ];
  for (const { exe, args } of candidates) {
    if (!existsSync(exe)) {
      continue;
    }
    spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  // 兜底：交给系统默认浏览器
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  log(`项目目录: ${rootDir}`);
  log("第一步: 关闭残留的 dev 服务进程…");
  await killPortOccupants(SERVER_PORT, "服务端");
  await killPortOccupants(CLIENT_PORT, "客户端");

  // 注意：实测先起客户端再起服务端最稳（vite 秒起；反之在某些终端环境
  // 第二个 pnpm 子进程可能迟迟不执行）。vite 的 ws 代理是懒连接，顺序无影响。
  log("第二步: 启动客户端 (pnpm dev:client) …");
  spawnPnpm(["dev:client"], "客户端");
  await waitForPort(CLIENT_PORT, "客户端", 120000);

  log("第三步: 启动服务端 (pnpm dev:server) …");
  spawnPnpm(["dev:server"], "服务端");
  await waitForPort(SERVER_PORT, "服务端");

  if (DRY_RUN) {
    log("DRY_RUN=1，跳过打开浏览器");
  } else {
    log("第五步: 打开两个浏览器窗口进入游戏…");
    await openBrowserWindow(PLAY_URL);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await openBrowserWindow(PLAY_URL);
    log("已请求打开两个窗口；请在各自页面输入玩家名并点击「进入战场」");
  }

  if (SELF_TEST) {
    await shutdown(0);
  }
}

main().catch((error) => {
  console.error(`[play] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  void shutdown(1);
});
