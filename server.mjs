import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createLicenseManager } from "./license.mjs";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, "public");

/**
 * 用户数据目录。必须落在可写位置：
 * 打包后 ROOT_DIR 在 app.asar 内部，只读，写进去会直接失败。
 * - Windows：%APPDATA%\Detail Image Studio（与历史版本一致，老用户数据不丢）
 * - macOS：~/Library/Application Support/Detail Image Studio
 * - Linux：$XDG_DATA_HOME/Detail Image Studio
 */
function resolveDefaultDataDir() {
  const home = os.homedir();
  if (process.env.APPDATA) return join(process.env.APPDATA, "Detail Image Studio");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Detail Image Studio");
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "Detail Image Studio");
}

export const DEFAULT_DATA_DIR = resolveDefaultDataDir();
const DATA_DIR = process.env.DETAIL_STUDIO_DATA_DIR || DEFAULT_DATA_DIR;
const PROJECT_DIR = join(DATA_DIR, "projects");
const LIBRARY_FILE = join(DATA_DIR, "library.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

const APP_VERSION = "0.1.0";
const DEFAULT_BASE_URL = (process.env.APIKEY_IMAGE_BASE_URL?.trim() || "https://api.apikey.fan/v1").replace(/\/+$/, "");
const IMAGE_MODEL = process.env.APIKEY_IMAGE_MODEL?.trim() || "gpt-image-2.5-sunburst";
const ANALYSIS_MODEL = process.env.APIKEY_ANALYSIS_MODEL?.trim() || "gpt-5.6-sol";

const MAX_JSON_BYTES = 150 * 1024 * 1024;
const MAX_ANALYSIS_BYTES = 45 * 1024 * 1024;
const MAX_SMALL_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_GENERATION_RESPONSE_BYTES = 60 * 1024 * 1024;
const MAX_PROMPT_CHARS = 8000;

const GENERATION_SIZES = new Map([
  ["1:1", "1024x1024"],
  ["3:4", "1024x1536"],
  ["4:3", "1536x1024"],
  ["9:16", "1024x1536"],
  ["16:9", "1536x1024"]
]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const POWERSHELL_HTTP_SCRIPT = `
$ErrorActionPreference = "Stop"
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json
$requestBody = $envelope.body | ConvertTo-Json -Depth 30 -Compress
$timeoutSeconds = [int]$envelope.timeoutSeconds
if ($timeoutSeconds -le 0) { $timeoutSeconds = 120 }
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds($timeoutSeconds)
$client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $envelope.apiKey)
$content = New-Object System.Net.Http.StringContent($requestBody, $utf8, "application/json")
try {
  $response = $client.PostAsync([string]$envelope.url, $content).GetAwaiter().GetResult()
  $bodyBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  $result = @{ status = [int]$response.StatusCode; body = $utf8.GetString($bodyBytes) }
} catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  $result = @{ status = $status; body = "" }
} finally {
  $content.Dispose()
  $client.Dispose()
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`;

const POWERSHELL_HTTP_GET_SCRIPT = `
$ErrorActionPreference = "Stop"
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json
$timeoutSeconds = [int]$envelope.timeoutSeconds
if ($timeoutSeconds -le 0) { $timeoutSeconds = 12 }
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds($timeoutSeconds)
$client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $envelope.apiKey)
try {
  $response = $client.GetAsync([string]$envelope.url).GetAwaiter().GetResult()
  $bodyBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  $result = @{ status = [int]$response.StatusCode; body = $utf8.GetString($bodyBytes) }
} catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  $result = @{ status = $status; body = "" }
} finally {
  $client.Dispose()
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`;

const POWERSHELL_IMAGE_EDIT_SCRIPT = `
$ErrorActionPreference = "Stop"
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Drawing
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds([int]$envelope.timeoutSeconds)
$client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $envelope.apiKey)
$client.DefaultRequestHeaders.Accept.Add((New-Object System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("text/event-stream")))
$content = New-Object System.Net.Http.MultipartFormDataContent
$maxEdge = 1280
if ($envelope.maxImageEdge) { $maxEdge = [int]$envelope.maxImageEdge }

function Get-ImagePayload([string]$dataUrl) {
  $match = [regex]::Match($dataUrl, '^data:(image/(?:jpeg|png|webp));base64,(.+)$')
  if (-not $match.Success) { throw "invalid_image" }
  $sourceType = $match.Groups[1].Value
  $raw = [Convert]::FromBase64String($match.Groups[2].Value)
  $stream = New-Object IO.MemoryStream(, $raw)
  $image = [System.Drawing.Image]::FromStream($stream)
  $longEdge = [Math]::Max($image.Width, $image.Height)
  $scale = 1
  if ($longEdge -gt $maxEdge) { $scale = $maxEdge / $longEdge }
  $width = [int][Math]::Max(1, [Math]::Round($image.Width * $scale))
  $height = [int][Math]::Max(1, [Math]::Round($image.Height * $scale))
  $target = New-Object System.Drawing.Bitmap -ArgumentList $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawImage($image, 0, 0, $width, $height)
  $graphics.Dispose()
  $codec = $null
  foreach ($candidate in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {
    if ($candidate.MimeType -eq "image/jpeg") { $codec = $candidate }
  }
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), 88
  $out = New-Object IO.MemoryStream
  $target.Save($out, $codec, $encoderParams)
  $bytes = $out.ToArray()
  $out.Dispose()
  $target.Dispose()
  $image.Dispose()
  $stream.Dispose()
  if ($bytes.Length -ge [int]($raw.Length * 0.85)) {
    return @{ Bytes = $raw; Type = $sourceType }
  }
  return @{ Bytes = $bytes; Type = "image/jpeg" }
}

function Get-ImageFromJson([string]$jsonText) {
  if (-not $jsonText) { return "" }
  try {
    $event = $jsonText | ConvertFrom-Json
    if ($event.b64_json) { return [string]$event.b64_json }
    if ($event.data -and $event.data[0].b64_json) { return [string]$event.data[0].b64_json }
    if ($event.item -and $event.item.result) { return [string]$event.item.result }
  } catch {}
  return ""
}

try {
  foreach ($field in $envelope.fields.PSObject.Properties) {
    $content.Add((New-Object System.Net.Http.StringContent([string]$field.Value)), $field.Name)
  }

  $index = 0
  foreach ($imageData in $envelope.images) {
    $index += 1
    $payload = Get-ImagePayload $imageData
    $extension = if ($payload.Type -eq "image/jpeg") { "jpg" } elseif ($payload.Type -eq "image/webp") { "webp" } else { "png" }
    $fileContent = New-Object System.Net.Http.ByteArrayContent(,$payload.Bytes)
    $fileContent.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue($payload.Type)
    $content.Add($fileContent, "image[]", "source-$index.$extension")
  }

  $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $envelope.url)
  $request.Content = $content
  $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  $status = [int]$response.StatusCode

  if (-not $response.IsSuccessStatusCode) {
    $bodyBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $body = $utf8.GetString($bodyBytes)
    $result = @{ status = $status; body = $body; image = "" }
  } else {
    $imageResult = ""
    $mediaType = [string]$response.Content.Headers.ContentType.MediaType

    if ($mediaType -eq "application/json") {
      $bodyBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      $imageResult = Get-ImageFromJson($utf8.GetString($bodyBytes))
    } else {
      $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $reader = New-Object IO.StreamReader($stream, $utf8)
      $dataLines = New-Object System.Collections.Generic.List[string]
      $plainLines = New-Object System.Collections.Generic.List[string]

      while (-not $reader.EndOfStream -and -not $imageResult) {
        $line = $reader.ReadLine()
        if ($line -eq "") {
          $data = ($dataLines -join [Environment]::NewLine).Trim()
          $dataLines.Clear()
          if ($data -and $data -ne "[DONE]") { $imageResult = Get-ImageFromJson($data) }
        } elseif ($line.StartsWith("data:")) {
          $dataLines.Add($line.Substring(5).Trim())
        } else {
          $plainLines.Add($line)
        }
      }

      if (-not $imageResult -and $dataLines.Count -gt 0) {
        $imageResult = Get-ImageFromJson(($dataLines -join [Environment]::NewLine).Trim())
      }
      if (-not $imageResult -and $plainLines.Count -gt 0) {
        $imageResult = Get-ImageFromJson(($plainLines -join [Environment]::NewLine).Trim())
      }
      $reader.Dispose()
    }
    $result = @{ status = $status; body = ""; image = $imageResult }
  }

  [Console]::Out.Write(($result | ConvertTo-Json -Compress))
} finally {
  $content.Dispose()
  $client.Dispose()
}
`;

const STYLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    styleName: { type: "string" },
    palette: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          hex: { type: "string" },
          name: { type: "string" },
          usage: { type: "string" }
        },
        required: ["hex", "name", "usage"]
      }
    },
    background: { type: "string" },
    lighting: { type: "string" },
    props: { type: "string" },
    composition: { type: "string" },
    typography: { type: "string" },
    finish: { type: "string" },
    negative: { type: "string" },
    stylePrompt: { type: "string" }
  },
  required: [
    "styleName",
    "palette",
    "background",
    "lighting",
    "props",
    "composition",
    "typography",
    "finish",
    "negative",
    "stylePrompt"
  ]
};

