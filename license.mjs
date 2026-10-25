/**
 * 离线授权：机器码 + Ed25519 签名的许可证。
 *
 * 设计取舍：
 * - 不联网、不依赖服务器，适合单机分发给客户。校验完全在本地完成。
 * - 私钥只存在 `tools/license-private.pem`，**不会**被打进 exe；exe 内只有公钥。
 * - 许可证绑定机器码，换机器需要重新发码；有效期写到具体日期。
 * - 防系统时间回拨：把「上次运行时间」记在本地，判定时取 max(now, lastSeen)。
 */

import { createPublicKey, createHash, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

/** 与 tools/license-private.pem 配对的公钥。换密钥对时必须同步替换。 */
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA4+Jl55jEbNP3JQEFYtZuB0pnTSMaOYldGb61LmIPknk=
-----END PUBLIC KEY-----`;

const CODE_VERSION = "DS1";
const DEFAULT_TRIAL_DAYS = 14;
const CLOCK_BACK_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/**
 * 机器指纹只用 Node 自带能力取（网卡 MAC + 主机名），不调 reg.exe / wmic / PowerShell。
 * 原因：外部命令在不同机器、不同安全策略下可能被拦截，一旦取不到就会退化成随机值，
 * 同一台机器算出的机器码会变，激活码当场失效。纯 Node 取法在开发环境和打包后完全一致。
 */
const VIRTUAL_IFACE = /(vmware|virtualbox|vbox|hyper-?v|vethernet|tap|tun|docker|wsl|bridge|loopback|zerotier|tailscale|radmin|clash|mihomo|v2ray|xray|openvpn|wireguard)/i;

/**
 * macOS 专用：取主板/整机 UUID。
 * 不用网卡 MAC 的原因：macOS 会给每个 Wi-Fi 开「私有地址」，换一个网络 MAC 就变，
 * 拿它当指纹会出现「换个地方连 Wi-Fi 就提示机器码不匹配」。IOPlatformUUID 跟硬件走，稳定。
 */
function darwinHardwareUuid() {
  try {
    const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const matched = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return matched ? matched[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function collectSeeds() {
  // macOS 有可靠的硬件 UUID 时优先用它，避免受网卡地址变化影响
  if (process.platform === "darwin") {
    const uuid = darwinHardwareUuid();
    if (uuid) return [uuid, String(os.hostname() || "").toLowerCase(), process.platform];
  }

  const seeds = [];
  const macs = [];
  const interfaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (item.internal) continue;
      const mac = String(item.mac || "").toLowerCase();
      if (!mac || mac === "00:00:00:00:00:00") continue;
      macs.push({ name, mac });
    }
  }
  // 物理网卡优先，同一优先级按网卡名排序，保证结果稳定
  macs.sort((a, b) => {
    const av = VIRTUAL_IFACE.test(a.name) ? 1 : 0;
    const bv = VIRTUAL_IFACE.test(b.name) ? 1 : 0;
    if (av !== bv) return av - bv;
    return a.name.localeCompare(b.name);
  });
  if (macs.length) seeds.push(macs[0].mac);

  seeds.push(String(os.hostname() || "").toLowerCase());
  seeds.push(String(os.platform() || ""));
  return seeds.filter(Boolean);
}

function formatMachineCode(raw) {
  const hex = createHash("sha256").update(raw).digest("hex").slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g).join("-");
}

function parseCode(code) {
  const text = String(code || "").trim().replace(/\s+/g, "");
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== CODE_VERSION) return { error: "license_malformed" };
  let payload;
  let signature;
  try {
    payload = Buffer.from(parts[1], "base64url");
    signature = Buffer.from(parts[2], "base64url");
  } catch {
    return { error: "license_malformed" };
  }
  if (!payload.length || signature.length !== 64) return { error: "license_malformed" };
  let ok = false;
  try {
    ok = verify(null, payload, createPublicKey(LICENSE_PUBLIC_KEY), signature);
  } catch {
    ok = false;
  }
  if (!ok) return { error: "license_signature_invalid" };
  try {
    return { data: JSON.parse(payload.toString("utf8")) };
  } catch {
    return { error: "license_malformed" };
  }
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function daysBetween(later, earlier) {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / 86400000);
}

export function createLicenseManager(options = {}) {
  const dataDir = options.dataDir;
  const file = join(dataDir, "license.json");
  const trialDays = Number.isFinite(options.trialDays)
    ? options.trialDays
    : Number(process.env.DETAIL_STUDIO_TRIAL_DAYS) || DEFAULT_TRIAL_DAYS;

  let record = null;
  let machineCode = "";
  let snapshot = null;
  let readyPromise = null;
  let lastPersistAt = 0;

  async function loadRecord() {
    if (record) return record;
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      parsed = null;
    }
    const now = new Date().toISOString();
    record = {
      machineCode: typeof parsed?.machineCode === "string" ? parsed.machineCode : "",
      code: typeof parsed?.code === "string" ? parsed.code : "",
      firstRunAt: typeof parsed?.firstRunAt === "string" ? parsed.firstRunAt : now,
      lastSeenAt: typeof parsed?.lastSeenAt === "string" ? parsed.lastSeenAt : now
    };
    return record;
  }

  async function persist(force = false) {
    const now = Date.now();
    // lastSeen 每分钟最多写一次，避免每次查询都写盘；激活这类关键写入强制落盘
    if (!force && now - lastPersistAt < 60000) return;
    lastPersistAt = now;
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, JSON.stringify(record, null, 2), "utf8");
    } catch {
      /* 落盘失败不影响运行，只是下次重算 */
    }
  }

  async function ensureMachineCode() {
    if (machineCode) return machineCode;
    const current = await loadRecord();
    if (current.machineCode && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(current.machineCode)) {
      machineCode = current.machineCode;
      return machineCode;
    }
    const seeds = collectSeeds();
    machineCode = formatMachineCode(seeds.join("|") || "no-seed");
    current.machineCode = machineCode;
    await persist(true);
    return machineCode;
  }

  function evaluate() {
    const now = new Date();
    const lastSeen = record.lastSeenAt ? new Date(record.lastSeenAt) : now;
    const clockBack = now.getTime() < lastSeen.getTime() - CLOCK_BACK_TOLERANCE_MS;
    const effectiveNow = clockBack ? lastSeen : now;

    const base = {
      machineCode,
      today: effectiveNow.toISOString().slice(0, 10),
      trialDays,
      clockWarned: clockBack
    };

    if (record.code) {
      const parsed = parseCode(record.code);
      if (parsed.error) {
        return { ...base, state: "invalid", message: "激活码校验失败", daysLeft: 0 };
      }
      const { data } = parsed;
      if (data.m && data.m !== "ANY" && data.m !== machineCode) {
        return { ...base, state: "invalid", message: "这个激活码是给另一台电脑的", daysLeft: 0, customer: data.n || "" };
      }
      const expiresAt = new Date(`${data.e}T23:59:59`);
      if (Number.isNaN(expiresAt.getTime())) {
        return { ...base, state: "invalid", message: "激活码里的有效期格式不对", daysLeft: 0 };
      }
      const daysLeft = daysBetween(expiresAt, effectiveNow);
      const shared = {
        ...base,
        customer: data.n || "",
        expiresAt: data.e,
        daysLeft: Math.max(0, daysLeft),
        boundToMachine: data.m !== "ANY"
      };
      if (daysLeft < 0) {
        return { ...shared, state: "expired", message: "授权已到期" };
      }
      return { ...shared, state: "licensed", message: daysLeft <= 14 ? `授权还剩 ${daysLeft} 天` : "已授权" };
    }

    const firstRun = record.firstRunAt ? new Date(record.firstRunAt) : effectiveNow;
    const trialEnds = new Date(firstRun.getTime() + trialDays * 86400000);
    const trialLeft = Math.max(0, daysBetween(trialEnds, effectiveNow));
    if (trialLeft <= 0) {
      return { ...base, state: "expired", message: `试用 ${trialDays} 天已结束`, daysLeft: 0, trialLeft: 0, trialEndsAt: trialEnds.toISOString().slice(0, 10) };
    }
    return {
      ...base,
      state: "trial",
      message: `试用中，还剩 ${trialLeft} 天`,
      daysLeft: trialLeft,
      trialLeft,
      trialEndsAt: trialEnds.toISOString().slice(0, 10)
    };
  }

  async function refresh() {
    const current = await loadRecord();
    const now = new Date();
    const lastSeen = current.lastSeenAt ? new Date(current.lastSeenAt) : now;
    // 只前进不后退，避免把时间调回去就能延长
    if (now.getTime() > lastSeen.getTime()) current.lastSeenAt = now.toISOString();
    snapshot = evaluate();
    await persist();
    return snapshot;
  }

  return {
    async ready() {
      if (!readyPromise) {
        readyPromise = (async () => {
          await ensureMachineCode();
          const result = await refresh();
          await persist(true);
          return result;
        })();
      }
      return readyPromise;
    },

    /** 每次喂状态前重新判定，激活后立刻生效，不用重启。 */
    async check() {
      await this.ready();
      return refresh();
    },

    status() {
      return snapshot || { state: "unknown", machineCode, daysLeft: 0, message: "正在检查授权" };
    },

    /** 到期、无效都算不可用；试用期内可用。 */
    isUsable() {
      const state = (snapshot || {}).state;
      return state === "licensed" || state === "trial";
    },

    async activate(code) {
      await ensureMachineCode();
      const parsed = parseCode(code);
      if (parsed.error) return { ok: false, error: parsed.error };
      const data = parsed.data;
      if (data.m && data.m !== "ANY" && data.m !== machineCode) {
        return { ok: false, error: "license_machine_mismatch" };
      }
      const expiresAt = new Date(`${data.e}T23:59:59`);
      if (Number.isNaN(expiresAt.getTime())) return { ok: false, error: "license_malformed" };
      if (expiresAt.getTime() < Date.now()) return { ok: false, error: "license_already_expired" };
      const current = await loadRecord();
      current.code = String(code).trim().replace(/\s+/g, "");
      await persist(true);
      const status = await refresh();
      await persist(true);
      return { ok: true, status };
    },

    /** 供桌面壳/命令行直接读取，不经过 HTTP。 */
    async summary() {
      await this.ready();
      return this.status();
    }
  };
}

/** 发给客户的激活码里包含这些字段，方便排查。 */
export function describeCode(code) {
  const parsed = parseCode(code);
  if (parsed.error) return { ok: false, error: parsed.error };
  return { ok: true, ...parsed.data };
}
