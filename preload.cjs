// 预加载脚本：只把「选图片」和「写日志」两件小事暴露给页面，其余能力一律不给。
// 走主进程的原生选择器，避免渲染进程 <input type=file> 在 Windows 上偶发的弹窗异常。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopStudio", {
  version: 1,
  pickImages: (options) => ipcRenderer.invoke("studio:pick-images", options || {}),
  log: (message) => ipcRenderer.send("studio:log", message)
});