const PRODUCT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    identity: { type: "string" },
    silhouette: { type: "string" },
    palette: { type: "string" },
    materials: { type: "string" },
    signature: { type: "string" },
    base: { type: "string" },
    cannotChange: { type: "array", items: { type: "string" } },
    productPrompt: { type: "string" }
  },
  required: [
    "identity",
    "silhouette",
    "palette",
    "materials",
    "signature",
    "base",
    "cannotChange",
    "productPrompt"
  ]
};

const MODULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    role: { type: "string" },
    layout: { type: "string" },
    scene: { type: "string" },
    visualPrompt: { type: "string" },
    title: { type: "string" },
    subtitle: { type: "string" },
    bodyLines: { type: "array", items: { type: "string" } },
    renderText: { type: "boolean" },
    notes: { type: "string" }
  },
  required: ["name", "role", "layout", "scene", "visualPrompt", "title", "subtitle", "bodyLines", "renderText", "notes"]
};

const SCENE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { scene: { type: "string" } },
  required: ["scene"]
};

const DEFAULT_MODULES = [
  {
    name: "01 首屏主图",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Hero module for the top of a Chinese e-commerce detail page. The product stands on a low stone or wooden pedestal in the lower centre, three-quarter front view, fully visible, occupying about 45% of the frame height. The upper 35% stays calm and empty for the brand lockup and two lines of Chinese copy. At most two quiet props at the far edges, partially cropped. Straight-on eye-level camera, 85mm equivalent, soft directional daylight from the upper left, gentle contact shadow, generous negative space, nothing cluttered."
  },
  {
    name: "02 核心卖点",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Feature module. Product at the bottom centre, about 40% of the frame height. The upper half holds a horizontal row of four rounded vertical cards of identical size and spacing, each carrying a thin single-line icon at the top, a four-character Chinese feature title and a two-line Chinese description below. Cards sit flat on this module's background with an extremely soft shadow. Symmetrical, editorial, lots of breathing room."
  },
  {
    name: "03 细节特写",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Craft detail module. Two to four tight macro crops of the product's workmanship arranged in one balanced composition or a 2x2 grid with thin gutters. Shoot at 100mm macro with raking light so carving, texture, painted and metallic accents read clearly. Thin leader lines with small Chinese labels point at each detail. Background: this module's own set, kept tight and out of focus right behind the product."
  },
  {
    name: "04 场景拼图",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Lifestyle grid module: four equal cells in a 2x2 layout, identical size and gutter. The same product appears in four different but stylistically consistent interiors; all four share the same colour temperature, the same soft daylight and the same camera height so the grid reads as one shoot. One short Chinese caption sits under each cell."
  },
  {
    name: "05 尺寸参数",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Specification module. The product stands on the left, turned slightly to reveal depth; thin dimension lines with arrows and small Chinese measurement labels mark height, width and depth. The right side holds a clean typographic block for the component list and material notes. Flat, catalogue-like lighting, no decorative props: this module gets its own plain seamless backdrop, not the backdrop of any other module."
  },
  {
    name: "06 包装服务",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Trust module. Product on a light pedestal in the upper half, optionally with the branded gift box behind it. The lower half carries a horizontal band of four thin-line service icons, each with a Chinese title and one line of small print. Warm backdrop for this module in its own set — box, pedestal surface and any cloth differ from the other modules — with the same soft shadow language, very restrained and clean."
  },
  {
    name: "07 颜色款式",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Variant module. One large hero product on the left in the primary colourway; on the right a horizontal row of three smaller colourways at equal scale, identical camera angle and identical lighting, each with a short Chinese colour name underneath. A thin vertical divider separates the hero from the variants. This module uses its own neutral set for the colour comparison, not another module's backdrop."
  },
  {
    name: "08 收尾氛围",
    ratio: "1:1",
    renderText: true,
    copy: { title: "", subtitle: "", bodyLines: [] },
    prompt: "Closing atmospheric module. Wide, quiet composition: the product small in the lower third, a large expanse of empty warm wall above with soft foliage shadow, one line of small Chinese brand copy. Mostly negative space, luxurious and calm, designed to end the page."
  }
].map((item, index) => ({
  id: `default-${index + 1}`,
  quality: "high",
  ...item
}));

let runtimeApiKey = "";
let runtimeBaseUrl = "";

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function sendJson(response, statusCode, payload) {
  applySecurityHeaders(response);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

/* ------------------------------- license ------------------------------- */

let licenseManager = null;

/** 会消耗额度的接口都要先过授权；项目和导出仍然开放，到期后数据不会锁死。 */
const LICENSED_PATHS = new Set([
  "/api/generate-module",
  "/api/analyze-style",
  "/api/analyze-module",
  "/api/analyze-product",
  "/api/analyze-scene"
]);

function requireLicense(response) {
  if (!licenseManager) return true;
  if (licenseManager.isUsable()) return true;
  const status = licenseManager.status();
  sendJson(response, 403, {
    ok: false,
    error: status.state === "expired" ? "license_expired" : "license_invalid",
    license: status
  });
  return false;
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(chunk);
    });
    request.on("end", () => {
      if (oversized) {
        rejectBody(new Error("payload_too_large"));
        return;
      }
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(new Error("invalid_json"));
      }
    });
    request.on("error", () => rejectBody(new Error("request_failed")));
  });
}

async function ensureDataDirs() {
  await mkdir(PROJECT_DIR, { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await mkdir(join(filePath, ".."), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), "utf8");
  await rename(temporary, filePath);
}

function apiKeyInfo() {
  if (runtimeApiKey) return { apiKey: runtimeApiKey, source: "runtime" };
  const fromEnv = process.env.APIKEY_FAN_API_KEY?.trim() || process.env.APIKEY_FUN_API_KEY?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: "environment" };
  return { apiKey: "", source: "none" };
}

/* ------------------------------- settings ------------------------------- */
/**
 * 归一化 BaseURL：只保留 origin + 路径，去掉结尾斜杠。
 * 返回 "" 表示留空（回退默认），返回 null 表示格式非法。
 */
function normalizeBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

function currentBaseUrl() {
  return runtimeBaseUrl || DEFAULT_BASE_URL;
}

function baseUrlInfo() {
  return { baseUrl: currentBaseUrl(), defaultBaseUrl: DEFAULT_BASE_URL, baseUrlSource: runtimeBaseUrl ? "runtime" : "default" };
}

async function loadSettings() {
  const stored = await readJsonFile(SETTINGS_FILE, null);
  const normalized = normalizeBaseUrl(stored?.baseUrl);
  runtimeBaseUrl = normalized && normalized !== DEFAULT_BASE_URL ? normalized : "";
}

async function saveSettings() {
  try {
    await writeJsonFile(SETTINGS_FILE, { baseUrl: runtimeBaseUrl });
  } catch {
    /* 配置落盘失败不影响本次运行 */
  }
}

/* ------------------------------- upstream ------------------------------- */

function postJsonWithWindowsProxy(url, apiKey, body, options) {
  const script = options?.script || POWERSHELL_HTTP_SCRIPT;
  return new Promise((resolveRequest, rejectRequest) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }
    );
    const stdout = [];
    let stdoutBytes = 0;
    let oversized = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectRequest(new Error(options.timeoutError));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= options.maxResponseBytes) stdout.push(chunk);
      else oversized = true;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRequest(error);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (oversized) {
        rejectRequest(new Error("upstream_response_too_large"));
        return;
      }
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        resolveRequest({
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          payload: result.body ? JSON.parse(result.body) : {}
        });
      } catch {
        rejectRequest(new Error("invalid_upstream_response"));
      }
    });

    child.stdin.end(JSON.stringify({
      url,
      apiKey,
      body,
      timeoutSeconds: Math.ceil(options.timeoutMs / 1000)
    }));
  });
}

