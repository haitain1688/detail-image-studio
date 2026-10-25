const ERRORS = {
  api_not_configured: "还没填 API Key，点右上角「API 设置」",
  invalid_api_key: "Key 格式不对，应以 sk- 开头",
  invalid_base_url: "BaseURL 格式不对，需要以 http:// 或 https:// 开头",
  connection_timeout: "连接超时，检查 BaseURL 或网络代理",
  missing_product_image: "先上传产品图",
  missing_images: "先上传样板图",
  missing_image: "没有拿到图片",
  missing_prompt: "模块提示词太短，至少写一句",
  prompt_too_long: "提示词过长",
  api_auth_failed: "API Key 无效或已过期",
  api_rate_limited: "调用太频繁，稍后再试",
  generation_timeout: "生成超时（超过 7 分钟上游没返回），已自动放弃，可重试",
  generation_cancelled: "已取消这次生成",
  generation_invalid_request: "上游拒绝了这次请求，检查提示词或比例",
  generation_empty_response: "上游返回了空图，重试一次",
  generation_upstream_error: "上游服务异常，稍后重试",
  generation_failed: "生成失败",
  model_not_found: "模型不可用，检查网关配置",
  analysis_timeout: "分析超时，换个方式再试",
  analysis_failed: "分析失败，检查图片或稍后重试",
  payload_too_large: "图片太大，换小一点的图",
  project_not_found: "项目不存在",
  module_not_found: "模块不存在，刷新一下",
  invalid_project_id: "项目 ID 异常",
  invalid_json: "请求格式错误",
  license_expired: "软件授权已到期，点右上角「授权」续期",
  license_invalid: "授权无效，需要重新激活",
  license_malformed: "激活码格式不对，请整段完整复制",
  license_signature_invalid: "激活码校验失败，可能复制时漏了字符",
  license_machine_mismatch: "这个激活码是给另一台电脑的",
  license_already_expired: "这个激活码本身已经过期了",
  missing_license_code: "请先粘贴激活码"
};

const RATIOS = [
  ["1:1", "1:1 方图"],
  ["3:4", "3:4 竖图"],
  ["4:3", "4:3 横图"],
  ["9:16", "9:16 竖图"],
  ["16:9", "16:9 横图"]
];

const state = {
  project: null,
  projects: [],
  license: null,
  busy: new Set(),
  busySince: new Map(),
  controllers: new Map(),
  expanded: new Set(),
  needsAnalyze: new Set(),
  refBusy: new Set(),
  refTargetId: "",
  productBusy: false,
  batch: null,
  runningAll: false,
  cancelAll: false,
  saveTimer: null,
  dirty: false,
  saving: false
};

const el = (id) => document.getElementById(id);
const qsa = (root, selector) => Array.from(root.querySelectorAll(selector));

/* ------------------------------- utils ------------------------------- */

function toast(message, ms = 2600) {
  const node = el("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, ms);
}

function errorText(code) {
  return ERRORS[code] || code || "操作失败";
}

function confirmDialog(message, options = {}) {
  const dialog = el("confirm-dialog");
  if (dialog.open) return Promise.resolve(false);
  el("confirm-title").textContent = options.title || "确认";
  el("confirm-message").textContent = message;
  el("confirm-ok").textContent = options.okText || "确定";
  el("confirm-cancel").textContent = options.cancelText || "取消";
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolveConfirm) => {
    dialog.addEventListener("close", function onClose() {
      dialog.removeEventListener("close", onClose);
      resolveConfirm(dialog.returnValue === "ok");
    });
  });
}

