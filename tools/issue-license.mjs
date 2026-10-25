/**
 * 发码工具 —— 只在你自己电脑上运行，不要连同 exe 一起发给客户。
 *
 * 用法一（交互式）：
 *   node tools/issue-license.mjs
 *
 * 用法二（一行命令）：
 *   node tools/issue-license.mjs --machine A1B2-C3D4-E5F6-7890 --days 365 --name 张三
 *
 * 用法三（指定到期日）：
 *   node tools/issue-license.mjs --machine A1B2-... --expires 2027-10-24 --name 张三
 *
 * 参数说明：
 *   --machine  客户的机器码（软件里「授权」弹窗可以看到，也可填 ANY 表示不绑机器）
 *   --days     从今天起多少天有效
 *   --expires  直接给到期日 YYYY-MM-DD（与 --days 二选一）
 *   --name     客户名字（写进许可证，只用于你自己分辨）
 */

import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRIVATE_KEY_FILE = join(HERE, "license-private.pem");
const CODE_VERSION = "DS1";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    out[name] = next && !next.startsWith("--") ? next : "true";
    if (out[name] !== "true") i += 1;
  }
  return out;
}

function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function normalizeMachine(input) {
  const raw = String(input || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw === "ANY") return "ANY";
  const compact = raw.replace(/[^0-9A-F]/g, "");
  if (compact.length !== 16) return "";
  return compact.match(/.{4}/g).join("-");
}

function buildCode(privateKey, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, body, privateKey);
  return `${CODE_VERSION}.${body.toString("base64url")}.${signature.toString("base64url")}`;
}

function describe(payload) {
  const rows = [
    ["绑定机器", payload.m === "ANY" ? "不限机器（任何电脑都能用）" : payload.m],
    ["客户", payload.n || "（未填）"],
    ["签发日", payload.i],
    ["到期日", payload.e]
  ];
  return rows.map(([k, v]) => `  ${k.padEnd(6, " ")} ${v}`).join("\n");
}

const args = parseArgs(process.argv.slice(2));

let privateKey;
try {
  privateKey = createPrivateKey(await readFile(PRIVATE_KEY_FILE, "utf8"));
} catch {
  console.error(`找不到私钥：${PRIVATE_KEY_FILE}`);
  console.error("私钥只在你自己电脑上，发出去的 exe 里没有它。");
  process.exit(1);
}

let machineInput = args.machine;
let daysInput = args.days;
let expiresInput = args.expires;
let nameInput = args.name;

if (!machineInput || (!daysInput && !expiresInput)) {
  console.log("=== 详情图工作台 · 发码 ===");
  console.log("机器码在软件的「授权」弹窗里，一串形如 A1B2-C3D4-E5F6-7890 的字符。\n");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    if (!machineInput) {
      machineInput = await rl.question("客户机器码（填 ANY 表示不绑机器）：");
    }
    if (!daysInput && !expiresInput) {
      const days = await rl.question("有效天数（直接回车 = 365）：");
      if (days.trim()) daysInput = days.trim();
      else daysInput = "365";
    }
    if (!nameInput) {
      nameInput = await rl.question("客户名称（可留空）：");
    }
  } finally {
    rl.close();
  }
}

const machine = normalizeMachine(machineInput);
if (!machine) {
  console.error("\n机器码格式不对：需要 16 位十六进制，可以带 - 分隔，例如 A1B2-C3D4-E5F6-7890。");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
let expires = "";
if (expiresInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(expiresInput).trim())) {
    console.error("\n到期日格式不对，应为 YYYY-MM-DD。");
    process.exit(1);
  }
  expires = String(expiresInput).trim();
} else {
  const days = Number(daysInput);
  if (!Number.isFinite(days) || days <= 0) {
    console.error("\n有效天数必须是正整数。");
    process.exit(1);
  }
  expires = addDays(days);
}

if (expires < today) {
  console.error(`\n到期日 ${expires} 早于今天 ${today}，客户拿到会直接显示已过期。`);
  process.exit(1);
}

const payload = { v: 1, m: machine, n: String(nameInput || "").trim(), i: today, e: expires };
const code = buildCode(privateKey, payload);

console.log("\n许可证信息：");
console.log(describe(payload));
console.log(`  有效天数  ${Math.round((new Date(`${expires}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000)} 天`);
console.log("\n激活码（整段复制发给客户，粘到软件「授权」弹窗里）：\n");
console.log(code);
console.log("\n提示：这段码只能用在这台机器上；换电脑要重新发一次。");
