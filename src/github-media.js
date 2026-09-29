/**
 * github-media.js
 * 用「GitHub 公开仓库 + jsDelivr CDN 直链」替代 Cloudflare R2 存储媒体文件。
 *
 * 设计要点：
 * 1. 上传走 GitHub Contents API，一次上传 = 一次 commit。
 * 2. 外链 URL 钉死在 commit SHA 上（/gh/owner/repo@<40位sha>/path），
 *    从而绕开 jsDelivr 对「分支 URL」长达 12 小时、对「版本别名」长达 7 天的缓存，
 *    做到上传后立即可见；同时该 URL 不可变，同名覆盖问题也一并消失。
 * 3. 浏览器直连 CDN，Worker 不参与读取，不消耗 GitHub API 额度。
 *
 * ⚠️ 前提：仓库必须 Public。公开仓库里的文件任何人可见，且 jsDelivr 会把
 *    访问过的文件永久存进它自己的 S3 —— 即使你后来从仓库删除，CDN 仍会继续分发。
 *    请勿上传任何敏感内容。
 */

// ---------------------------------------------------------------- 配置

const DEFAULTS = {
  branch: 'main',
  jsdHost: 'cdn.jsdelivr.net',
  // jsDelivr 对 GitHub 单文件默认不支持 > 20MB；但真正的瓶颈是 Workers 免费套餐
  // 每次请求仅 10ms CPU，base64 编码大文件会直接超时。故默认压到 1MB。
  maxBytes: 1024 * 1024,
  prefix: 'media',
  warmup: true,
  // cdn.jsdelivr.net 在国内存在 DNS 污染 / SNI 阻断，随 URL 一并返回备用域名，
  // 前端可在 onerror 时依次降级。设 MEDIA_FALLBACK_HOSTS="" 可关闭。
  fallbackHosts: ['fastly.jsdelivr.net', 'gcore.jsdelivr.net', 'testingcf.jsdelivr.net'],
};

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-msvideo': 'avi', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'weba',
  'application/pdf': 'pdf', 'application/zip': 'zip',
  'application/json': 'json', 'text/plain': 'txt', 'text/markdown': 'md',
};

class MediaError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function cfgOf(env = {}) {
  const token = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  if (!token) throw new MediaError(500, '缺少 GITHUB_TOKEN（请在 Worker 设置里加密写入）');
  if (!owner) throw new MediaError(500, '缺少 GITHUB_OWNER');
  if (!repo) throw new MediaError(500, '缺少 GITHUB_REPO');
  return {
    token, owner, repo,
    branch: env.GITHUB_BRANCH || DEFAULTS.branch,
    jsdHost: env.JSD_HOST || DEFAULTS.jsdHost,
    maxBytes: Number(env.MEDIA_MAX_BYTES) || DEFAULTS.maxBytes,
    prefix: env.MEDIA_PREFIX || DEFAULTS.prefix,
    warmup: env.MEDIA_WARMUP === undefined ? DEFAULTS.warmup : String(env.MEDIA_WARMUP) !== 'false',
    fallbackHosts: env.MEDIA_FALLBACK_HOSTS === ''
      ? []
      : (env.MEDIA_FALLBACK_HOSTS
        ? env.MEDIA_FALLBACK_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULTS.fallbackHosts),
  };
}

// ---------------------------------------------------------------- 工具