function elapsedLabel(since) {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes} 分 ${String(rest).padStart(2, "0")} 秒` : `${rest} 秒`;
}

function startTicker() {
  if (startTicker.timer) return;
  startTicker.timer = setInterval(() => {
    const nodes = qsa(document, ".busy-text[data-since]");
    if (!nodes.length) {
      clearInterval(startTicker.timer);
      startTicker.timer = null;
      return;
    }
    nodes.forEach((node) => {
      node.textContent = `生成中… ${elapsedLabel(Number(node.dataset.since))}`;
    });
  }, 1000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `http_${response.status}`);
    error.code = data.error || `http_${response.status}`;
    // 授权类错误统一把状态刷到最新，并顺带弹出激活窗口，省得用户不知道去哪续期
    if (typeof error.code === "string" && error.code.startsWith("license_")) {
      if (data.license) state.license = data.license;
      renderLicense();
      setTimeout(openLicenseDialog, 300);
    }
    throw error;
  }
  return data;
}

/* --------------------------- 选图片（桌面版走原生选择器） --------------------------- */

function desktopBridge() {
  const bridge = window.desktopStudio;
  return bridge && typeof bridge.pickImages === "function" ? bridge : null;
}

function bridgeLog(message) {
  try {
    desktopBridge()?.log?.(message);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function dataUrlToFile(item) {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(item?.dataUrl || "");
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], item.name || "image.png", { type: match[1] });
}

// 桌面版返回 File[]；浏览器版返回 null，调用方回退到 <input type=file>
async function chooseImageFiles(options = {}) {
  const bridge = desktopBridge();
  if (!bridge) return null;
  const multiple = options.multiple !== false;
  try {
    bridgeLog(`picker:open multiple=${multiple}`);
    const result = await bridge.pickImages({ multiple, title: options.title || "选择图片" });
    const picked = result?.files || [];
    const skipped = Number(result?.skipped || 0);
    bridgeLog(`picker:close count=${picked.length} skipped=${skipped}`);
    if (skipped) toast(`有 ${skipped} 张图片读不出来或超过 30MB，已跳过`);
    return picked.map(dataUrlToFile).filter(Boolean);
  } catch (error) {
    bridgeLog(`picker:error ${error?.message || error}`);
    toast(`文件选择器打不开：${error?.message || error}`, 7000);
    return [];
  }
}

// 统一入口：优先原生选择器，拿不到就交给原来的 input
async function pickInto(inputId, handler, options = {}) {
  const files = await chooseImageFiles(options);
  if (files === null) {
    el(inputId).click();
    return;
  }
  if (files.length) await handler(files);
}

function readImage(file, maxEdge = 1600) {
  return new Promise((resolveFile, rejectFile) => {
    const reader = new FileReader();
    reader.onerror = () => rejectFile(new Error("read_failed"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => rejectFile(new Error("decode_failed"));
      image.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
        if (scale === 1 && file.size < 900 * 1024) {
          resolveFile(reader.result);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolveFile(canvas.toDataURL("image/jpeg", 0.92));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolveImage, rejectImage) => {
    const image = new Image();
    image.onload = () => resolveImage(image);
    image.onerror = () => rejectImage(new Error("image_load_failed"));
    image.src = src;
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(meta)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

/* ------------------------------- saving ------------------------------- */

function setSaveState(text, dirty = false) {
  const node = el("save-state");
  node.textContent = text;
  node.classList.toggle("is-dirty", dirty);
}

function scheduleSave(delay = 1200) {
  if (!state.project) return;
  state.dirty = true;
  setSaveState("未保存", true);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveProject, delay);
}

async function saveProject() {
  if (!state.project) return;
  if (state.busy.size || state.runningAll) {
    state.saveTimer = setTimeout(saveProject, 1500);
    return;
  }
  if (state.saving) return;
  state.saving = true;
  setSaveState("保存中…", true);
  try {
    const data = await api(`/api/projects/${state.project.id}`, { method: "PUT", body: state.project });
    state.dirty = false;
    setSaveState("已保存");
    // 服务端会保留比本地更新的生成结果（防止旧页面覆盖新图），这里把差异同步回界面
    const diskModules = data?.project?.modules;
    if (Array.isArray(diskModules)) {
      const byId = new Map(diskModules.map((item) => [item.id, item]));
      let changed = false;
      state.project.modules.forEach((module) => {
        const disk = byId.get(module.id);
        if (!disk?.result?.image) return;
        const diskTime = Date.parse(disk.result.updatedAt || disk.result.createdAt || 0) || 0;
        const localTime = Date.parse(module.result?.updatedAt || module.result?.createdAt || 0) || 0;
        if (diskTime > localTime) {
          module.result = disk.result;
          module.error = disk.error || "";
          changed = true;
        }
      });
      const diskAnchor = data.project.style?.anchorImage;
      if (diskAnchor && diskAnchor !== state.project.style.anchorImage) {
        state.project.style.anchorImage = diskAnchor;
        state.project.style.anchorModuleId = data.project.style.anchorModuleId || "";
        changed = true;
      }
      if (changed) {
        renderStyle();
        renderModules();
      }
    }
  } catch (error) {
    setSaveState("保存失败", true);
    toast(`保存失败：${errorText(error.code)}`);
  } finally {
    state.saving = false;
  }
}

/* ------------------------------- license ------------------------------- */

function licenseUsable() {
  const license = state.license;
  // 拿不到状态时放行，真正的拦截在服务端
  return !license || license.state === "licensed" || license.state === "trial";
}

function licenseDaysText(license) {
  if (!license) return "—";
  if (license.state === "licensed") return `${license.daysLeft} 天`;
  if (license.state === "trial") return `试用 ${license.trialLeft} 天`;
  if (license.state === "expired") return "已到期";
  if (license.state === "invalid") return "无效";
  return "—";
}

function renderLicenseBanner() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const existing = document.getElementById("license-banner");
  if (licenseUsable()) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const license = state.license || {};
  const banner = document.createElement("div");
  banner.id = "license-banner";
  banner.className = "license-banner";
  const text = document.createElement("span");
  const strong = document.createElement("strong");
  if (license.state === "expired") {
    strong.textContent = license.expiresAt ? `授权已于 ${license.expiresAt} 到期` : "试用期已结束";
    text.append(strong, document.createTextNode("。已有项目、长图和导出都还能用，生成与分析要激活后才能继续。"));
  } else {
    strong.textContent = "授权无效";
    text.append(strong, document.createTextNode("。重新粘贴激活码，或把机器码发给发码方换一个。"));
  }
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "去激活";
  button.addEventListener("click", openLicenseDialog);
  banner.append(text, button);
  workspace.parentNode.insertBefore(banner, workspace);
}

function renderLicense() {
  const license = state.license || {};
  const badge = el("license-badge");
  if (!badge) return;

  let badgeText = "—";
  let badgeClass = "";
  if (license.state === "licensed") {
    badgeText = `${license.daysLeft} 天`;
    badgeClass = license.daysLeft <= 14 ? "is-warn" : "is-ok";
  } else if (license.state === "trial") {
    badgeText = `试用 ${license.trialLeft} 天`;
    badgeClass = license.trialLeft <= 3 ? "is-warn" : "";
  } else if (license.state === "expired") {
    badgeText = "已到期";
    badgeClass = "is-bad";
  } else if (license.state === "invalid") {
    badgeText = "无效";
    badgeClass = "is-bad";
  }
  badge.textContent = badgeText;
  badge.className = `license-badge${badgeClass ? ` ${badgeClass}` : ""}`;
  el("license-btn").title = license.message || "";

  const chip = el("license-chip");
  if (chip) {
    const label =
      license.state === "licensed" ? "已授权" :
      license.state === "trial" ? "试用中" :
      license.state === "expired" ? "已到期" :
      license.state === "invalid" ? "授权无效" : "未知";
    chip.textContent = label;
    chip.className = `license-chip${licenseUsable() ? " is-ok" : " is-bad"}`;
  }

  const meta = el("license-meta");
  if (meta) {
    const parts = [];
    if (license.customer) parts.push(license.customer);
    if (license.expiresAt) parts.push(`到期 ${license.expiresAt}`);
    else if (license.trialEndsAt) parts.push(`试用至 ${license.trialEndsAt}`);
    if (license.clockWarned) parts.push("检测到系统时间被回拨");
    meta.textContent = parts.join(" · ");
  }

  const machine = el("license-machine");
  if (machine) machine.textContent = license.machineCode || "读取中…";

  renderLicenseBanner();
}

function setLicenseState(text, tone) {
  const node = el("license-state");
  if (!node) return;
  node.textContent = text || "";
  node.className = `dialog-state${tone ? ` is-${tone}` : ""}`;
}

function openLicenseDialog() {
  renderLicense();
  el("license-input").value = "";
  setLicenseState("", "");
  const dialog = el("license-dialog");
  if (!dialog.open) dialog.showModal();
}

async function refreshLicense() {
  try {
    const data = await api("/api/license");
    state.license = data.license;
    renderLicense();
  } catch {
    /* 拿不到就先不显示，避免挡住主流程 */
  }
}

async function copyMachineCode() {
  const code = state.license?.machineCode || "";
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    setLicenseState("机器码已复制", "ok");
  } catch {
    const range = document.createRange();
    const node = el("license-machine");
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    setLicenseState("已选中机器码，按 Ctrl+C 复制", "warn");
  }
}

async function activateLicense() {
  const input = el("license-input");
  const code = input.value.trim();
  if (!code) {
    setLicenseState("请先粘贴激活码", "warn");
    return;
  }
  const button = el("license-activate");
  button.disabled = true;
  setLicenseState("正在校验…", "");
  try {
    const data = await api("/api/license/activate", { method: "POST", body: { code } });
    state.license = data.license;
    renderLicense();
    input.value = "";
    setLicenseState(`激活成功，有效期到 ${data.license.expiresAt}`, "ok");
    toast(`已授权，有效期到 ${data.license.expiresAt}`, 4000);
  } catch (error) {
    setLicenseState(errorText(error.code), "error");
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------- style ------------------------------- */

function renderStyle() {
  const style = state.project?.style || {};
  const profile = style.profile;
  el("style-enabled").checked = style.enabled !== false;

  if (!profile) {
    el("style-empty").hidden = false;
    el("style-body").hidden = true;
  } else {
    el("style-empty").hidden = true;
    el("style-body").hidden = false;
    el("style-name").textContent = profile.styleName || "统一风格";
    const palette = el("palette");
    palette.innerHTML = "";
    (profile.palette || []).slice(0, 6).forEach((item) => {
      const chip = document.createElement("span");
      chip.className = "swatch";
      chip.title = `${item.hex} · ${item.usage || ""}`;
      const dot = document.createElement("i");
      dot.style.background = /^#[0-9a-f]{3,8}$/i.test(item.hex) ? item.hex : "#ddd";
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(item.name || item.hex));
      palette.appendChild(chip);
    });

    const facts = el("style-facts");
    facts.innerHTML = "";
    [
      ["背景", profile.background, "free"],
      ["光影", profile.lighting, "lock"],
      ["道具", profile.props, "free"],
      ["构图", profile.composition, "free"],
      ["字体", profile.typography, "lock"],
      ["质感", profile.finish, "lock"],
      ["禁止", profile.negative, ""]
    ].forEach(([label, value, scope]) => {
      if (!value) return;
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      if (scope) {
        const flag = document.createElement("em");
        flag.className = `fact-flag is-${scope}`;
        flag.textContent = scope === "lock" ? "锁定" : "不锁";
        flag.title =
          scope === "lock"
            ? "每一项都会逐字注入，保证所有图一致"
            : "只作风格参考，生成时整段剔除，由各模块自己的参考图决定";
        dd.appendChild(flag);
      }
      dd.appendChild(document.createTextNode(value));
      row.append(dt, dd);
      facts.appendChild(row);
    });
  }

  el("lock-text").value = style.lockText || "";

  const anchorRow = el("anchor-row");
  if (style.anchorImage) {
    anchorRow.hidden = false;
    el("anchor-thumb").src = style.anchorImage;
    el("anchor-thumb").title = "点击放大";
    el("anchor-thumb").dataset.zoomLabel = "风格锚图";
  } else {
    anchorRow.hidden = true;
  }
}

/* ------------------------------- modules ------------------------------- */

function moduleCard(module, index) {
  const card = document.createElement("article");
  card.className = "module-card";
  card.dataset.id = module.id;

  const isBusy = state.busy.has(module.id);
  const isCollapsed = !state.expanded.has(module.id);
  if (isCollapsed) card.classList.add("is-collapsed");

  const head = document.createElement("div");
  head.className = "module-head";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "module-toggle";
  toggleButton.dataset.act = "toggle";
  toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
  toggleButton.title = isCollapsed ? "展开模块" : "收起模块";
  toggleButton.textContent = isCollapsed ? "▶" : "▼";

  const number = document.createElement("span");
  number.className = "module-index";
  number.textContent = String(index + 1).padStart(2, "0");

  const nameInput = document.createElement("input");
  nameInput.className = "module-name";
  nameInput.value = module.name;
  nameInput.setAttribute("aria-label", "模块名称");
  nameInput.addEventListener("input", () => {
    module.name = nameInput.value;
    scheduleSave();
  });

  const chips = document.createElement("div");
  chips.className = "module-chips";

  const ratioChip = document.createElement("span");
  ratioChip.className = "chip-info";
  ratioChip.textContent = `${module.ratio || "1:1"}${module.renderText === false ? " · 无字" : ""}`;
  chips.appendChild(ratioChip);

  const promptLength = (module.prompt || "").trim().length;
  const promptChip = document.createElement("span");
  promptChip.className = promptLength < 8 ? "chip-info is-warn" : "chip-info";
  promptChip.textContent = promptLength < 8 ? "无提示词" : `提示词 ${promptLength} 字`;
  chips.appendChild(promptChip);

  if (module.referenceImage) {
    const refChip = document.createElement("span");
    refChip.className = "chip-info";
    refChip.textContent = "参考图";
    chips.appendChild(refChip);
  }

  if (isBusy) {
    const busyChip = document.createElement("span");
    busyChip.className = "chip-info is-busy busy-text";
    busyChip.dataset.since = String(state.busySince.get(module.id) || Date.now());
    busyChip.textContent = `生成中… ${elapsedLabel(Number(busyChip.dataset.since))}`;
    chips.appendChild(busyChip);

    const cancelChip = document.createElement("button");
    cancelChip.type = "button";
    cancelChip.className = "chip-info is-busy chip-action";
    cancelChip.textContent = "取消";
    cancelChip.dataset.act = "cancel";
    chips.appendChild(cancelChip);
    startTicker();
  } else if (module.error) {
    const statusChip = document.createElement("span");
    statusChip.className = "chip-info is-warn";
    statusChip.textContent = `失败：${errorText(module.error)}`;
    chips.appendChild(statusChip);
  } else {
    const statusChip = document.createElement("span");
    statusChip.className = module.result?.image ? "chip-info is-ok" : "chip-info";
    statusChip.textContent = module.result?.image ? "已生成" : "未生成";
    chips.appendChild(statusChip);
  }

  const tools = document.createElement("div");
  tools.className = "module-tools";

  const ratio = document.createElement("select");
  ratio.setAttribute("aria-label", "比例");
  RATIOS.forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = module.ratio === value;
    ratio.appendChild(option);
  });
  ratio.addEventListener("change", () => {
    module.ratio = ratio.value;
    scheduleSave();
  });

  const quality = document.createElement("select");
  quality.setAttribute("aria-label", "质量");
  [["high", "高质量"], ["auto", "自动"]].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = (module.quality || "high") === value;
    quality.appendChild(option);
  });
  quality.addEventListener("change", () => {
    module.quality = quality.value;
    scheduleSave();
  });

  const renderLabel = document.createElement("label");
  renderLabel.className = "chip";
  const renderToggle = document.createElement("input");
  renderToggle.type = "checkbox";
  renderToggle.checked = module.renderText !== false;
  renderToggle.addEventListener("change", () => {
    module.renderText = renderToggle.checked;
    scheduleSave();
  });
  renderLabel.append(renderToggle, document.createTextNode("图中带字"));

  const genButton = document.createElement("button");
  genButton.type = "button";
  genButton.className = "btn-ghost btn-gen";
  genButton.textContent = module.result ? "重生成" : "生成";
  genButton.dataset.act = "gen";

  const libraryButton = document.createElement("button");
  libraryButton.type = "button";
  libraryButton.className = "btn-ghost";
  libraryButton.textContent = "存为模板";
  libraryButton.dataset.act = "library";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "btn-ghost btn-del";
  deleteButton.textContent = "删除";
  deleteButton.dataset.act = "delete";

  const expandButton = document.createElement("button");
  expandButton.type = "button";
  expandButton.className = "btn-ghost btn-expand";
  expandButton.textContent = "展开";
  expandButton.dataset.act = "toggle";

  tools.append(ratio, quality, renderLabel, genButton, expandButton, libraryButton, deleteButton);

  head.append(toggleButton, number, nameInput, chips);
  if (module.result?.image) {
    const miniThumb = document.createElement("img");
    miniThumb.className = "module-mini";
    miniThumb.src = module.result.image;
    miniThumb.alt = "";
    miniThumb.title = "点击展开查看";
    miniThumb.dataset.act = "toggle";
    head.appendChild(miniThumb);
  }
  head.appendChild(tools);

  const body = document.createElement("div");
  body.className = "module-body";

  const visual = document.createElement("div");
  visual.className = "module-visual";

  if (module.result?.image) {
    const image = document.createElement("img");
    image.src = module.result.image;
    image.alt = module.name;
    image.title = "点击放大";
    image.dataset.zoomLabel = module.name;
    visual.appendChild(image);

    const actions = document.createElement("div");
    actions.className = "visual-actions";

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.textContent = "下载";
    downloadButton.dataset.act = "download";

    const regenerateButton = document.createElement("button");
    regenerateButton.type = "button";
    regenerateButton.textContent = "重生成";
    regenerateButton.dataset.act = "gen";
    regenerateButton.disabled = isBusy;

    actions.append(downloadButton, regenerateButton);
    visual.appendChild(actions);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    const placeholderText = document.createElement("span");
    placeholderText.textContent = isBusy ? "正在生成这一张…" : "这个模块还没生成";
    placeholder.appendChild(placeholderText);
    if (!isBusy) {
      const soloButton = document.createElement("button");
      soloButton.type = "button";
      soloButton.className = "btn-primary btn-sm";
      soloButton.textContent = "单独生成这张";
      soloButton.dataset.act = "gen";
      placeholder.appendChild(soloButton);
    }
    visual.appendChild(placeholder);
  }

  if (isBusy) {
    visual.classList.add("is-busy");
    const busyBox = document.createElement("div");
    busyBox.className = "busy-box";
    const busyText = document.createElement("div");
    busyText.className = "busy-text";
    busyText.dataset.since = String(state.busySince.get(module.id) || Date.now());
    busyText.textContent = `生成中… ${elapsedLabel(Number(busyText.dataset.since))}`;
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "btn-ghost btn-sm btn-cancel";
    cancelButton.textContent = "取消";
    cancelButton.dataset.act = "cancel";
    busyBox.append(busyText, cancelButton);
    visual.appendChild(busyBox);
    genButton.disabled = true;
    genButton.textContent = "生成中";
    startTicker();
  }

  const fields = document.createElement("div");
  fields.className = "module-fields";

  const refRow = document.createElement("div");
  refRow.className = "module-ref";
  if (module.referenceImage) refRow.classList.add("has-image");

  const refThumb = document.createElement("div");
  refThumb.className = "ref-thumb";
  if (module.referenceImage) {
    const refImage = document.createElement("img");
    refImage.src = module.referenceImage;
    refImage.alt = "模块参考图";
    refImage.title = "点击放大";
    refImage.dataset.zoomLabel = `${module.name} · 参考图`;
    refThumb.appendChild(refImage);
  } else {
    const refEmpty = document.createElement("span");
    refEmpty.textContent = "参考图";
    refThumb.appendChild(refEmpty);
  }

  const refBody = document.createElement("div");
  refBody.className = "ref-body";
  const refTitle = document.createElement("span");
  refTitle.className = "ref-title";
  refTitle.textContent = state.refBusy.has(module.id) ? "正在读取参考图…" : "这个模块的参考图";
  const refHint = document.createElement("span");
  refHint.className = "ref-hint";
  refHint.textContent = state.refBusy.has(module.id)
    ? "正在提取版式、文案与提示词"
    : "上传后按这张图反推本模块的提示词与文案，风格仍按左侧锁定规范统一";

  const refButtons = document.createElement("div");
  refButtons.className = "ref-btns";

  const refUpload = document.createElement("button");
  refUpload.type = "button";
  refUpload.className = "btn-ghost";
  refUpload.textContent = module.referenceImage ? "换一张" : "上传参考图";
  refUpload.dataset.act = "ref-upload";
  refUpload.disabled = state.refBusy.has(module.id);

  const refExtract = document.createElement("button");
  refExtract.type = "button";
  refExtract.className = "btn-ghost";
  refExtract.textContent = state.refBusy.has(module.id)
    ? "分析中…"
    : state.needsAnalyze.has(module.id)
      ? "按新图重写提示词"
      : "按参考图生成提示词";
  refExtract.dataset.act = "ref-prompt";
  refExtract.disabled = !module.referenceImage || state.refBusy.has(module.id);
  if (state.needsAnalyze.has(module.id)) refExtract.classList.add("btn-attn");

  refButtons.append(refUpload, refExtract);

  if (module.referenceImage) {
    const refClear = document.createElement("button");
    refClear.type = "button";
    refClear.className = "btn-ghost btn-del";
    refClear.textContent = "移除";
    refClear.dataset.act = "ref-clear";
    refClear.disabled = state.refBusy.has(module.id);
    refButtons.appendChild(refClear);
  }

  refBody.append(refTitle, refHint, refButtons);
  refRow.append(refThumb, refBody);

  const copyRow = document.createElement("div");
  copyRow.className = "field-row";

  const titleField = document.createElement("label");
  titleField.className = "field";
  const titleLabel = document.createElement("span");
  titleLabel.textContent = "主标题";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.value = module.copy?.title || "";
  titleInput.placeholder = "例：东方雅藏";
  titleInput.addEventListener("input", () => {
    module.copy = module.copy || { title: "", subtitle: "", bodyLines: [] };
    module.copy.title = titleInput.value;
    scheduleSave();
  });
  titleField.append(titleLabel, titleInput);

  const subtitleField = document.createElement("label");
  subtitleField.className = "field";
  const subtitleLabel = document.createElement("span");
  subtitleLabel.textContent = "副标题 / 英文";
  const subtitleInput = document.createElement("input");
  subtitleInput.type = "text";
  subtitleInput.value = module.copy?.subtitle || "";
  subtitleInput.placeholder = "例：NATURAL · POISE";
  subtitleInput.addEventListener("input", () => {
    module.copy = module.copy || { title: "", subtitle: "", bodyLines: [] };
    module.copy.subtitle = subtitleInput.value;
    scheduleSave();
  });
  subtitleField.append(subtitleLabel, subtitleInput);

  copyRow.append(titleField, subtitleField);

  const bodyField = document.createElement("label");
  bodyField.className = "field";
  const bodyLabel = document.createElement("span");
  bodyLabel.textContent = "正文 / 卖点（每行一条，会逐字渲染）";
  const bodyInput = document.createElement("textarea");
  bodyInput.rows = 2;
  bodyInput.value = (module.copy?.bodyLines || []).join("\n");
  bodyInput.placeholder = "例：瑞兽造型\n吞金纳财";
  bodyInput.addEventListener("input", () => {
    module.copy = module.copy || { title: "", subtitle: "", bodyLines: [] };
    module.copy.bodyLines = bodyInput.value.split("\n").map((line) => line.trim()).filter(Boolean);
    scheduleSave();
  });
  bodyField.append(bodyLabel, bodyInput);

  const sceneField = document.createElement("div");
  sceneField.className = "field scene-field";
  const sceneHead = document.createElement("div");
  sceneHead.className = "scene-head";
  const sceneLabel = document.createElement("span");
  sceneLabel.textContent = "背景场景（本图专属，不与其他模块共用）";
  const sceneButton = document.createElement("button");
  sceneButton.type = "button";
  sceneButton.className = "link-btn";
  sceneButton.textContent = state.refBusy.has(module.id)
    ? "生成中…"
    : module.referenceImage
      ? "从参考图提取"
      : "生成背景建议";
  sceneButton.dataset.act = "scene-extract";
  sceneButton.disabled = state.refBusy.has(module.id);
  sceneHead.append(sceneLabel, sceneButton);
  const sceneInput = document.createElement("textarea");
  sceneInput.rows = 2;
  sceneInput.value = module.scene || "";
  sceneInput.placeholder = "留空则直接按参考图的背景生成；也可以手写：米白灰泥墙、胡桃木台面、右侧一枝干枯南天竹、柔光自左上进入";
  sceneInput.addEventListener("input", () => {
    module.scene = sceneInput.value;
    scheduleSave();
  });
  sceneField.append(sceneHead, sceneInput);

  const promptDetails = document.createElement("details");
  promptDetails.className = "prompt-details";
  if (!module.result) promptDetails.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "模块提示词";
  const promptInput = document.createElement("textarea");
  promptInput.value = module.prompt || "";
  promptInput.placeholder = "描述这个模块的画面、构图、镜头和留白位置";
  promptInput.addEventListener("input", () => {
    module.prompt = promptInput.value;
    scheduleSave();
  });
  promptDetails.append(summary, promptInput);

  fields.append(refRow, copyRow, bodyField, sceneField, promptDetails);

  if (module.error) {
    const error = document.createElement("div");
    error.className = "module-error";
    error.textContent = `上次生成失败：${errorText(module.error)}`;
    fields.appendChild(error);
  }

  body.append(visual, fields);
  card.append(head, body);

  card.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    if (act === "gen") generateModule(module.id);
    if (act === "toggle") {
      if (state.expanded.has(module.id)) state.expanded.delete(module.id);
      else state.expanded.add(module.id);
      renderModules();
    }
    if (act === "cancel") cancelModule(module.id);
    if (act === "delete") deleteModule(module.id);
    if (act === "library") saveModuleToLibrary(module);
    if (act === "download") downloadModule(module);
    if (act === "ref-upload") {
      state.refTargetId = module.id;
      await pickInto("module-ref-input", uploadModuleRef, { multiple: false, title: "选择模块参考图" });
    }
    if (act === "ref-prompt") analyzeModuleRef(module.id);
    if (act === "scene-extract") extractModuleScene(module.id);
    if (act === "ref-clear") {
      const ok = await confirmDialog("移除这个模块的参考图？提示词会保留。", {
        title: "移除参考图",
        okText: "移除"
      });
      if (!ok) return;
      module.referenceImage = "";
      state.needsAnalyze.delete(module.id);
      renderModules();
      scheduleSave(200);
    }
  });

  return card;
}

function renderModules() {
  const list = el("module-list");
  list.innerHTML = "";
  const modules = state.project?.modules || [];
  modules.forEach((module, index) => list.appendChild(moduleCard(module, index)));
  const hasProduct = Boolean(state.project?.productImages?.length);
  el("empty-hint").hidden = hasProduct || !modules.length ? true : false;
  el("project-title").textContent = state.project?.name || "未命名产品";
  el("toggle-all").textContent = modules.some((module) => state.expanded.has(module.id)) ? "全部收起" : "全部展开";
  renderPreview();
}

async function fillAllScenes() {
  const modules = state.project?.modules || [];
  const pending = modules.filter((module) => !(module.scene || "").trim());
  if (!pending.length) {
    toast("每个模块都已有自己的背景场景了");
    return;
  }
  const ok = await confirmDialog(
    `为 ${pending.length} 个还没有背景场景的模块逐个生成？有参考图的按参考图提取，没有参考图的按当前风格给一套不重复的布景。`,
    { title: "补齐背景场景", okText: "开始" }
  );
  if (!ok) return;

  const button = el("fill-scenes");
  button.disabled = true;
  let done = 0;
  for (const [index, module] of pending.entries()) {
    button.textContent = `补齐中 ${index + 1}/${pending.length}`;
    try {
      const data = await api("/api/analyze-scene", {
        method: "POST",
        body: module.referenceImage
          ? { image: module.referenceImage }
          : { projectId: state.project.id, moduleId: module.id }
      });
      if (data.scene) {
        module.scene = data.scene;
        done += 1;
        renderModules();
      }
    } catch (error) {
      toast(`${module.name}：${errorText(error.code)}`, 3600);
    }
  }
  button.disabled = false;
  button.textContent = "补齐背景场景";
  if (state.dirty) await saveProject();
  renderModules();
  toast(done ? `已为 ${done} 个模块设定专属背景` : "没能生成背景场景", done ? 2600 : 3600);
}

function toggleAllModules() {
  const modules = state.project?.modules || [];
  const anyExpanded = modules.some((module) => state.expanded.has(module.id));
  if (anyExpanded) state.expanded.clear();
  else modules.forEach((module) => state.expanded.add(module.id));
  renderModules();
}

function renderPreview() {
  const preview = el("preview");
  const done = (state.project?.modules || []).filter((module) => module.result?.image);
  el("preview-count").textContent = `${done.length} 张`;
  const badge = el("preview-toggle-count");
  if (badge) badge.textContent = done.length ? String(done.length) : "";
  preview.innerHTML = "";
  if (!done.length) {
    const empty = document.createElement("div");
    empty.className = "preview-empty";
    empty.textContent = "生成的模块会按顺序拼接在这里";
    preview.appendChild(empty);
    return;
  }
  done.forEach((module) => {
    const image = document.createElement("img");
    image.src = module.result.image;
    image.alt = module.name;
    image.title = `${module.name} · 点击放大`;
    image.dataset.zoomLabel = module.name;
    preview.appendChild(image);
  });
}

function downloadModule(module) {
  if (!module.result?.image) return;
  const safeName = (state.project?.name || "详情图").replace(/[\\/:*?"<>|]/g, "_");
  download(dataUrlToBlob(module.result.image), `${safeName}-${module.name}.png`);
}

async function saveModuleToLibrary(module) {
  try {
    const library = await api("/api/library");
    const modules = library.modules.filter((item) => item.name !== module.name);
    modules.push({
      id: `lib-${Date.now()}`,
      name: module.name,
      ratio: module.ratio,
      quality: module.quality,
      renderText: module.renderText,
      prompt: module.prompt,
      copy: module.copy
    });
    await api("/api/library", { method: "PUT", body: { modules } });
    toast("已存入模板库，下次新建产品会带上这个模块");
  } catch (error) {
    toast(`保存模板失败：${errorText(error.code)}`);
  }
}

/* ------------------------------- generation ------------------------------- */

async function generateModule(moduleId) {
  if (!state.project) return false;
  if (!licenseUsable()) {
    toast(errorText(state.license?.state === "expired" ? "license_expired" : "license_invalid"), 4800);
    openLicenseDialog();
    return false;
  }
  if (!state.project.productImages?.length) {
    toast("先上传产品图");
    return false;
  }
  if (state.busy.has(moduleId)) return false;

  const module = state.project.modules.find((item) => item.id === moduleId);
  if (!module) return false;
  if (!module.prompt || module.prompt.trim().length < 8) {
    toast(`${module.name}：还没有提示词，先上传参考图自动生成，或手写一句`, 4200);
    return false;
  }

  // 产品特征必须在标记为“生成中”之前解析并落盘，
  // 否则 saveProject 会因为 busy 非空而推迟写盘，服务端读到的就是没有产品锁的旧数据。
  await ensureProductFacts();
  if (state.dirty) await saveProject();

  const controller = new AbortController();
  state.busy.add(moduleId);
  state.busySince.set(moduleId, Date.now());
  state.controllers.set(moduleId, controller);
  renderModules();

  try {
    const data = await api("/api/generate-module", {
      method: "POST",
      body: {
        projectId: state.project.id,
        moduleId,
        product: state.project.product || null
      },
      signal: controller.signal
    });
    const index = state.project.modules.findIndex((item) => item.id === moduleId);
    if (index >= 0) state.project.modules[index] = data.module;
    if (data.anchorLocked && !state.project.style.anchorImage) {
      state.project.style.anchorImage = data.module.result?.image || "";
      state.project.style.anchorModuleId = moduleId;
    }
    return true;
  } catch (error) {
    if (error.name === "AbortError" || error.code === "generation_cancelled") {
      if (module) module.error = "";
      return false;
    }
    if (module) module.error = error.code || "generation_failed";
    toast(`${module.name}：${errorText(error.code)}`, 4200);
    return false;
  } finally {
    state.busy.delete(moduleId);
    state.busySince.delete(moduleId);
    state.controllers.delete(moduleId);
    renderStyle();
    renderModules();
  }
}

async function cancelModule(moduleId) {
  const controller = state.controllers.get(moduleId);
  try {
    await api("/api/cancel-module", { method: "POST", body: { moduleId } });
  } catch {
    // 服务端可能已经先一步结束这次请求。
  }
  if (controller) controller.abort();
  if (state.runningAll) state.cancelAll = true;
  toast("已取消这次生成");
}

async function generateAll() {
  if (state.runningAll) return;
  if (!state.project) return;
  if (!licenseUsable()) {
    toast(errorText(state.license?.state === "expired" ? "license_expired" : "license_invalid"), 4800);
    openLicenseDialog();
    return;
  }
  if (!state.project.productImages?.length) {
    toast("先上传产品图");
    return;
  }
  const pending = state.project.modules.filter(
    (module) => !module.result?.image && module.prompt && module.prompt.trim().length >= 8
  );
  const emptyPrompt = state.project.modules.filter(
    (module) => !module.result?.image && (!module.prompt || module.prompt.trim().length < 8)
  );
  if (!pending.length) {
    toast(
      emptyPrompt.length
        ? `还有 ${emptyPrompt.length} 个模块没有提示词，先补上再生成`
        : "所有模块都已经生成了，想换可以点单张「重生成」"
    );
    return;
  }

  state.runningAll = true;
  state.cancelAll = false;
  el("gen-all").disabled = true;
  el("gen-all").textContent = "生成中…";

  try {
    let queue = [...pending];
    if (!state.project.style.anchorImage && queue.length) {
      const first = queue.shift();
      await generateModule(first.id);
    }
    const concurrency = 2;
    while (queue.length && !state.cancelAll) {
      const batch = queue.splice(0, concurrency);
      await Promise.all(batch.map((module) => generateModule(module.id)));
    }
  } finally {
    state.runningAll = false;
    state.cancelAll = false;
    el("gen-all").disabled = false;
    el("gen-all").textContent = "生成全部模块";
    scheduleSave(400);
  }
}

/* ------------------------------- project ------------------------------- */

function renderProducts() {
  const list = el("product-list");
  list.innerHTML = "";
  (state.project?.productImages || []).forEach((image, index) => {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = image;
    img.alt = `产品图 ${index + 1}`;
    img.title = "点击放大";
    img.dataset.zoomLabel = index === 0 ? "产品图 1 · 主图" : `产品图 ${index + 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "移除";
    remove.addEventListener("click", () => {
      const wasMain = index === 0;
      state.project.productImages.splice(index, 1);
      if (wasMain && state.project.productImages.length) {
        resetAnchorForNewProduct(Boolean(state.project.style?.anchorImage));
      }
      if (!state.project.productImages.length) {
        state.project.product = null;
      }
      renderProducts();
      renderModules();
      renderProductFacts();
      scheduleSave(200);
    });
    thumb.append(img, remove);
    if (index === 0) {
      const tag = document.createElement("span");
      tag.className = "thumb-tag";
      tag.textContent = "主图";
      thumb.appendChild(tag);
    }
    list.appendChild(thumb);
  });
}