async function postOpenAiResponse(apiKey, body, options) {
  const url = `${currentBaseUrl()}/responses`;
  if (process.platform === "win32") return postJsonWithWindowsProxy(url, apiKey, body, options);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs)
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > options.maxResponseBytes) throw new Error("upstream_response_too_large");
  return {
    ok: response.ok,
    status: response.status,
    payload: text ? JSON.parse(text) : {}
  };
}

/** 用 GET /models 探活：只做连通性与鉴权判断，不产生生成计费。 */
async function probeGateway(apiKey, baseUrl) {
  const url = `${baseUrl}/models`;
  const options = {
    timeoutMs: 15_000,
    timeoutError: "connection_timeout",
    maxResponseBytes: 4 * 1024 * 1024,
    script: POWERSHELL_HTTP_GET_SCRIPT
  };

  let status = 0;
  let payload = {};
  try {
    if (process.platform === "win32") {
      const result = await postJsonWithWindowsProxy(url, apiKey, null, options);
      status = result.status;
      payload = result.payload;
    } else {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(options.timeoutMs)
      });
      status = response.status;
      const text = await response.text();
      payload = text ? JSON.parse(text) : {};
    }
  } catch {
    status = 0;
    payload = {};
  }

  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .map((item) => (typeof item?.id === "string" ? item.id : ""))
    .filter(Boolean);
  const verdict = status >= 200 && status < 300
    ? "ok"
    : status === 0
      ? "unreachable"
      : status === 401 || status === 403
        ? "auth"
        : "http";

  return {
    url,
    status,
    verdict,
    modelCount: models.length,
    models: models.slice(0, 12),
    imageModel: IMAGE_MODEL,
    imageModelAvailable: models.length ? models.includes(IMAGE_MODEL) : null
  };
}

function extractImageBase64(payload) {
  const candidates = [payload?.b64_json, payload?.data?.[0]?.b64_json, payload?.item?.result];
  return candidates.find((value) => typeof value === "string" && value) || "";
}

function extractResponseText(payload) {
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

async function readImageFromSse(response, maxResponseBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) throw new Error("upstream_response_too_large");
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const image = extractImageBase64(JSON.parse(data));
        if (image) return image;
      } catch {
        // Ignore progress frames that are not JSON.
      }
    }
  }
  return "";
}

const activeBridges = new Map();

async function postImageEditWithWindowsProxy(apiKey, images, fields, options) {
  return new Promise((resolveRequest, rejectRequest) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_IMAGE_EDIT_SCRIPT],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }
    );
    const stdout = [];
    let stdoutBytes = 0;
    let oversized = false;
    let settled = false;
    const entry = { child, cancelled: false };
    const cancelKey = options.cancelKey || "";
    if (cancelKey) activeBridges.set(cancelKey, entry);
    const cleanup = () => {
      if (cancelKey && activeBridges.get(cancelKey) === entry) activeBridges.delete(cancelKey);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      rejectRequest(new Error(options.timeoutError));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= options.maxResponseBytes) stdout.push(chunk);
      else oversized = true;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      rejectRequest(error);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (entry.cancelled) {
        rejectRequest(new Error("generation_cancelled"));
        return;
      }
      if (oversized) {
        rejectRequest(new Error("upstream_response_too_large"));
        return;
      }
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        resolveRequest({
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          image: typeof result.image === "string" ? result.image : "",
          payload: result.body ? JSON.parse(result.body) : {}
        });
      } catch {
        rejectRequest(new Error("invalid_upstream_response"));
      }
    });

    child.stdin.end(JSON.stringify({
      url: `${currentBaseUrl()}/images/edits`,
      apiKey,
      images,
      fields,
      maxImageEdge: 1280,
      timeoutSeconds: Math.ceil(options.timeoutMs / 1000)
    }));
  });
}

async function postImageEdit(apiKey, images, fields, options) {
  if (process.platform === "win32") return postImageEditWithWindowsProxy(apiKey, images, fields, options);

  const form = new FormData();
  Object.entries(fields).forEach(([name, value]) => form.append(name, String(value)));
  images.forEach((dataUrl, index) => {
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("invalid_image");
    const extension = match[1] === "image/jpeg" ? "jpg" : match[1].split("/")[1];
    form.append("image[]", new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), `source-${index + 1}.${extension}`);
  });

  const response = await fetch(`${currentBaseUrl()}/images/edits`, {
    method: "POST",
    headers: { Accept: "text/event-stream", Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(options.timeoutMs)
  });

  if (!response.ok) {
    const text = await response.text();
    if (Buffer.byteLength(text) > options.maxResponseBytes) throw new Error("upstream_response_too_large");
    return { ok: false, status: response.status, image: "", payload: text ? JSON.parse(text) : {} };
  }

  if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    const text = await response.text();
    return { ok: true, status: response.status, image: extractImageBase64(text ? JSON.parse(text) : {}), payload: {} };
  }

  return {
    ok: true,
    status: response.status,
    image: await readImageFromSse(response, options.maxResponseBytes),
    payload: {}
  };
}

/* ------------------------------- prompts ------------------------------- */

function normalizeStyle(style) {
  const source = style && typeof style === "object" ? style : {};
  const profile = source.profile && typeof source.profile === "object" ? source.profile : null;
  return {
    enabled: source.enabled !== false,
    lockText: typeof source.lockText === "string" ? source.lockText : "",
    anchorImage: typeof source.anchorImage === "string" ? source.anchorImage : "",
    anchorModuleId: typeof source.anchorModuleId === "string" ? source.anchorModuleId : "",
    sampleCount: Number.isInteger(source.sampleCount) ? source.sampleCount : 0,
    profile
  };
}

function buildStyleBlock(style, options = {}) {
  if (!style.enabled) return "";
  const profile = style.profile || {};
  const hasOwnScene = Boolean(options.hasOwnScene);
  const lines = [];
  const lockText = style.lockText?.trim() || profile.stylePrompt?.trim() || "";
  if (lockText) {
    // 风格锁定描述往往把「墙面/台面/道具」也写进去了，逐字注入会让每张图共用同一个布景。
    // 有自己场景的模块只保留描述里的「观感」句，布景句丢掉，布景完全交给 BACKGROUND SET。
    if (hasOwnScene) {
      const look = lookOnlyStyleText(lockText);
      if (look) lines.push("Shared look: " + look);
    } else {
      lines.push(lockText);
    }
  }
  if (Array.isArray(profile.palette) && profile.palette.length) {
    lines.push(
      "Locked palette: " + profile.palette
        // usage 里往往写着「主墙面」「石材台面」「藤编屏风」，等于把布景又灌回去，
        // 有自己的场景时只保留色值与色名。
        .map((item) => (hasOwnScene ? `${item.hex} ${item.name}` : `${item.hex} ${item.name}${item.usage ? ` (${item.usage})` : ""}`))
        .join("; ")
    );
  }
  if (profile.lighting) {
    const lighting = hasOwnScene ? lookOnlyStyleText(profile.lighting, 60) : profile.lighting;
    // 光效里常夹着「树叶投影扫过墙面」这类写死布景的句子，过滤后过短就用原始方向色温信息兜底
    if (lighting) lines.push("Locked lighting: " + lighting);
  }
  // 构图在一页之内本来就该由每个模块自己的参考图决定，写死会把版式也一起锁成样板页
  if (profile.composition && !hasOwnScene) lines.push("Composition discipline: " + profile.composition);
  if (profile.typography) lines.push("Typography: " + profile.typography);
  if (profile.finish) {
    const finish = hasOwnScene ? lookOnlyStyleText(profile.finish, 60) : profile.finish;
    if (finish) lines.push("Finish: " + finish);
  }
  if (profile.negative) lines.push("Never include: " + profile.negative);

  // 背景与道具不进风格锁：有自己场景的模块（大多数）由 SCENE 段落决定，
  // 否则整页会退化成同一张背景，正是要修掉的问题。
  if (!hasOwnScene) {
    if (profile.background) lines.push("Background set: " + profile.background);
    if (profile.props) lines.push("Prop language: " + profile.props);
  }

  if (!lines.length) return "";
  const head = "=== STYLE LOCK — what stays identical on every module of this page ===";
  const tail = hasOwnScene
    ? "\n\nNOT locked, and must differ from module to module: the background set, the surface the product stands on, the props and the framing. This module's set is defined in the BACKGROUND SET section below. The light itself stays identical across the page — same direction, softness and colour temperature — only the set changes."
    : "";
  return head + "\n" + lines.join("\n") + tail;
}

