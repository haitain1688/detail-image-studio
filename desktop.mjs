import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDetailStudioServer, DEFAULT_DATA_DIR } from "./server.mjs";

let localServer;
let mainWindow;

const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));

// 主进程自己弹原生文件选择器，不依赖渲染进程的 <input type=file>。
// 这样可以绕开「对话框弹在窗口后面 / 模态卡住导致页面点不动」这类 Windows 上的偶发问题。
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp"
};
const MAX_PICK_BYTES = 30 * 1024 * 1024;
const MAX_PICK_COUNT = 12;

// 这台工具是 2D 版面 + 大图预览，软件渲染完全够用；
// 关掉硬件加速可以绕开 Windows 上常见的「GPU process isn't usable」直接闪退。
// macOS 的 GPU 加速一向稳定，保持默认开启。要强制启用 GPU 设 DETAIL_STUDIO_GPU=1。
if (process.env.DETAIL_STUDIO_GPU !== "1" && process.platform !== "darwin") {
  app.disableHardwareAcceleration();
}

// 与 server.mjs 的数据目录保持一致，日志和项目数据落在同一处。
function startupLogDir() {
  return DEFAULT_DATA_DIR;
}

function logStartup(message) {
  try {
    const dir = startupLogDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "startup.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    /* 日志写不了就放弃，不能因为它影响启动 */
  }
}

async function readPickedFiles(paths) {
  const files = [];
  let skipped = 0;
  for (const filePath of paths.slice(0, MAX_PICK_COUNT)) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      if (info.size > MAX_PICK_BYTES) {
        skipped += 1;
        logStartup(`pick-images: 跳过超大文件 ${basename(filePath)} ${info.size}`);
        continue;
      }
      const mime = IMAGE_MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
      const buffer = await readFile(filePath);
      files.push({
        name: basename(filePath),
        mime,
        size: info.size,
        dataUrl: `data:${mime};base64,${buffer.toString("base64")}`
      });
    } catch (error) {
      skipped += 1;
      logStartup(`pick-images: 读取失败 ${basename(filePath)} ${error?.message || error}`);
    }
  }
  return { files, skipped };
}

function registerIpc() {
  ipcMain.on("studio:log", (_event, message) => {
    logStartup(`[ui] ${String(message ?? "").slice(0, 400)}`);
  });

  ipcMain.handle("studio:pick-images", async (event, options = {}) => {
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const multiple = options.multiple !== false;
    const title = typeof options.title === "string" && options.title.trim() ? options.title.trim() : "选择图片";
    logStartup(`pick-images: 请求 multiple=${multiple} owner=${owner && !owner.isDestroyed() ? "有" : "无"}`);

    if (owner && !owner.isDestroyed()) {
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
    }

    const config = {
      title,
      buttonLabel: "选择",
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }]
    };

    let result;
    try {
      result = owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, config)
        : await dialog.showOpenDialog(config);
    } catch (error) {
      logStartup(`pick-images: 对话框异常 ${error?.message || error}`);
      throw new Error(`文件选择器打不开：${error?.message || error}`);
    }

    const paths = result.filePaths || [];
    logStartup(`pick-images: 返回 canceled=${result.canceled} 文件数=${paths.length}`);
    if (owner && !owner.isDestroyed()) owner.focus();
    if (result.canceled || !paths.length) return { files: [], skipped: 0 };

    const { files, skipped } = await readPickedFiles(paths);
    logStartup(`pick-images: 成功读取 ${files.length} 张，跳过 ${skipped}`);
    return { files, skipped };
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#f6f4ef",
    show: false,
    title: "详情图工作台",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });
  mainWindow.loadURL(url).catch((error) => logStartup(`loadURL failed: ${error?.message || error}`));
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    logStartup(`did-fail-load ${code} ${description}`);
  });
}

process.on("uncaughtException", (error) => {
  logStartup(`uncaughtException: ${error?.stack || error}`);
});
process.on("unhandledRejection", (error) => {
  logStartup(`unhandledRejection: ${error?.stack || error}`);
});

app.whenReady().then(async () => {
  logStartup(`app ready, version=${app.getVersion()}, electron=${process.versions.electron}, packaged=${app.isPackaged}`);
  try {
    registerIpc();
    const started = await startDetailStudioServer({ port: 0 });
    localServer = started.server;
    logStartup(`server listening ${started.url}`);
    createWindow(started.url);
  } catch (error) {
    logStartup(`startup failed: ${error?.stack || error}`);
    dialog.showErrorBox("详情图工作台启动失败", `${error?.message || error}\n\n日志：${join(startupLogDir(), "startup.log")}`);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  localServer?.close();
});