function toBase64(bytes) {
  const CHUNK = 0x8000; // 32KB 一批，避免 String.fromCharCode 参数过多爆栈
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function extOf(filename, mime) {
  const fromName = (filename || '').match(/\.([A-Za-z0-9]{1,8})$/);
  if (fromName) return fromName[1].toLowerCase();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  return 'bin';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function buildPath(cfg, filename, mime, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = pad2(now.getUTCMonth() + 1);
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return `${cfg.prefix}/${y}/${m}/${id}.${extOf(filename, mime)}`;
}

/** 生成 jsDelivr 直链（钉在 commit SHA 上，立即可见且不可变） */
export function mediaUrl(cfg, sha, path) {
  return `https://${cfg.jsdHost}/gh/${cfg.owner}/${cfg.repo}@${sha}/${path}`;
}

/** 备用域名镜像链（同一 path/sha，仅换域名），供前端 onerror 降级 */
export function fallbackUrls(cfg, sha, path) {
  const base = `/gh/${cfg.owner}/${cfg.repo}@${sha}/${path}`;
  return cfg.fallbackHosts.map((h) => `https://${h}${base}`);
}

/**
 * 从 jsDelivr 直链里反解出仓库内路径（删除笔记附件时需要）。
 * 支持 /gh/owner/repo@<sha>/<path> 与 /gh/owner/repo/<path> 两种写法，
 * 非本仓库的链接返回 null。
 */
export function ghPathFromUrl(env, url) {
  if (typeof url !== 'string' || !url) return null;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/gh\/([^/]+)\/([^/@]+)(?:@[^/]+)?\/(.+)$/);
    if (!m) return null;
    const [, o, r, p] = m;
    if (owner && o.toLowerCase() !== String(owner).toLowerCase()) return null;
    if (repo && r.toLowerCase() !== String(repo).toLowerCase()) return null;
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- GitHub API

async function ghApi(cfg, method, path, body, retry = 0) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'memos-worker-media',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }

  if (res.ok) return json;

  // 并发提交同一仓库会撞 SHA 冲突，退避重试
  if (res.status === 409 && retry < 3) {
    await new Promise((r) => setTimeout(r, 300 * (retry + 1)));
    return ghApi(cfg, method, path, body, retry + 1);
  }

  if (res.status === 403 || res.status === 429) {
    throw new MediaError(429, 'GitHub API 限流（5000 次/小时，全账号共享），请稍后再试', text);
  }
  if (res.status === 422) {
    throw new MediaError(413, 'GitHub 拒绝：文件过大或参数非法（单文件实际常卡在 ~50MB）', text);
  }
  if (res.status === 401) {
    throw new MediaError(500, 'GITHUB_TOKEN 无效或已过期', text);
  }
  if (res.status === 404) {
    throw new MediaError(404, '仓库/路径不存在，或 token 无该仓库的 Contents 写权限', text);
  }
  throw new MediaError(502, `GitHub API 返回 ${res.status}`, text);
}

// ---------------------------------------------------------------- 核心能力

/**
 * 上传单个文件到 GitHub 并返回 jsDelivr 直链。
 * @returns {{path:string, sha:string, url:string, name:string, mime:string, size:number}}
 */
export async function uploadMedia(env, { bytes, filename, mime }) {
  const cfg = cfgOf(env);
  if (!bytes || !bytes.length) throw new MediaError(400, '空文件');

  if (bytes.length > cfg.maxBytes) {
    const mb = (cfg.maxBytes / 1024 / 1024).toFixed(1);
    throw new MediaError(
      413,
      `文件 ${(bytes.length / 1024 / 1024).toFixed(2)}MB 超过上限 ${mb}MB。` +
      `jsDelivr 单文件上限 20MB，且 Workers 免费套餐每次请求仅 10ms CPU，大文件 base64 编码必然超时。` +
      `请压缩图片，或升级到 Workers Paid（CPU 30s）。`
    );
  }

  const path = buildPath(cfg, filename, mime);
  const content = toBase64(bytes);

  const res = await ghApi(cfg, 'PUT', path, {
    message: `chore(media): add ${path}`,
    content,
    branch: cfg.branch,
  });

  const sha = res && res.commit && res.commit.sha;
  if (!sha) throw new MediaError(502, 'GitHub 未返回 commit sha', JSON.stringify(res));

  return {
    path,
    sha,
    url: mediaUrl(cfg, sha, path),
    fallbacks: fallbackUrls(cfg, sha, path),
    name: filename || path.split('/').pop(),
    mime: mime || 'application/octet-stream',
    size: bytes.length,
  };
}