// 老模板里会写「背景与整页保持一致」这类话，生成时需要被本模块场景覆盖
const LEGACY_SAME_BACKGROUND = /same (warm )?background|background (stays|stays the same|unchanged)|same warm neutral|背景(与|和)?整页一致|同一背景/i;

// 布景词：句子只要提到这些，就不属于「跨模块恒定的风格」，不进风格锁
const SET_VOCAB = /\b(walls?|backdrops?|backgrounds?|tabletops?|table ?tops?|surfaces?|plinths?|pedestals?|screens?|rattan|cane|props?|gobo|trays?|vases?|books?|stones?|foliage|ferns?|branches?|drapery|cloth|shelves|shelf|windows?|curtains?|plaster|limewash|travertine|marble|ceramics?|pottery|vessels?|textiles?|woven|weave|wood|wooden|grains?|lea(?:f|ves)|plants?|flowers?|d[eé]cor|staging|rooms?|interiors?|cyclorama)\b|背景|墙面|台面|桌面|底座|道具|屏风|藤编|干花|绿植|枝叶|布景|场景|水泥|石材|木纹/iu;

/** 只保留风格描述里的「观感」部分，去掉写死布景的句子。 */
function lookOnlyStyleText(raw, minLength = 120) {
  const source = String(raw || "").trim();
  if (!source) return "";
  const sentences = source.split(/(?<=[.!?;。；])\s*/).map((item) => item.trim()).filter(Boolean);
  const kept = sentences.filter((sentence) => !SET_VOCAB.test(sentence));
  const text = kept.join(" ").trim();
  // 过滤掉太多说明整段都在讲布景，宁可只用结构化字段，也不要把它重新引回来
  return text.length >= Math.min(minLength, source.length * 0.2) ? text : "";
}

function buildSceneBlock(project, module) {
  const style = normalizeStyle(project.style);
  const profile = style.profile || {};
  const scene = typeof module.scene === "string" ? module.scene.trim() : "";
  const lines = [
    "This page shares one look, not one background. Every module is shot in its own set. Never reuse the backdrop, surface, props or set dressing of the style anchor or of any other module — a repeated background is a defect, not consistency."
  ];
  if (scene) {
    lines.push("Background set for this module — build exactly this:\n" + scene);
  } else if (module.referenceImage) {
    lines.push(
      "This module owns a layout blueprint (see REFERENCE ROLES). Read its background set first: what the backdrop is made of and what colour it is, whether there is any furniture, prop, plant, textile or wall texture at all, where the product rests, how deep the background is, where the light falls and how soft the shadow under the product is. Then rebuild that same set, emptied of the blueprint's own product, and stand the client's product in it, keeping the set's emptiness or fullness exactly as the blueprint has it."
    );
    lines.push(
      "Critical, because this is the most common failure: if the blueprint's background is a seamless studio backdrop — one flat continuous colour, no visible horizon, no furniture, no props, no plant, no wall texture — then reproduce it as a seamless studio backdrop and add absolutely nothing to it. No plant, no books, no teapot, no tray, no screen, no stone, no shelf, no window light pattern on the wall. One plain colour, one soft contact shadow under the product, nothing else. Adding set dressing that the blueprint does not have is a defect of the same severity as changing the product."
    );
    lines.push(
      "Conversely, if the blueprint is a real room or a styled surface, rebuild that kind of room and keep the same kind and amount of props in the same relative positions. The set must read as the blueprint's set, not as another module's set."
    );
  } else if (profile.background) {
    lines.push(
      "This module has no blueprint of its own, so stay inside the page's base material family, and compose it differently from the other modules — different edge props, different crop, different camera height — so it never reads as a copy of another module's set:\n" + profile.background
    );
  }
  // 老项目的模块提示词里可能残留「背景与整页一致」这类句子，明确写死它已被本节覆盖
  if (LEGACY_SAME_BACKGROUND.test(module.prompt || "")) {
    lines.push(
      "Override: an earlier sentence in the module brief asks for the same background as the rest of the page. That instruction is superseded — this module keeps its own set as described here."
    );
  }
  return "=== BACKGROUND SET — THIS MODULE ONLY ===\n" + lines.join("\n\n");
}

function normalizeProduct(project) {
  const source = project?.product && typeof project.product === "object" ? project.product : {};
  const detail = typeof source.productPrompt === "string" ? source.productPrompt.trim() : "";
  const cannot = Array.isArray(source.cannotChange)
    ? source.cannotChange.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
    : [];
  return { identity: typeof source.identity === "string" ? source.identity.trim() : "", detail, cannot };
}

function buildProductLock(project, referenceImageCount) {
  const product = normalizeProduct(project);
  const lines = [
    "Image 1 is the client's real product. It is the ONLY product permitted to appear in the output.",
    "Every other attached image belongs to a sample detail page for a DIFFERENT product. The objects photographed inside them are not the client's product; they are unwanted content that must be removed and replaced."
  ];
  if (product.detail) {
    lines.push("The product to reproduce, described precisely:\n" + product.detail);
  } else if (product.identity) {
    lines.push("The product to reproduce: " + product.identity);
  }
  lines.push(
    "Reproduce the product from Image 1 faithfully: silhouette, proportions, height-to-width ratio, material, colour zones, carving, painted detailing, metallic or gilded accents, base and any markings. Do not redesign, simplify, smooth, recolour, idealise or \"improve\" it, and never substitute a similar ornament, animal or figurine in its place."
  );
  if (product.cannot.length) {
    lines.push("Never change these specific features:\n" + product.cannot.map((item) => `- ${item}`).join("\n"));
  }
  if (referenceImageCount > 0) {
    lines.push(
      `${referenceImageCount > 1 ? "The reference images" : "The reference image"} may show a completely different ornament. That ornament is a placeholder from another brand's page and must not be reproduced anywhere in this image, not even partially, not even as a reflection or background object.`
    );
  }
  lines.push(
    "Conflict rule: whenever a reference image disagrees with Image 1 about shape, colour, ornament, base, material or the number of product instances, Image 1 always wins. Instructions about style, layout and lighting never authorise changing the product."
  );
  return "=== PRODUCT LOCK — ABSOLUTE, OVERRIDES EVERY OTHER INSTRUCTION ===\n" + lines.join("\n");
}

function buildGenerationPrompt(project, module) {
  const style = normalizeStyle(project.style);
  const imageCount = 1 + (style.anchorImage ? 1 : 0) + (module.referenceImage ? 1 : 0);
  const hasOwnScene = Boolean((module.scene || "").trim() || module.referenceImage);
  const parts = [];

  parts.push(buildProductLock(project, imageCount - 1));

  const styleBlock = buildStyleBlock(style, { hasOwnScene });
  if (styleBlock) parts.push(styleBlock);

  parts.push(`=== MODULE: ${module.name} ===\n${module.prompt}`);

  parts.push(buildSceneBlock(project, module));

  const copy = module.copy || {};
  const textLines = [copy.title, copy.subtitle, ...(Array.isArray(copy.bodyLines) ? copy.bodyLines : [])]
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);

  if (module.renderText && textLines.length) {
    parts.push(
      "=== TEXT TO RENDER ===\nRender these Simplified Chinese characters exactly as written, correct glyphs, no typos, no extra words, no filler Latin placeholder text:\n" +
        textLines.map((line) => `- ${line}`).join("\n")
    );
  } else {
    parts.push(
      "=== TEXT ===\nDo not add any text, letters, numbers, logos or watermarks. Leave the designated copy areas clean and empty."
    );
  }

  const images = [project.productImages[0]];
  const roles = [];
  if (style.anchorImage) {
    images.push(style.anchorImage);
    roles.push(
      `Image ${images.length} is the STYLE ANCHOR, an already-approved module from this same detail page. Copy only its colour grading and contrast, light direction and softness, shadow falloff, grain and finish. Do NOT copy its background, backdrop, surface, props, set dressing or composition: this module is shot in its own set, described in the BACKGROUND SET section above, and that set must look different from the anchor's. Ignore the product it shows, its layout and its text.`
    );
  }
  if (module.referenceImage) {
    images.push(module.referenceImage);
    roles.push(
      `Image ${images.length} is the LAYOUT BLUEPRINT from a sample page. Take from it: the grid, how the canvas is divided, the information hierarchy, the number of product instances, their placement and scale, where the text slots sit, and the background set it is shot in. Rebuild all photography from scratch with the product from Image 1, in a set of the same kind as the blueprint's. The ornament shown there is a different brand's item — erase it completely and stand the client's product in exactly the same position and relative scale, seen from a coherent angle. Do not copy its logo, brand names or exact wording.`
    );
  }
  if (roles.length) parts.push("=== REFERENCE ROLES ===\n" + roles.join("\n"));

  parts.push(
    "=== OUTPUT ===\nReturn only the finished image at the requested aspect ratio. No frame, no border, no watermark, no signature, no extra modules stacked inside one image."
  );

  parts.push(
    "=== FINAL CHECK BEFORE RETURNING ===\nVerify silently, then fix and return:\n" +
      "1. The object pictured is the product from Image 1 — same silhouette, same colour zones, same signature details, same base.\n" +
      "2. It is not the ornament from any reference image. If the result resembles the sample page's product, discard that and rebuild it from Image 1.\n" +
      "3. No second, foreign or leftover product appears anywhere, including shelves, backgrounds, reflections or inserts.\n" +
      "4. The background is this module's own set as specified above — NOT the style anchor's backdrop, and not a background you have already used for another module of this page. Change the set if it repeats.\n" +
      "5. Palette, light direction and softness, retouching level and typography still match the locked style, so this image belongs to the same page as the others."
  );

  return { prompt: parts.join("\n\n"), images };
}

