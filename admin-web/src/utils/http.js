import axios from 'axios';
import { ElMessage } from 'element-plus';
import router from '@/router';

/**
 * 统一的请求层 —— 支持两条通道（铁律：随时可切回）
 *
 *   direct（现状）：axios 直连原 Express 后端，baseURL = VITE_API_BASE（默认 /api）
 *   cloud（阶段 9）：走云开发的「HTTP 访问服务」
 *                   POST https://<envId>-<数字>.ap-shanghai.app.tcloudbase.com/<触发路径>
 *                   请求体 = 信封 { method, path, body, token }
 *
 * ⚠️ 切通道**只改环境变量**，业务代码一行不动：
 *     .env.local 里写
 *         VITE_REQUEST_MODE=cloud
 *         VITE_CLOUD_API_URL=https://<envId>-<数字>.ap-shanghai.app.tcloudbase.com/api
 *     不带这两个变量（或写 direct）就是原来的行为。
 *
 * ⚠️⚠️ 云函数侧由 `cloud/cloudfunctions/api/httpBridge.js` 把「集成请求」还原成
 *     `{ method, path, body, token }`，所以**路由 / handler / 鉴权全是同一套** ——
 *     不存在「网页端一套接口、小程序端另一套」的分叉。
 *
 * 为什么用「信封」而不是 RESTful（GET /api/admin/switch/list）：
 *   云接入默认**不开路径透传**时 `event.path` 恒等于触发路径（`/api`），真实路由拿不到；
 *   信封把路由放在请求体里，不依赖那项配置，最稳。
 */

const MODE = (import.meta.env.VITE_REQUEST_MODE || 'direct').toLowerCase();
const CLOUD_URL = import.meta.env.VITE_CLOUD_API_URL || '';

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: MODE === 'cloud' ? 30000 : 15000,   // 云函数冷启动比直连慢，给宽一点
});

const readToken = () => localStorage.getItem('admin_token');