/** 删除仓库里的文件（不影响已被 jsDelivr 缓存的旧副本） */
export async function deleteMedia(env, path) {
  const cfg = cfgOf(env);
  const meta = await ghApi(cfg, 'GET', `${path}?ref=${encodeURIComponent(cfg.branch)}`);
  return ghApi(cfg, 'DELETE', path, {
    message: `chore(media): remove ${path}`,
    sha: meta.sha,
    branch: cfg.branch,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 处理上传请求：multipart/form-data，字段名 file（可多个）。
 * 返回 { success, files: [{url,name,mime,size,path,sha}] }
 */
export async function handleUpload(request, env, ctx) {
  try {
    cfgOf(env);
    const form = await request.formData();
    const entries = form.getAll('file').length ? form.getAll('file') : form.getAll('files');
    const files = entries.filter((f) => typeof f !== 'string');
    if (!files.length) return json({ success: false, error: '没有收到文件' }, 400);

    const cfg = cfgOf(env);
    const out = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const item = await uploadMedia(env, {
        bytes,
        filename: f.name || 'file',
        mime: f.type || 'application/octet-stream',
      });
      out.push(item);
      // 预热：触发 jsDelivr 首次回源，用户第一次打开就不会慢
      if (ctx && cfg.warmup) {
        ctx.waitUntil(fetch(item.url, { method: 'GET' }).catch(() => {}));
      }
    }
    return json({ success: true, files: out });
  } catch (e) {
    const status = e instanceof MediaError ? e.status : 500;
    return json({ success: false, error: e.message, detail: e.detail }, status);
  }
}

/**
 * 把上传结果整理成 notes.pics / files / videos 可直接存放的结构。
 * 默认带上 path（删除时必须用到它）；备用链体积较大，需显式开启。
 */
export function toMediaRefs(files, { withFallbacks = false } = {}) {
  return files.map((f) => {
    const ref = { url: f.url, name: f.name, type: f.mime, size: f.size, path: f.path };
    if (withFallbacks && f.fallbacks && f.fallbacks.length) ref.fallbacks = f.fallbacks;
    return ref;
  });
}

/**
 * 删除笔记里引用的媒体文件。
 * @param refs 从 notes.pics / files / videos 解析出来的数组（需含 path）
 * @returns { deleted: [], failed: [{path, error}] }
 */
export async function deleteMediaRefs(env, refs) {
  const deleted = [];
  const failed = [];
  for (const ref of refs) {
    if (!ref || !ref.path) { failed.push({ path: ref && ref.path, error: '缺少 path，无法删除' }); continue; }
    try {
      await deleteMedia(env, ref.path);
      deleted.push(ref.path);
    } catch (e) {
      failed.push({ path: ref.path, error: e.message });
    }
  }
  return { deleted, failed };
}

/**
 * 删除路由：接受 JSON 数组 ["media/2026/09/x.png", ...] 或 { paths: [...] } 或 { path: "..." }。
 * 只清理 GitHub 仓库；已被 jsDelivr 抓取过的副本无法清除。
 */
export async function handleDelete(request, env) {
  try {
    cfgOf(env);
    let body;
    try { body = await request.json(); } catch { body = null; }
    let paths = [];
    if (Array.isArray(body)) paths = body;
    else if (body && Array.isArray(body.paths)) paths = body.paths;
    else if (body && typeof body.path === 'string') paths = [body.path];

    paths = paths.map((p) => String(p).replace(/^\/+/, '')).filter(Boolean);
    if (!paths.length) return json({ success: false, error: '没有提供 path' }, 400);

    const result = await deleteMediaRefs(env, paths.map((p) => ({ path: p })));
    return json({ success: result.failed.length === 0, ...result });
  } catch (e) {
    const status = e instanceof MediaError ? e.status : 500;
    return json({ success: false, error: e.message, detail: e.detail }, status);
  }
}