/* ------------------------------- analysis ------------------------------- */

function parseAnalysisJson(payload) {
  const text = extractResponseText(payload);
  if (!text) throw new Error("empty_analysis");
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("invalid_analysis");
    return JSON.parse(match[0]);
  }
}

async function analyzeProduct(apiKey, image) {
  const upstream = await postOpenAiResponse(apiKey, {
    model: ANALYSIS_MODEL,
    store: false,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: "You are a product photographer and sculptor's assistant writing a casting brief. The user uploads ONE photo of a physical product (a decorative ornament, figurine or homeware object). Describe the OBJECT itself so precisely that another artist could rebuild it from your words alone, without seeing the photo. Cover: what it is, overall silhouette and height-to-width ratio, the pose or posture, every distinct colour zone and where it sits on the body, materials and surface finish, carving, relief, painting and gilded or metallic accents, the base or stand, and any small signature details such as eyes, horns, beads, tassels or openings. Ignore the background, the props, the lighting, the camera angle and any text in the photo — never describe the scene. productPrompt must be a single dense English paragraph in imperative-neutral descriptive voice that can be pasted verbatim into an image generation prompt to lock the product's identity; it must state explicitly what must never change. Write identity in Chinese. cannotChange must list 3-6 concrete visual features that must survive every render. Be literal and specific: colours as plain words, shapes as comparisons, no marketing language.",
        }]
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this product in enough detail to lock its identity across a whole set of generated images." },
          { type: "input_image", image_url: image, detail: "high" }
        ]
      }
    ],
    text: {
      format: { type: "json_schema", name: "detail_product", strict: true, schema: PRODUCT_SCHEMA },
      verbosity: "medium"
    }
  }, {
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutError: "analysis_timeout",
    timeoutMs: 240_000
  });

  if (!upstream.ok) {
    const error = new Error("analysis_request_failed");
    error.statusCode = upstream.status;
    throw error;
  }
  return parseAnalysisJson(upstream.payload);
}

async function analyzeStyle(apiKey, images) {
  const upstream = await postOpenAiResponse(apiKey, {
    model: ANALYSIS_MODEL,
    store: false,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: "You are a senior Chinese e-commerce art director. The user uploads several modules that belong to ONE existing product detail page. Ignore the specific product; extract the shared visual system that makes the page feel like one photoshoot. Be concrete and measurable: hex colours, colour temperature, light direction and softness, retouching level, typography character, composition and crop rules, and the prop vocabulary. Important: a detail page keeps ONE look but each module is usually shot in its OWN background set, so background must only describe the shared base — the tonal and material family the sets come from (for example warm off-white plaster, pale walnut, raw linen) — never one specific room, wall layout or prop arrangement, because that would force every module onto the same backdrop. props must likewise describe the allowed prop family, not a fixed arrangement. stylePrompt must be a single dense English paragraph that can be prepended verbatim to every future module prompt so all modules stay visually identical in colour, light and finish; it must state that light, palette, retouching and typography are fixed while the background set changes per module. Write styleName in Chinese."
        }]
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract the unified style specification of this detail page. Focus on what stays constant across modules: shared colour base, palette, lighting, retouching, typography and finish. For background only summarise the shared tonal and material family — do not pin down one room or one prop arrangement, because every module is shot in its own set. Do not describe the product itself." },
          ...images.map((image) => ({ type: "input_image", image_url: image, detail: "high" }))
        ]
      }
    ],
    text: {
      format: { type: "json_schema", name: "detail_page_style", strict: true, schema: STYLE_SCHEMA },
      verbosity: "medium"
    }
  }, {
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutError: "analysis_timeout",
    timeoutMs: 240_000
  });

  if (!upstream.ok) {
    const error = new Error("analysis_request_failed");
    error.statusCode = upstream.status;
    throw error;
  }
  return parseAnalysisJson(upstream.payload);
}

async function analyzeModule(apiKey, image, hint) {
  const upstream = await postOpenAiResponse(apiKey, {
    model: ANALYSIS_MODEL,
    store: false,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: "You are a senior Chinese e-commerce art director and photographer. The user uploads ONE module from an existing product detail page. Reverse-engineer it into a reusable module template for a DIFFERENT product: describe the layout and information architecture, then write visualPrompt as a dense English photography and layout brief that never mentions the uploaded product's identity. visualPrompt must describe where the text sits, how big it is, its alignment and its typographic character, but must NEVER quote the actual wording, the headline or the callout labels, because the app injects the copy separately at generation time; refer to them as the headline slot and the callout slots instead. Fill scene with THIS module's own background set only, described so a photographer could rebuild it: the backdrop material and colour, the surface the product rests on, the props and where they sit, the depth of field, the ambient elements, and the direction the light enters from. Never assume this module shares a background with the rest of the page — describe what is actually in this image, not a generic page-wide backdrop. Keep scene free of the product itself and of any text. Keep the copy fields separate: copy.title / copy.subtitle / copy.bodyLines hold the Simplified Chinese wording in reading order, keeping generic marketing wording as-is and rewriting product-specific wording into a reusable Chinese template with the same rhythm and length. renderText is true when the module needs baked-in Chinese text."
        }]
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: `Reverse-engineer this detail page module into a reusable prompt.${hint ? ` Context: ${hint}` : ""}` },
          { type: "input_image", image_url: image, detail: "high" }
        ]
      }
    ],
    text: {
      format: { type: "json_schema", name: "detail_module", strict: true, schema: MODULE_SCHEMA },
      verbosity: "medium"
    }
  }, {
    maxResponseBytes: 4 * 1024 * 1024,
    timeoutError: "analysis_timeout",
    timeoutMs: 240_000
  });

  if (!upstream.ok) {
    const error = new Error("analysis_request_failed");
    error.statusCode = upstream.status;
    throw error;
  }
  return parseAnalysisJson(upstream.payload);
}

async function analyzeScene(apiKey, image) {
  const upstream = await postOpenAiResponse(apiKey, {
    model: ANALYSIS_MODEL,
    store: false,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: "You are a set designer and still-life photographer. The user uploads ONE module from a Chinese e-commerce product detail page. Describe ONLY the background set that module was shot in, so that another photographer could rebuild the same kind of set without seeing the photo: backdrop material and colour, the surface or pedestal the product rests on, the props and their placement, the depth of field and blur, the ambient elements such as foliage shadow, fabric folds, steam or wall texture, and the direction and quality of the light as it hits the set. Never describe the product, its shape or its colour, never describe the layout or the text, and never describe anything that belongs to another module. scene must be one dense English paragraph in neutral descriptive voice, concrete about materials and colours, forty to eighty words."
        }]
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe the background set of this module only." },
          { type: "input_image", image_url: image, detail: "high" }
        ]
      }
    ],
    text: {
      format: { type: "json_schema", name: "detail_scene", strict: true, schema: SCENE_SCHEMA },
      verbosity: "low"
    }
  }, {
    maxResponseBytes: 2 * 1024 * 1024,
    timeoutError: "analysis_timeout",
    timeoutMs: 180_000
  });

  if (!upstream.ok) {
    const error = new Error("analysis_request_failed");
    error.statusCode = upstream.status;
    throw error;
  }
  const parsed = parseAnalysisJson(upstream.payload);
  return typeof parsed?.scene === "string" ? parsed.scene.trim() : "";
}