/* --------------------------- product lock --------------------------- */

function productFactsOf(project) {
  const source = project?.product && typeof project.product === "object" ? project.product : null;
  return typeof source?.productPrompt === "string" ? source.productPrompt : "";
}

function renderProductFacts() {
  const box = el("product-facts");
  const hint = el("product-lock-hint");
  if (!box) return;
  const project = state.project;
  const facts = productFactsOf(project);
  if (document.activeElement !== box) box.value = facts;
  box.disabled = !project?.productImages?.length;

  if (!project?.productImages?.length) {
    hint.textContent = "先上传产品图";
    hint.className = "product-lock-hint";
    return;
  }
  if (state.productBusy) {
    hint.textContent = "正在提取产品特征…";
    hint.className = "product-lock-hint is-busy";
    return;
  }
  if (facts) {
    hint.textContent = "已锁定 · 每张图生成时都会注入";
    hint.className = "product-lock-hint is-ok";
    return;
  }
  hint.textContent = "尚未提取，建议点「重新提取」；手写也可以";
  hint.className = "product-lock-hint is-warn";
}

let productAnalysisPromise = null;

async function analyzeProductFacts() {
  if (!state.project) return false;
  if (productAnalysisPromise) return productAnalysisPromise;
  const image = state.project.productImages?.[0];
  if (!image) {
    toast("先上传产品图");
    return false;
  }
  state.productBusy = true;
  renderProductFacts();
  productAnalysisPromise = (async () => {
    try {
      const data = await api("/api/analyze-product", { method: "POST", body: { image } });
      state.project.product = { ...(state.project.product || {}), ...data.product };
      state.productBusy = false;
      renderProductFacts();
      scheduleSave(200);
      return true;
    } catch (error) {
      state.productBusy = false;
      renderProductFacts();
      toast(`产品特征提取失败：${errorText(error.code)}`, 4200);
      return false;
    }
  })();
  try {
    return await productAnalysisPromise;
  } finally {
    productAnalysisPromise = null;
  }
}

