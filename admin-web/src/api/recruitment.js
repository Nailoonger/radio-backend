import http, { requestMode, cloudApiUrl } from '@/utils/http';

// 招新数据仅在云端；直连模式不能误发到未实现的 Express 接口。
export const recruitmentAvailable = requestMode === 'cloud' && !!cloudApiUrl;
export const recruitmentUnavailableMessage = '招新管理需要启用云端请求通道，请使用已配置云端通道的管理后台。';

function call(method, path, data) {
  if (!recruitmentAvailable) {
    const error = new Error(recruitmentUnavailableMessage);
    error.code = 'RECRUITMENT_CLOUD_REQUIRED';
    return Promise.reject(error);
  }
  return method === 'get' ? http.get(path, { params: data }) : http[method](path, data);
}

const base = '/admin/recruitment';
const idPath = (id) => encodeURIComponent(id);
export const listBatches = (params) => call('get', `${base}/batches`, params);
export const getBatch = (id) => call('get', `${base}/batches/${idPath(id)}`);
export const createBatch = (body) => call('post', `${base}/batches`, body);
export const updateBatch = (id, body) => call('put', `${base}/batches/${idPath(id)}`, body);
export const publishBatch = (id, version) => call('post', `${base}/batches/${idPath(id)}/publish`, { version });
export const publishResults = (id, version) => call('post', `${base}/batches/${idPath(id)}/results`, { version });
export const archiveBatch = (id, version) => call('post', `${base}/batches/${idPath(id)}/archive`, { version });
export const listApplications = (params) => call('get', `${base}/applications`, params);
export const getApplication = (id) => call('get', `${base}/applications/${idPath(id)}`);
export const reviewApplication = (id, body) => call('put', `${base}/applications/${idPath(id)}/review`, body);
export const arrangeInterview = (id, body) => call('put', `${base}/applications/${idPath(id)}/interview`, body);