/**
 * 没有参考图的模块：按已锁定的风格，为这一个模块单独设计一套布景。
 * 只做文字规划，不出图，成本很低。
 */
async function suggestScene(apiKey, { moduleName, modulePrompt, style, occupiedScenes }) {
  const profile = style?.profile || {};
  const palette = Array.isArray(profile.palette) && profile.palette.length
    ? profile.palette.map((item) => `${item.hex} ${item.name}`).join("; ")
    : "as described in the style text";
  const used = (occupiedScenes || []).filter(Boolean).slice(0, 8);
  const brief = [
    `Module: ${moduleName || "unnamed"}`,
    modulePrompt ? `Module brief: ${String(modulePrompt).slice(0, 600)}` : "",
    `Locked palette: ${palette}`,
    profile.lighting ? `Locked lighting: ${profile.lighting}` : "",
    profile.finish ? `Finish: ${profile.finish}` : "",
    used.length ? `Background sets already used by other modules of this page (do NOT repeat them):\n${used.map((s) => `- ${s}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");

  const upstream = await postOpenAiResponse(apiKey, {
    model: ANALYSIS_MODEL,
    store: false,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: "You are a set designer for Chinese e-commerce detail pages. The page keeps ONE look — same palette, same light quality, same retouching — but every module is shot in its OWN background set. Design one set for the single module described by the user, so that this module is clearly not a copy of the others while still belonging to the same page. Return scene as one dense English paragraph of forty to eighty words describing only the set: backdrop material and colour, the surface or pedestal the product rests on, the props and their placement, depth of field, ambient elements such as foliage shadow or fabric folds, and the direction and quality of light entering the set. No product, no text, no layout, no camera settings."
        }]
      },
      { role: "user", content: [{ type: "input_text", text: brief }] }
    ],
    text: {
      format: { type: "json_schema", name: "detail_scene", strict: true, schema: SCENE_SCHEMA },
      verbosity: "low"
    }
  }, {
    maxResponseBytes: 2 * 1024 * 1024,
    timeoutError: "analysis_timeout",
    timeoutMs: 120_000
  });

  if (!upstream.ok) {
    const error = new Error("analysis_request_failed");
    error.statusCode = upstream.status;
    throw error;
  }
  const parsed = parseAnalysisJson(upstream.payload);
  return typeof parsed?.scene === "string" ? parsed.scene.trim() : "";
}

/* ------------------------------- generation ------------------------------- */

function generationErrorCode(error) {
  if (error?.name === "TimeoutError" || error?.message === "generation_timeout") return "generation_timeout";
  if (error?.message === "generation_cancelled") return "generation_cancelled";
  if (error?.statusCode === 401 || error?.statusCode === 403) return "api_auth_failed";
  if (error?.statusCode === 400) return "generation_invalid_request";
  if (error?.statusCode === 404) return "model_not_found";
  if (error?.statusCode === 429) return "api_rate_limited";
  if (error?.statusCode >= 500) return "generation_upstream_error";
  if (error?.message === "empty_generation") return "generation_empty_response";
  if (error?.message === "invalid_upstream_response") return "generation_invalid_response";
  if (error?.message === "upstream_response_too_large") return "generation_response_too_large";
  return "generation_failed";
}

async function generateModuleImage(apiKey, project, module) {
  const { prompt, images } = buildGenerationPrompt(project, module);
  if (!images[0]) throw new Error("missing_product_image");

  const size = GENERATION_SIZES.get(module.ratio) || GENERATION_SIZES.get("1:1");
  const upstream = await postImageEdit(apiKey, images, {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    quality: module.quality === "auto" ? "auto" : "high",
    size,
    stream: true,
    response_format: "b64_json"
  }, {
    maxResponseBytes: MAX_GENERATION_RESPONSE_BYTES,
    timeoutError: "generation_timeout",
    timeoutMs: 420_000,
    cancelKey: module.id
  });

  if (!upstream.ok) {
    const error = new Error("openai_request_failed");
    error.statusCode = upstream.status;
    throw error;
  }
  if (!upstream.image || !/^[A-Za-z0-9+/]+={0,2}$/.test(upstream.image)) throw new Error("empty_generation");
  const bytes = Buffer.from(upstream.image, "base64");
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("empty_generation");
  return `data:image/png;base64,${upstream.image}`;
}

/* ------------------------------- storage ------------------------------- */

async function loadLibrary() {
  const stored = await readJsonFile(LIBRARY_FILE, null);
  if (stored && Array.isArray(stored.modules) && stored.modules.length) return stored.modules;
  return DEFAULT_MODULES;
}

async function saveLibrary(modules) {
  await writeJsonFile(LIBRARY_FILE, { modules, updatedAt: new Date().toISOString() });
}

function projectPath(id) {
  if (!/^[A-Za-z0-9-]{6,64}$/.test(id)) throw new Error("invalid_project_id");
  return join(PROJECT_DIR, `${id}.json`);
}

async function loadProject(id) {
  const project = await readJsonFile(projectPath(id), null);
  if (!project) throw new Error("project_not_found");
  return project;
}

async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  await writeJsonFile(projectPath(project.id), project);
}

async function listProjects() {
  await ensureDataDirs();
  const entries = await readdir(PROJECT_DIR).catch(() => []);
  const items = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    // projects/ 里还放着 *.backup-*.json 之类的副本，文件名不合法的直接跳过，
    // 否则下拉里会出现一个点开就报错的重名项目。
    if (!/^[A-Za-z0-9-]{6,64}\.json$/.test(entry)) continue;
    const project = await readJsonFile(join(PROJECT_DIR, entry), null);
    if (!project) continue;
    items.push({
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      createdAt: project.createdAt,
      moduleCount: project.modules?.length || 0,
      doneCount: (project.modules || []).filter((module) => module.result?.image).length,
      cover: project.modules?.find((module) => module.result?.image)?.result?.image || ""
    });
  }
  items.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return items;
}

function sanitizeModule(input, index) {
  const source = input && typeof input === "object" ? input : {};
  const copy = source.copy && typeof source.copy === "object" ? source.copy : {};
  return {
    id: typeof source.id === "string" && source.id ? source.id : randomUUID(),
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : `模块 ${index + 1}`,
    ratio: GENERATION_SIZES.has(source.ratio) ? source.ratio : "1:1",
    quality: source.quality === "auto" ? "auto" : "high",
    renderText: source.renderText !== false,
    prompt: typeof source.prompt === "string" ? source.prompt : "",
    scene: typeof source.scene === "string" ? source.scene : "",
    copy: {
      title: typeof copy.title === "string" ? copy.title : "",
      subtitle: typeof copy.subtitle === "string" ? copy.subtitle : "",
      bodyLines: Array.isArray(copy.bodyLines) ? copy.bodyLines.filter((line) => typeof line === "string") : []
    },
    referenceImage: typeof source.referenceImage === "string" ? source.referenceImage : "",
    result: source.result && source.result.image
      ? { image: source.result.image, createdAt: source.result.createdAt || "", model: source.result.model || "" }
      : null,
    error: typeof source.error === "string" ? source.error : "",
    updatedAt: source.updatedAt || ""
  };
}