async function ensureProductFacts() {
  if (productFactsOf(state.project)) return true;
  if (!state.project?.productImages?.length) return false;
  setSaveState("提取产品特征…", true);
  const ok = await analyzeProductFacts();
  setSaveState(ok ? "已保存" : "待保存", !ok);
  return ok;
}

function resetAnchorForNewProduct(hadAnchor) {
  if (!hadAnchor) return;
  state.project.style.anchorImage = "";
  state.project.style.anchorModuleId = "";
  renderStyle();
  toast("产品图已更换，风格锚图已重置，避免沿用上一个产品的画面", 5200);
}

function renderSamples() {
  const list = el("sample-list");
  list.innerHTML = "";
  (state.project?.sampleImages || []).forEach((image, index) => {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = image;
    img.alt = `样板图 ${index + 1}`;
    img.title = "点击放大";
    img.dataset.zoomLabel = `样板图 ${index + 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "移除";
    remove.addEventListener("click", () => {
      state.project.sampleImages.splice(index, 1);
      renderSamples();
      scheduleSave(200);
    });
    thumb.append(img, remove);
    list.appendChild(thumb);
  });
}

function renderProjects() {
  const select = el("project-select");
  select.innerHTML = "";
  state.projects.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    option.selected = state.project?.id === project.id;
    select.appendChild(option);
  });
}

async function refreshProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects;
  renderProjects();
}

async function loadProject(id) {
  const data = await api(`/api/projects/${id}`);
  state.project = data.project;
  state.project.style = state.project.style || { enabled: true, profile: null, lockText: "" };
  state.project.productImages = state.project.productImages || [];
  state.project.sampleImages = state.project.sampleImages || [];
  state.project.modules = state.project.modules || [];
  renderProducts();
  renderSamples();
  renderStyle();
  renderProductFacts();
  renderModules();
  setSaveState("已保存");
}

async function createProject(name) {
  const data = await api("/api/projects", { method: "POST", body: { name } });
  state.project = data.project;
  await refreshProjects();
  await loadProject(data.project.id);
  toast("新建完成，已按模板库带上模块");
}

/* ------------------------------- events ------------------------------- */

function bindDropzone(zoneId, inputId, handler) {
  const zone = el(zoneId);
  const input = el(inputId);
  zone.addEventListener("click", async () => {
    const files = await chooseImageFiles({ multiple: true, title: "选择图片" });
    if (files === null) {
      input.click();
      return;
    }
    if (files.length) await handler(files);
  });
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      zone.click();
    }
  });
  input.addEventListener("change", async () => {
    await handler(Array.from(input.files || []));
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((type) => zone.addEventListener(type, (event) => {
    event.preventDefault();
    zone.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((type) => zone.addEventListener(type, (event) => {
    event.preventDefault();
    zone.classList.remove("is-over");
  }));
  zone.addEventListener("drop", async (event) => {
    const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length) await handler(files);
  });
}

async function addProductImages(files) {
  if (!state.project) return;
  const room = Math.max(0, 6 - (state.project.productImages?.length || 0));
  const accepted = files.slice(0, room);
  if (!accepted.length) {
    toast("产品图最多 6 张");
    return;
  }
  setSaveState("处理图片…", true);
  const images = await Promise.all(accepted.map((file) => readImage(file)));
  const previousMain = state.project.productImages?.[0] || "";
  state.project.productImages = [...(state.project.productImages || []), ...images];
  const mainChanged = !previousMain && Boolean(state.project.productImages[0]);
  if (previousMain && state.project.productImages[0] !== previousMain) {
    resetAnchorForNewProduct(Boolean(state.project.style?.anchorImage));
  }
  renderProducts();
  renderModules();
  renderProductFacts();
  scheduleSave(200);
  if (mainChanged || !productFactsOf(state.project)) {
    await analyzeProductFacts();
  }
}

async function addSampleImages(files) {
  if (!state.project) return;
  const room = Math.max(0, 4 - (state.project.sampleImages?.length || 0));
  const accepted = files.slice(0, room);
  if (!accepted.length) {
    toast("风格样板最多 4 张");
    return;
  }
  setSaveState("处理图片…", true);
  const images = await Promise.all(accepted.map((file) => readImage(file)));
  state.project.sampleImages = [...(state.project.sampleImages || []), ...images];
  renderSamples();
  scheduleSave(200);
}

async function analyzeStyle() {
  if (!state.project?.sampleImages?.length) {
    toast("先上传 1–4 张样板图");
    return;
  }
  const button = el("analyze-style");
  button.disabled = true;
  button.textContent = "分析中…";
  try {
    const data = await api("/api/analyze-style", { method: "POST", body: { images: state.project.sampleImages } });
    state.project.style = {
      ...state.project.style,
      enabled: true,
      profile: data.profile,
      lockText: data.profile.stylePrompt || "",
      sampleCount: state.project.sampleImages.length
    };
    renderStyle();
    scheduleSave(200);
    toast("风格规范已提取，可以微调下面的锁定描述");
  } catch (error) {
    toast(errorText(error.code), 4200);
  } finally {
    button.disabled = false;
    button.textContent = "提取统一风格";
  }
}

function applyModuleDraft(module, draft) {
  if (!draft) return;
  const prompt = [draft.visualPrompt, draft.layout ? `\n\nLayout: ${draft.layout}` : ""].join("").trim();
  if (prompt) module.prompt = prompt;
  if (typeof draft.scene === "string" && draft.scene.trim()) module.scene = draft.scene.trim();
  module.copy = module.copy || { title: "", subtitle: "", bodyLines: [] };
  if (draft.title) module.copy.title = draft.title;
  if (draft.subtitle) module.copy.subtitle = draft.subtitle;
  if (Array.isArray(draft.bodyLines) && draft.bodyLines.length) module.copy.bodyLines = draft.bodyLines;
  if (typeof draft.renderText === "boolean") module.renderText = draft.renderText;
  if (draft.name && /^模块\s*\d+$/.test(module.name)) module.name = draft.name;
}

async function analyzeModuleRef(moduleId) {
  const module = state.project?.modules.find((item) => item.id === moduleId);
  if (!module?.referenceImage) {
    toast("先给这个模块上传参考图");
    return;
  }
  state.refBusy.add(moduleId);
  renderModules();
  try {
    const data = await api("/api/analyze-module", {
      method: "POST",
      body: { image: module.referenceImage, hint: module.name }
    });
    applyModuleDraft(module, data.module);
    module.error = "";
    scheduleSave(300);
    toast(`「${module.name}」的提示词已按参考图生成，可以再手动微调`);
  } catch (error) {
    toast(`分析失败：${errorText(error.code)}`, 4200);
  } finally {
    state.refBusy.delete(moduleId);
    state.needsAnalyze.delete(moduleId);
    renderModules();
  }
}

async function extractModuleScene(moduleId) {
  const module = state.project?.modules.find((item) => item.id === moduleId);
  if (!module) return;
  const fromImage = Boolean(module.referenceImage);
  state.refBusy.add(moduleId);
  renderModules();
  try {
    const data = await api("/api/analyze-scene", {
      method: "POST",
      body: fromImage
        ? { image: module.referenceImage }
        : { projectId: state.project.id, moduleId }
    });
    if (data.scene) {
      module.scene = data.scene;
      module.error = "";
      scheduleSave(300);
      toast(fromImage
        ? `「${module.name}」的背景已按参考图单独设定`
        : `「${module.name}」的背景建议已生成，可以再改`);
    } else {
      toast("没生成出背景，手写一句也可以");
    }
  } catch (error) {
    toast(`背景提取失败：${errorText(error.code)}`, 4200);
  } finally {
    state.refBusy.delete(moduleId);
    renderModules();
  }
}

async function uploadModuleRef(files) {
  const moduleId = state.refTargetId;
  const module = state.project?.modules.find((item) => item.id === moduleId);
  if (!module) {
    toast("没找到目标模块，回到列表重新点一次「上传参考图」", 3600);
    return;
  }
  if (!files?.length) return;

  let image;
  try {
    image = await readImage(files[0], 1400);
  } catch {
    toast(`「${files[0].name}」读不出来，换成 JPG / PNG 再试一次`, 4200);
    return;
  }

  module.referenceImage = image;
  module.error = "";
  state.needsAnalyze.delete(moduleId);
  renderModules();
  scheduleSave(120);

  if ((module.prompt || "").trim().length < 8) {
    await analyzeModuleRef(moduleId);
    return;
  }

  state.needsAnalyze.add(moduleId);
  renderModules();
  toast(`「${module.name}」的参考图已替换。要按新图重写提示词和文案，点这个模块里的「按参考图生成提示词」`, 4800);
}

const MODULE_HINTS = [
  { file: /首屏|主图|封面|hero|cover|banner/i, name: /首屏|主图|封面/i, index: 0 },
  { file: /卖点|核心|图标|feature|selling|benefit/i, name: /卖点|核心/i, index: 1 },
  { file: /细节|特写|工艺|detail|macro|craft/i, name: /细节|特写|工艺/i, index: 2 },
  { file: /场景|实拍|搭配|lifestyle|scene|room|home/i, name: /场景|实拍/i, index: 3 },
  { file: /尺寸|参数|规格|size|dimension|spec/i, name: /尺寸|参数|规格/i, index: 4 },
  { file: /包装|服务|保障|评价|package|service|review/i, name: /包装|服务|保障|评价/i, index: 5 },
  { file: /颜色|款式|配色|color|colour|variant|sku/i, name: /颜色|款式/i, index: 6 },
  { file: /收尾|结尾|氛围|closing|ending|final/i, name: /收尾|结尾|氛围/i, index: 7 }
];

function matchModuleForFile(filename, modules, taken) {
  const base = filename.replace(/\.[a-z0-9]+$/i, "");
  const leading = base.match(/^\s*(\d{1,2})\s*[-_.、· ]/);
  if (leading) {
    const index = Number(leading[1]) - 1;
    const module = modules[index];
    if (module && !taken.has(module.id)) return module.id;
  }
  for (const hint of MODULE_HINTS) {
    if (!hint.file.test(base)) continue;
    const byName = modules.find((module) => hint.name.test(module.name) && !taken.has(module.id));
    if (byName) return byName.id;
    const byIndex = modules[hint.index];
    if (byIndex && !taken.has(byIndex.id)) return byIndex.id;
  }
  return "";
}

function renderBatchDialog() {
  const { images, matches } = state.batch;
  const list = el("batch-list");
  list.innerHTML = "";
  let matched = 0;

  images.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "batch-row";
    row.dataset.index = String(index);
    if (!matches[index]) row.classList.add("is-empty");

    const thumb = document.createElement("img");
    thumb.src = item.image;
    thumb.alt = item.name;
    row.appendChild(thumb);

    const name = document.createElement("span");
    name.className = "batch-name";
    name.textContent = item.name;
    name.title = item.name;
    row.appendChild(name);

    const select = document.createElement("select");
    select.setAttribute("aria-label", `${item.name} 对应模块`);
    const skip = document.createElement("option");
    skip.value = "";
    skip.textContent = "跳过这张";
    select.appendChild(skip);
    state.project.modules.forEach((module) => {
      const option = document.createElement("option");
      option.value = module.id;
      option.textContent = module.name;
      option.selected = matches[index] === module.id;
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      row.classList.toggle("is-empty", !select.value);
    });
    row.appendChild(select);

    if (matches[index]) matched += 1;
    list.appendChild(row);
  });

  const unmatched = images.length - matched;
  el("batch-summary").textContent = unmatched
    ? `共 ${images.length} 张，自动对位 ${matched} 张，还有 ${unmatched} 张需要手动选（不选则跳过）。`
    : `共 ${images.length} 张，全部自动对位成功，确认后开始逐个分析。`;
}

async function batchImport(files) {
  if (!state.project) return;
  if (!state.project.modules.length) {
    toast("先建一个产品");
    return;
  }
  toast(`正在读取 ${files.length} 张图…`);
  const images = [];
  for (const file of files) {
    try {
      images.push({ name: file.name, image: await readImage(file, 1400) });
    } catch {
      // 跳过读不出来的文件
    }
  }
  if (!images.length) {
    toast("没有可用的图片");
    return;
  }
  const taken = new Set();
  const matches = images.map((item) => {
    const id = matchModuleForFile(item.name, state.project.modules, taken);
    if (id) taken.add(id);
    return id;
  });
  state.batch = { images, matches };
  renderBatchDialog();
  el("batch-dialog").showModal();
}

async function runBatch(assignments) {
  const queue = assignments.filter((item) => item.moduleId);
  if (!queue.length) {
    toast("没有需要处理的图片");
    return;
  }
  toast(`开始分析 ${queue.length} 张参考图，每张约 30–60 秒，可以先去忙别的`);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const item = queue[cursor];
      cursor += 1;
      const module = state.project.modules.find((entry) => entry.id === item.moduleId);
      if (!module) continue;
      module.referenceImage = item.image;
      await analyzeModuleRef(module.id);
    }
  };
  await Promise.all([worker(), worker()]);
  scheduleSave(300);
  toast(`批量完成：${queue.length} 个模块的提示词已按参考图更新`);
}

async function analyzeModule(files) {
  const file = files[0];
  if (!file) return;
  const button = el("analyze-module-btn");
  button.disabled = true;
  button.textContent = "分析中…";
  try {
    const image = await readImage(file, 1400);
    const data = await api("/api/analyze-module", { method: "POST", body: { image } });
    const draft = data.module;
    const newModule = {
      id: `m-${Date.now()}`,
      name: draft.name || `模块 ${state.project.modules.length + 1}`,
      ratio: "1:1",
      quality: "high",
      renderText: draft.renderText !== false,
      prompt: [draft.visualPrompt, draft.layout ? `\nLayout: ${draft.layout}` : ""].join("").trim(),
      copy: { title: draft.title || "", subtitle: draft.subtitle || "", bodyLines: draft.bodyLines || [] },
      referenceImage: image,
      result: null,
      error: "",
      updatedAt: ""
    };
    state.project.modules.push(newModule);
    state.expanded.add(newModule.id);
    renderModules();
    scheduleSave(300);
    toast("已新增模块，提示词和文案都提取出来了");
  } catch (error) {
    toast(errorText(error.code), 4200);
  } finally {
    button.disabled = false;
    button.textContent = "从样板图新增模块";
  }
}

function deleteModule(moduleId) {
  const module = state.project.modules.find((item) => item.id === moduleId);
  if (!module) return;
  confirmDialog(`删除「${module.name}」？这个模块的提示词和已生成的图都会一起删掉。`, {
    title: "删除模块",
    okText: "删除"
  }).then((ok) => {
    if (!ok) return;
    state.project.modules = state.project.modules.filter((item) => item.id !== moduleId);
    state.expanded.delete(moduleId);
    state.needsAnalyze.delete(moduleId);
    renderModules();
    scheduleSave(200);
  });
}

function addBlankModule() {
  if (!state.project) return;
  const newModule = {
    id: `m-${Date.now()}`,
    name: `模块 ${state.project.modules.length + 1}`,
    ratio: "1:1",
    quality: "high",
    renderText: true,
    prompt: "",
    copy: { title: "", subtitle: "", bodyLines: [] },
    referenceImage: "",
    result: null,
    error: "",
    updatedAt: ""
  };
  state.project.modules.push(newModule);
  state.expanded.add(newModule.id);
  renderModules();
  scheduleSave(300);
  const list = el("module-list");
  list.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function exportLong() {
  const done = (state.project?.modules || []).filter((module) => module.result?.image);
  if (!done.length) {
    toast("还没有生成任何模块");
    return;
  }
  const button = el("export-long");
  button.disabled = true;
  button.textContent = "拼接中…";
  try {
    const width = 1080;
    const loaded = await Promise.all(done.map((module) => loadImage(module.result.image)));
    const scaled = loaded.map((image) => ({
      image,
      height: Math.round((image.height / image.width) * width)
    }));
    const totalHeight = scaled.reduce((sum, item) => sum + item.height, 0);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = totalHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, totalHeight);
    let offset = 0;
    scaled.forEach((item) => {
      context.drawImage(item.image, 0, offset, width, item.height);
      offset += item.height;
    });
    const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, "image/png"));
    const safeName = (state.project.name || "详情图").replace(/[\\/:*?"<>|]/g, "_");
    download(blob, `${safeName}-详情长图.png`);
    toast(`已导出，共 ${done.length} 个模块`);
  } catch {
    toast("拼接失败，可能是图片太大");
  } finally {
    button.disabled = false;
    button.textContent = "导出整张长图";
  }
}

function exportProjectJson() {
  if (!state.project) return;
  const safeName = (state.project.name || "详情图").replace(/[\\/:*?"<>|]/g, "_");
  download(new Blob([JSON.stringify(state.project, null, 2)], { type: "application/json" }), `${safeName}-项目.json`);
}

function bindPanelToggles() {
  qsa(document, ".panel[data-panel]").forEach((panel) => {
    const button = panel.querySelector(".panel-toggle");
    if (!button) return;
    button.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("is-collapsed");
      button.textContent = collapsed ? "▶" : "▼";
      button.setAttribute("aria-label", collapsed ? "展开面板" : "折叠面板");
    });
  });
}

/* --------------------------- lightbox / preview drawer --------------------------- */

const ZOOM_SELECTOR = ".preview img, .module-visual img, .thumb-grid img, .module-ref img, .anchor-row img";

function openLightbox(image) {
  const dialog = el("lightbox");
  const target = el("lightbox-image");
  target.src = image.currentSrc || image.src;
  target.alt = image.alt || "";
  el("lightbox-caption").textContent = image.dataset.zoomLabel || image.alt || "";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeLightbox() {
  const dialog = el("lightbox");
  if (dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function bindLightbox() {
  document.addEventListener("click", (event) => {
    const image = event.target.closest?.(ZOOM_SELECTOR);
    if (!image) return;
    if (image.dataset.act) return; // 收起态的模块小缩略图有自己的点开行为
    event.preventDefault();
    openLightbox(image);
  });
  el("lightbox-close").addEventListener("click", closeLightbox);
  el("lightbox-image").addEventListener("click", closeLightbox);
  const dialog = el("lightbox");
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.classList.contains("lightbox-stage")) closeLightbox();
  });
}

function setPreviewDrawer(open) {
  const column = document.querySelector(".col-right");
  if (!column) return;
  column.classList.toggle("is-open", open);
  el("drawer-scrim").hidden = !open;
  const toggle = el("toggle-preview");
  toggle.classList.toggle("is-active", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function bindPreviewDrawer() {
  el("toggle-preview").addEventListener("click", () => {
    const column = document.querySelector(".col-right");
    setPreviewDrawer(!column.classList.contains("is-open"));
  });
  el("drawer-scrim").addEventListener("click", () => setPreviewDrawer(false));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const dialog = el("lightbox");
    if (dialog.open) closeLightbox();
    else setPreviewDrawer(false);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 1360) setPreviewDrawer(false);
  });
}

function bindEvents() {
  bindPanelToggles();
  bindLightbox();
  bindPreviewDrawer();
  bindDropzone("drop-product", "product-input", addProductImages);
  bindDropzone("drop-sample", "sample-input", addSampleImages);

  el("analyze-style").addEventListener("click", analyzeStyle);
  el("product-analyze").addEventListener("click", analyzeProductFacts);
  el("product-facts").addEventListener("input", () => {
    const value = el("product-facts").value;
    state.project.product = { ...(state.project.product || {}), productPrompt: value };
    el("product-lock-hint").textContent = value.trim() ? "已锁定 · 每张图生成时都会注入" : "尚未提取，建议点「重新提取」；手写也可以";
    el("product-lock-hint").className = value.trim() ? "product-lock-hint is-ok" : "product-lock-hint is-warn";
    scheduleSave(600);
  });
  el("gen-all").addEventListener("click", generateAll);
  el("toggle-all").addEventListener("click", toggleAllModules);
  el("add-module").addEventListener("click", addBlankModule);
  el("export-long").addEventListener("click", exportLong);
  el("export-project").addEventListener("click", exportProjectJson);

  el("analyze-module-btn").addEventListener("click", () =>
    pickInto("module-sample-input", analyzeModule, { multiple: false, title: "选择要分析的详情图" }));
  el("module-sample-input").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length) await analyzeModule(files);
  });

  el("module-ref-input").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length) await uploadModuleRef(files);
  });

  el("batch-import").addEventListener("click", () =>
    pickInto("batch-input", batchImport, { multiple: true, title: "批量选择参考图" }));
  el("fill-scenes").addEventListener("click", fillAllScenes);
  el("batch-input").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length) await batchImport(files);
  });
  el("batch-dialog").addEventListener("close", async () => {
    const dialog = el("batch-dialog");
    if (dialog.returnValue !== "save") {
      state.batch = null;
      return;
    }
    const rows = qsa(el("batch-list"), ".batch-row");
    const assignments = rows.map((row) => {
      const index = Number(row.dataset.index);
      const select = row.querySelector("select");
      return {
        moduleId: select?.value || "",
        image: state.batch?.images[index]?.image || ""
      };
    });
    state.batch = null;
    await runBatch(assignments);
  });

  el("style-enabled").addEventListener("change", (event) => {
    state.project.style.enabled = event.target.checked;
    scheduleSave(200);
  });

  el("lock-text").addEventListener("input", (event) => {
    state.project.style.lockText = event.target.value;
    scheduleSave();
  });

  el("clear-anchor").addEventListener("click", () => {
    state.project.style.anchorImage = "";
    state.project.style.anchorModuleId = "";
    renderStyle();
    scheduleSave(200);
    toast("已解除锚图，下一张生成的图会成为新锚图");
  });

  el("project-select").addEventListener("change", async (event) => {
    if (!event.target.value) return;
    await loadProject(event.target.value);
  });

  el("new-project").addEventListener("click", () => {
    el("name-input").value = "";
    el("name-dialog").showModal();
  });

  el("name-dialog").addEventListener("close", async () => {
    const dialog = el("name-dialog");
    if (dialog.returnValue !== "save") return;
    const name = el("name-input").value.trim();
    if (!name) {
      toast("给产品起个名字");
      return;
    }
    await createProject(name);
  });

  el("name-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el("name-dialog").close("save");
    }
  });

  el("license-btn").addEventListener("click", () => {
    refreshLicense().finally(openLicenseDialog);
  });
  el("copy-machine").addEventListener("click", copyMachineCode);
  el("license-activate").addEventListener("click", activateLicense);
  el("license-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) activateLicense();
  });

  el("key-btn").addEventListener("click", async () => {
    el("key-input").value = "";
    el("key-dialog").showModal();
    let data = {};
    try {
      data = await api("/api/config");
    } catch (error) {
      el("key-state").textContent = errorText(error.code);
      return;
    }
    el("key-state").className = "dialog-state";
    el("key-state").textContent = data.apiKeyConfigured
      ? `当前 Key：${data.apiKeySource === "environment" ? "来自环境变量" : "已填写"}`
      : "当前 Key：未配置";
    const baseInput = el("base-input");
    baseInput.value = data.baseUrl || "";
    baseInput.placeholder = data.defaultBaseUrl || "https://api.apikey.fan/v1";
  });

  el("key-test").addEventListener("click", async () => {
    const button = el("key-test");
    const stateNode = el("key-state");
    const setState = (text, tone) => {
      stateNode.textContent = text;
      stateNode.className = `dialog-state${tone ? ` is-${tone}` : ""}`;
    };
    button.disabled = true;
    setState("正在测试连接…", "warn");
    try {
      const result = await api("/api/config/probe", {
        method: "POST",
        body: { baseUrl: el("base-input").value.trim() }
      });
      if (result.verdict === "ok" && result.imageModelAvailable === false) {
        setState(`已连通，但模型列表里没有 ${result.imageModel}，出图可能失败`, "warn");
      } else if (result.verdict === "ok") {
        setState(`连接正常，网关可用模型 ${result.modelCount} 个`, "ok");
      } else if (result.verdict === "auth") {
        setState(`网关拒绝了这个 Key（HTTP ${result.status}）`, "error");
      } else if (result.verdict === "unreachable") {
        setState("连不上这个 BaseURL，检查地址或网络代理", "error");
      } else {
        setState(`网关返回 HTTP ${result.status}，若出图正常可忽略`, "warn");
      }
    } catch (error) {
      setState(errorText(error.code), "error");
    } finally {
      button.disabled = false;
    }
  });

  el("key-dialog").addEventListener("close", async () => {
    const dialog = el("key-dialog");
    if (dialog.returnValue !== "save") return;
    const apiKey = el("key-input").value.trim();
    const body = { baseUrl: el("base-input").value.trim() };
    if (apiKey) body.apiKey = apiKey;
    try {
      const result = await api("/api/config", { method: "POST", body });
      toast(apiKey
        ? `设置已保存，BaseURL：${result.baseUrl}`
        : `BaseURL 已保存：${result.baseUrl}`);
    } catch (error) {
      toast(errorText(error.code));
    }
  });
}

/* ------------------------------- boot ------------------------------- */

async function boot() {
  bindEvents();
  // 桌面版必须能拿到预加载桥接，拿不到就说明上传会退回浏览器那套、容易不弹窗，先提示出来
  if (/Electron/.test(navigator.userAgent) && !desktopBridge()) {
    setTimeout(() => toast("桌面组件没加载成功，上传会退回系统默认选择框，可能不弹窗。可在数据目录下的 startup.log 查看原因", 9000), 1200);
  }
  try {
    const health = await api("/api/health");
    if (health.license) {
      state.license = health.license;
      renderLicense();
      if (!licenseUsable()) {
        setTimeout(() => toast(errorText(health.license.state === "expired" ? "license_expired" : "license_invalid"), 6000), 900);
      }
    }
    if (!health.apiKeyConfigured) {
      setTimeout(() => toast("还没配置 API Key，点右上角「API 设置」", 5000), 800);
    }
  } catch {
    toast("本地服务未响应");
  }

  try {
    await refreshProjects();
    if (!state.projects.length) {
      await createProject("未命名产品");
    } else {
      await loadProject(state.projects[0].id);
    }
  } catch (error) {
    toast(`初始化失败：${errorText(error.code)}`);
  }
}

boot();