http.interceptors.request.use((config) => {
  const token = readToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** 业务错误 → Error（带 code），让调用方自己决定怎么提示 */
function bizError(code, message, extra) {
  const err = new Error(message || '请求失败');
  err.code = code;
  Object.assign(err, extra || {});
  return err;
}

function unwrap(body) {
  if (body?.code === 0) return body.data;
  return Promise.reject(bizError(body?.code, body?.message || '请求失败', { httpStatus: 200 }));
}

http.interceptors.response.use(
  (resp) => {
    // 二进制流（xlsx 下载等）不走 {code:0} 解包，直接返回 Blob
    if (resp.config.responseType === 'blob') return resp.data;
    return unwrap(resp.data);
  },
  (err) => {
    const status = err.response?.status;
    const body = err.response?.data;
    // ⚠️ 保持原样：原后端鉴权失败统一返回 **HTTP 401**（`fail(res, code, msg, 401)`），
    //    这里不要顺手加 `body?.code === 40101` —— 那是**改既有行为**，不是等价迁移。
    if (status === 401) {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_info');
      if (router.currentRoute.value.name !== 'Login') {
        router.push({ name: 'Login' });
      }
    }
    // 40301 = 仅超级管理员可操作（权限边界在服务端，前端只负责把文案说人话）
    if (body?.code === 40301 || status === 403) {
      ElMessage.error(body?.message || '仅超级管理员可操作');
      return Promise.reject(err);
    }
    ElMessage.error(body?.message || err.message || '网络异常');
    return Promise.reject(err);
  }
);

/* ══════════════════ cloud 通道 ══════════════════ */

/**
 * 云通道的 xlsx 下载：云函数返回 `{ filename, base64, mime }`
 * （源实现直接吐二进制流，云函数没有 HTTP 流，改成 base64 契约）。
 * ⚠️ 这里要还原成 Blob —— 调用方 `URL.createObjectURL(blob)` 的写法一行都不用改。
 */
function base64ToBlob(base64, mime) {
  const bin = atob(String(base64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

/** `{ filename, base64, mime }` 长得像下载契约吗 */
function isFilePayload(data) {
  return !!(data && typeof data === 'object' && typeof data.base64 === 'string');
}

/* ══════════════════ 上传适配：FormData → 云端契约 ══════════════════ */

/**
 * ⚠️⚠️ 文件上传在两条通道下的形状不一样（2026-09-30 实测踩到）：
 *
 *   direct：`http.post(url, formData, { 'Content-Type': 'multipart/form-data' })`
 *           → 原后端用 multer 收 multipart，业务代码就是这么写的。
 *   cloud ：请求体是 **JSON 信封**，FormData 一 `JSON.stringify` 就变成 `{}`，
 *           文件直接丢 —— 云端 `importPreview` 报 `40001 缺少文件内容（fileBase64）`。
 *
 * 云端的真实契约是 **`{ filename, fileBase64 }`**（`handlers/admin/student.js`）。
 * 这里做**唯一一处**适配：认出 FormData 就自己读成 base64 换个体积发出去。
 * ⇒ direct 模式一行不受影响，业务代码（ImportSheet.vue 等）也一行不用改。
 *
 * @param {FormData} fd
 * @returns {Promise<object>} `{ filename, fileBase64, ...其余标量字段 }`
 */
function formDataToFilePayload(fd, bizError) {
  return new Promise((resolve, reject) => {
    let pick = null;                 // 第一个 Blob/File 当作要上传的文件
    const extra = {};                // 其余标量字段原样带上（云端不认识的字段会被忽略，无害）
    fd.forEach((v, k) => {
      if (!pick && v && typeof v === 'object' && typeof v.arrayBuffer === 'function') {
        pick = { key: k, blob: v };
      } else if (v !== null && typeof v !== 'object') {
        extra[k] = v;
      }
    });

    if (!pick) return reject(bizError(40001, '没有找到要上传的文件'));

    const reader = new FileReader();
    reader.onerror = () => reject(bizError(40001, '读取文件失败，请重试'));
    reader.onload = () => {
      const s = String(reader.result || '');
      const comma = s.indexOf(',');
      resolve({
        filename: pick.blob.name || '',
        fileBase64: comma >= 0 ? s.slice(comma + 1) : s,   // 去掉 data:...;base64, 前缀
        ...extra,
      });
    };
    reader.readAsDataURL(pick.blob);
  });
}

/** 浏览器环境下才可能是 FormData（Node/SSR 里这个构造器不存在） */
function isFormData(v) {
  return typeof FormData !== 'undefined' && v instanceof FormData;
}

async function cloudRequest({ method, url, params, data, responseType }) {
  const p = String(url || '');

  // 上传适配（见 formDataToFilePayload 的说明）
  let body = data || {};
  if (isFormData(body)) {
    try {
      body = await formDataToFilePayload(body, bizError);
    } catch (e) {
      ElMessage.error(e.message || '文件读取失败');
      return Promise.reject(e);
    }
  }

  const envelope = {
    method: String(method || 'GET').toUpperCase(),
    path: p,
    body,
    token: readToken() || '',
    // GET 参数按原约定落在 query 里；direct 模式下 axios 会拼成 querystring，这里显式对齐
    query: params || {},
  };

  let resp;
  try {
    resp = await axios.post(CLOUD_URL, envelope, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
      // ⚠️ 不要让它对 4xx/5xx 抛错：业务错误都在 body 里，要自己解包
      validateStatus: () => true,
    });
  } catch (e) {
    ElMessage.error(e.message || '网络异常');
    return Promise.reject(e);
  }

  const raw = resp.data;
  // 有些配置下云接入会把函数返回值原样塞进 body 字符串，这里兜一层
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch (e) { return null; } })() : raw;
  if (!parsed || typeof parsed !== 'object') {
    ElMessage.error('云函数返回了非 JSON 响应');
    return Promise.reject(bizError(50001, '云函数返回了非 JSON 响应'));
  }

  if (parsed.code !== 0) {
    const err = bizError(parsed.code, parsed.message || '请求失败', { httpStatus: resp.status });
    if (parsed.code === 40101) {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_info');
      if (router.currentRoute.value.name !== 'Login') router.push({ name: 'Login' });
    }
    if (parsed.code !== 40301) ElMessage.error(parsed.message || '请求失败');
    else ElMessage.error(parsed.message || '仅超级管理员可操作');
    return Promise.reject(err);
  }

  // xlsx：把 base64 还原成 Blob，调用方写法不变
  if (responseType === 'blob') {
    if (!isFilePayload(parsed.data)) {
      ElMessage.error('下载失败：云函数没有返回文件内容');
      return Promise.reject(bizError(50001, '下载失败'));
    }
    return base64ToBlob(parsed.data.base64, parsed.data.mime);
  }
  return parsed.data === undefined ? null : parsed.data;
}

/* ══════════════════ 对外形状：与 axios 实例一致 ══════════════════ */

/**
 * ⚠️ 全站 114 处都写成 `http.get(url, config)` / `http.post(url, data, config)`。
 *    cloud 模式下要把这些调用转给 `cloudRequest`，所以这里**包了一个同形状的门面**：
 *    方法名 / 参数顺序 / 返回值语义都与 axios 一致 → 业务代码零改动。
 */
function makeFacade() {
  if (MODE !== 'cloud') return http;

  const call = (method) => (url, a, b) => {
    // axios 的签名：get(url, config) / post(url, data, config)
    const isBody = method === 'post' || method === 'put' || method === 'patch';
    const data = isBody ? a : undefined;
    const config = (isBody ? b : a) || {};
    return cloudRequest({ method, url, params: config.params, data, responseType: config.responseType });
  };

  return {
    get: call('get'),
    post: call('post'),
    put: call('put'),
    patch: call('patch'),
    delete: call('delete'),
    request: (cfg) => cloudRequest({
      method: cfg.method, url: cfg.url, params: cfg.params, data: cfg.data, responseType: cfg.responseType,
    }),
    // 少量地方会直接用实例属性（如 `http.defaults`），给个透传兜底，避免 undefined 报错
    defaults: http.defaults,
    interceptors: http.interceptors,
  };
}

export const requestMode = MODE;
export const cloudApiUrl = CLOUD_URL;
export default makeFacade();