function moduleResultTime(module) {
  const stamp = module?.result?.updatedAt || module?.result?.createdAt || "";
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

// 前端保存的是它内存里的整份 project。如果某个模块在服务端已经生成了更新的图，
// 而前端手里还是旧状态（页面开着没刷新、或生成刚结束时定时器还没跟上），
// 直接覆盖会把刚生成的图抹掉。这里按 result 时间戳保留较新的一方。
function mergeModulesFromDisk(existingModules, incomingModules) {
  const byId = new Map((existingModules || []).map((item) => [item.id, item]));
  return (incomingModules || []).map((incoming) => {
    const disk = byId.get(incoming.id);
    if (!disk) return incoming;
    const diskTime = moduleResultTime(disk);
    const incomingTime = moduleResultTime(incoming);
    if (disk?.result?.image && diskTime > incomingTime) {
      return { ...incoming, result: disk.result, error: disk.error || "" };
    }
    return incoming;
  });
}

function sanitizeProject(input) {
  const source = input && typeof input === "object" ? input : {};
  const productImages = Array.isArray(source.productImages)
    ? source.productImages.filter((item) => typeof item === "string" && item.startsWith("data:image/")).slice(0, 6)
    : [];
  const modules = Array.isArray(source.modules) ? source.modules.map(sanitizeModule) : [];
  const product = source.product && typeof source.product === "object"
    ? {
        identity: typeof source.product.identity === "string" ? source.product.identity : "",
        productPrompt: typeof source.product.productPrompt === "string" ? source.product.productPrompt : "",
        cannotChange: Array.isArray(source.product.cannotChange)
          ? source.product.cannotChange.filter((item) => typeof item === "string")
          : []
      }
    : null;
  return {
    id: source.id,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : "未命名产品",
    createdAt: source.createdAt || new Date().toISOString(),
    updatedAt: source.updatedAt || new Date().toISOString(),
    productImages,
    product,
    sampleImages: Array.isArray(source.sampleImages)
      ? source.sampleImages.filter((item) => typeof item === "string" && item.startsWith("data:image/")).slice(0, 6)
      : [],
    style: normalizeStyle(source.style),
    modules
  };
}

/* ------------------------------- http ------------------------------- */

async function serveStatic(request, response, url) {
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const filePath = resolve(PUBLIC_DIR, normalize(relative));
  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return;
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }
  if (!fileStat.isFile()) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }
  applySecurityHeaders(response);
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Length": fileStat.size,
    "Content-Type": CONTENT_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream"
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const { pathname } = url;

  if (LICENSED_PATHS.has(pathname) && !requireLicense(response)) return;

  if (pathname === "/api/license") {
    const status = licenseManager ? await licenseManager.check() : null;
    sendJson(response, 200, { ok: true, license: status });
    return;
  }

  if (pathname === "/api/license/activate") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, MAX_SMALL_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) {
      sendJson(response, 400, { ok: false, error: "missing_license_code" });
      return;
    }
    if (!licenseManager) {
      sendJson(response, 503, { ok: false, error: "license_unavailable" });
      return;
    }
    const result = await licenseManager.activate(code);
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, license: result.status });
    return;
  }

  if (pathname === "/api/health") {
    const { source } = apiKeyInfo();
    sendJson(response, 200, {
      ok: true,
      version: APP_VERSION,
      imageModel: IMAGE_MODEL,
      analysisModel: ANALYSIS_MODEL,
      apiKeyConfigured: source !== "none",
      apiKeySource: source,
      license: licenseManager ? licenseManager.status() : null,
      ...baseUrlInfo()
    });
    return;
  }

  if (pathname === "/api/config") {
    if (request.method === "GET") {
      const { source } = apiKeyInfo();
      sendJson(response, 200, { ok: true, apiKeyConfigured: source !== "none", apiKeySource: source, ...baseUrlInfo() });
      return;
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await readJsonBody(request, MAX_SMALL_BYTES);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
        return;
      }

      const hasBaseUrl = Object.prototype.hasOwnProperty.call(body || {}, "baseUrl");
      const nextBaseUrl = hasBaseUrl ? normalizeBaseUrl(body.baseUrl) : undefined;
      if (nextBaseUrl === null) {
        sendJson(response, 400, { ok: false, error: "invalid_base_url" });
        return;
      }

      const rawKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
      if (rawKey && !/^sk-[A-Za-z0-9_-]{16,}$/.test(rawKey)) {
        sendJson(response, 400, { ok: false, error: "invalid_api_key" });
        return;
      }

      if (nextBaseUrl !== undefined) {
        runtimeBaseUrl = nextBaseUrl === DEFAULT_BASE_URL ? "" : nextBaseUrl;
        await saveSettings();
      }
      if (rawKey) runtimeApiKey = rawKey;

      const { source } = apiKeyInfo();
      sendJson(response, 200, {
        ok: true,
        apiKeyConfigured: source !== "none",
        apiKeySource: source,
        ...baseUrlInfo()
      });
      return;
    }
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  if (pathname === "/api/config/probe") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    const { apiKey } = apiKeyInfo();
    if (!apiKey) {
      sendJson(response, 400, { ok: false, error: "api_not_configured" });
      return;
    }
    let body = {};
    try {
      body = await readJsonBody(request, MAX_SMALL_BYTES);
    } catch {
      body = {};
    }
    let probeBaseUrl = currentBaseUrl();
    if (Object.prototype.hasOwnProperty.call(body || {}, "baseUrl")) {
      const normalized = normalizeBaseUrl(body.baseUrl);
      if (normalized === null) {
        sendJson(response, 400, { ok: false, error: "invalid_base_url" });
        return;
      }
      probeBaseUrl = normalized || DEFAULT_BASE_URL;
    }
    const result = await probeGateway(apiKey, probeBaseUrl);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (pathname === "/api/library") {
    if (request.method === "GET") {
      sendJson(response, 200, { ok: true, modules: await loadLibrary() });
      return;
    }
    if (request.method === "PUT") {
      let body;
      try {
        body = await readJsonBody(request, MAX_JSON_BYTES);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
        return;
      }
      if (!Array.isArray(body?.modules)) {
        sendJson(response, 400, { ok: false, error: "invalid_library" });
        return;
      }
      await saveLibrary(body.modules.map(sanitizeModule));
      sendJson(response, 200, { ok: true, modules: await loadLibrary() });
      return;
    }
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  if (pathname === "/api/projects") {
    if (request.method === "GET") {
      sendJson(response, 200, { ok: true, projects: await listProjects() });
      return;
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await readJsonBody(request, MAX_JSON_BYTES);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
        return;
      }
      await ensureDataDirs();
      const library = await loadLibrary();
      const project = sanitizeProject({
        id: randomUUID(),
        name: body?.name,
        createdAt: new Date().toISOString(),
        productImages: body?.productImages,
        style: { enabled: true, profile: null, lockText: "" },
        modules: Array.isArray(body?.modules) && body.modules.length
          ? body.modules
          : library.map((item, index) => ({ ...item, id: randomUUID(), result: null, error: "", index }))
      });
      await saveProject(project);
      sendJson(response, 200, { ok: true, project });
      return;
    }
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const id = projectMatch[1];
    if (request.method === "GET") {
      try {
        sendJson(response, 200, { ok: true, project: await loadProject(id) });
      } catch {
        sendJson(response, 404, { ok: false, error: "project_not_found" });
      }
      return;
    }
    if (request.method === "PUT") {
      let body;
      try {
        body = await readJsonBody(request, MAX_JSON_BYTES);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
        return;
      }
      try {
        const existing = await loadProject(id);
        const merged = sanitizeProject({ ...existing, ...body, id });
        merged.modules = mergeModulesFromDisk(existing.modules, merged.modules);

        // 锚图同样要防止被旧的页面状态覆盖：如果磁盘上来源模块的成图更新，就用磁盘那张
        const anchorId = merged.style?.anchorModuleId;
        if (merged.style?.anchorImage && anchorId) {
          const diskModule = (existing.modules || []).find((item) => item.id === anchorId);
          const incomingModule = merged.modules.find((item) => item.id === anchorId);
          if (diskModule?.result?.image && moduleResultTime(diskModule) > moduleResultTime(incomingModule)) {
            merged.style.anchorImage = diskModule.result.image;
          }
        }

        await saveProject(merged);
        sendJson(response, 200, { ok: true, project: merged });
      } catch {
        sendJson(response, 404, { ok: false, error: "project_not_found" });
      }
      return;
    }
    if (request.method === "DELETE") {
      try {
        await rm(projectPath(id));
        sendJson(response, 200, { ok: true });
      } catch {
        sendJson(response, 404, { ok: false, error: "project_not_found" });
      }
      return;
    }
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  if (pathname === "/api/analyze-product") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, MAX_ANALYSIS_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const image = typeof body?.image === "string" ? body.image : "";
    if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(image)) {
      sendJson(response, 400, { ok: false, error: "missing_image" });
      return;
    }
    const { apiKey } = apiKeyInfo();
    if (!apiKey) {
      sendJson(response, 503, { ok: false, error: "api_not_configured" });
      return;
    }
    try {
      const product = await analyzeProduct(apiKey, image);
      sendJson(response, 200, { ok: true, product });
    } catch (error) {
      const code = error.message === "analysis_timeout" ? "analysis_timeout" : "analysis_failed";
      sendJson(response, 502, { ok: false, error: code, status: error.statusCode || 0 });
    }
    return;
  }

  if (pathname === "/api/analyze-style") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, MAX_ANALYSIS_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const images = Array.isArray(body?.images)
      ? body.images.filter((item) => typeof item === "string" && /^data:image\/(?:jpeg|png|webp);base64,/.test(item)).slice(0, 4)
      : [];
    if (!images.length) {
      sendJson(response, 400, { ok: false, error: "missing_images" });
      return;
    }
    const { apiKey } = apiKeyInfo();
    if (!apiKey) {
      sendJson(response, 503, { ok: false, error: "api_not_configured" });
      return;
    }
    try {
      const profile = await analyzeStyle(apiKey, images);
      sendJson(response, 200, { ok: true, profile });
    } catch (error) {
      const code = error.message === "analysis_timeout" ? "analysis_timeout" : "analysis_failed";
      sendJson(response, 502, { ok: false, error: code, status: error.statusCode || 0 });
    }
    return;
  }

  if (pathname === "/api/analyze-scene") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, MAX_ANALYSIS_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const image = typeof body?.image === "string" ? body.image : "";
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const moduleId = typeof body?.moduleId === "string" ? body.moduleId : "";
    const hasImage = /^data:image\/(?:jpeg|png|webp);base64,/.test(image);
    if (!hasImage && !(projectId && moduleId)) {
      sendJson(response, 400, { ok: false, error: "missing_image" });
      return;
    }
    const { apiKey } = apiKeyInfo();
    if (!apiKey) {
      sendJson(response, 503, { ok: false, error: "api_not_configured" });
      return;
    }
    try {
      if (hasImage) {
        const scene = await analyzeScene(apiKey, image);
        sendJson(response, 200, { ok: true, scene, mode: "image" });
        return;
      }
      let project;
      try {
        project = await loadProject(projectId);
      } catch {
        sendJson(response, 400, { ok: false, error: "invalid_project_id" });
        return;
      }
      if (!project) {
        sendJson(response, 404, { ok: false, error: "project_not_found" });
        return;
      }
      const module = (project.modules || []).find((item) => item.id === moduleId);
      if (!module) {
        sendJson(response, 404, { ok: false, error: "module_not_found" });
        return;
      }
      const occupiedScenes = (project.modules || [])
        .filter((item) => item.id !== moduleId)
        .map((item) => (typeof item.scene === "string" ? item.scene.trim() : ""))
        .filter(Boolean);
      const scene = await suggestScene(apiKey, {
        moduleName: module.name,
        modulePrompt: module.prompt,
        style: normalizeStyle(project.style),
        occupiedScenes
      });
      sendJson(response, 200, { ok: true, scene, mode: "suggest" });
    } catch (error) {
      const code = error.message === "analysis_timeout" ? "analysis_timeout" : "analysis_failed";
      sendJson(response, 502, { ok: false, error: code, status: error.statusCode || 0 });
    }
    return;
  }

  if (pathname === "/api/analyze-module") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, MAX_ANALYSIS_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const image = typeof body?.image === "string" ? body.image : "";
    if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(image)) {
      sendJson(response, 400, { ok: false, error: "missing_image" });
      return;
    }
    const { apiKey } = apiKeyInfo();
    if (!apiKey) {
      sendJson(response, 503, { ok: false, error: "api_not_configured" });
      return;
    }
    try {
      const draft = await analyzeModule(apiKey, image, typeof body?.hint === "string" ? body.hint : "");
      sendJson(response, 200, { ok: true, module: draft });
    } catch (error) {
      const code = error.message === "analysis_timeout" ? "analysis_timeout" : "analysis_failed";
      sendJson(response, 502, { ok: false, error: code, status: error.statusCode || 0 });
    }
    return;
  }

  if (pathname === "/api/cancel-module") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, MAX_SMALL_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const moduleId = typeof body?.moduleId === "string" ? body.moduleId : "";
    const entry = moduleId ? activeBridges.get(moduleId) : null;
    if (!entry) {
      sendJson(response, 200, { ok: true, cancelled: false });
      return;
    }
    entry.cancelled = true;
    try {
      entry.child.kill();
    } catch {
      // Process already gone.
    }
    sendJson(response, 200, { ok: true, cancelled: true });
    return;
  }

  if (pathname === "/api/generate-module") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request, MAX_SMALL_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const { apiKey } = apiKeyInfo();
    if (!apiKey) {
      sendJson(response, 503, { ok: false, error: "api_not_configured" });
      return;
    }
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const moduleId = typeof body?.moduleId === "string" ? body.moduleId : "";
    if (!projectId || !moduleId) {
      sendJson(response, 400, { ok: false, error: "missing_ids" });
      return;
    }

    let project;
    try {
      project = await loadProject(projectId);
    } catch {
      sendJson(response, 404, { ok: false, error: "project_not_found" });
      return;
    }
    // 前端会把最新的产品特征随请求带上，避免“还没落盘就开始生成”导致产品锁失效
    if (body?.product && typeof body.product === "object" && typeof body.product.productPrompt === "string") {
      project.product = { ...(project.product || {}), ...body.product };
    }
    const module = (project.modules || []).find((item) => item.id === moduleId);
    if (!module) {
      sendJson(response, 404, { ok: false, error: "module_not_found" });
      return;
    }
    if (!project.productImages?.length) {
      sendJson(response, 400, { ok: false, error: "missing_product_image" });
      return;
    }
    if (typeof module.prompt !== "string" || module.prompt.trim().length < 8) {
      sendJson(response, 400, { ok: false, error: "missing_prompt" });
      return;
    }
    if (module.prompt.length > MAX_PROMPT_CHARS) {
      sendJson(response, 400, { ok: false, error: "prompt_too_long" });
      return;
    }

    try {
      const image = await generateModuleImage(apiKey, project, module);
      module.result = { image, createdAt: new Date().toISOString(), model: IMAGE_MODEL };
      module.error = "";
      module.updatedAt = new Date().toISOString();
      if (project.style?.enabled && !project.style.anchorImage) {
        project.style.anchorImage = image;
        project.style.anchorModuleId = module.id;
      }
      await saveProject(project);
      sendJson(response, 200, { ok: true, module, anchorLocked: Boolean(project.style?.anchorImage) });
    } catch (error) {
      const code = generationErrorCode(error);
      module.error = code;
      module.updatedAt = new Date().toISOString();
      await saveProject(project).catch(() => {});
      sendJson(response, code === "api_rate_limited" ? 429 : code === "generation_timeout" ? 504 : 502, {
        ok: false,
        error: code,
        moduleId: module.id
      });
    }
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  await serveStatic(request, response, url);
}

export async function startDetailStudioServer(options = {}) {
  const port = Number.isInteger(options.port) ? options.port : Number(process.env.DETAIL_STUDIO_PORT) || 8930;
  const host = options.host || "127.0.0.1";
  await ensureDataDirs();
  await loadSettings();

  licenseManager = createLicenseManager({ dataDir: DATA_DIR });
  const licenseStatus = await licenseManager.ready();
  if (licenseStatus.state !== "licensed" && licenseStatus.state !== "trial") {
    console.log(`[license] ${licenseStatus.state}: ${licenseStatus.message}（机器码 ${licenseStatus.machineCode}）`);
  } else if (licenseStatus.state === "licensed") {
    console.log(`[license] 已授权 · ${licenseStatus.customer || "未署名"} · 到期 ${licenseStatus.expiresAt}`);
  } else {
    console.log(`[license] ${licenseStatus.message} · 到期 ${licenseStatus.trialEndsAt}`);
  }

  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.writableEnded) return;
      sendJson(response, 500, { ok: false, error: "internal_error", detail: error?.message || "" });
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(port, host, () => {
      server.removeListener("error", rejectServer);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolveServer({ server, url: `http://${host}:${actualPort}` });
    });
  });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startDetailStudioServer()
    .then(({ url }) => console.log(`Detail Image Studio: ${url}`))
    .catch((error) => {
      console.error(`Detail Image Studio failed to start: ${error.message}`);
      process.exitCode = 1;
    });
}

export { buildGenerationPrompt, buildSceneBlock, buildStyleBlock };
