/**
 * 顶栏（Topbar）文案与刷新句柄
 *
 * v8 的顶栏是「标题 + 副标题 + 全局搜索 + 刷新」，副标题是页面自己的统计口径，
 * 所以由页面在数据到手后调 setPageHeader 写进来；离开页面时清空，避免残留上一页的数字。
 * 刷新按钮优先调用页面注册的处理函数（只重取数据、不整页重载），没注册时退回整页重载。
 */
import { reactive } from 'vue';

export const pageHeader = reactive({ title: '', subtitle: '' });

let refreshHandler = null;

export function setPageHeader({ title = '', subtitle = '' } = {}) {
  pageHeader.title = title;
  pageHeader.subtitle = subtitle;
}

export function clearPageHeader() {
  pageHeader.title = '';
  pageHeader.subtitle = '';
}

export function setRefreshHandler(fn) {
  refreshHandler = typeof fn === 'function' ? fn : null;
}

export function clearRefreshHandler(fn) {
  if (!fn || refreshHandler === fn) refreshHandler = null;
}

export function triggerRefresh() {
  if (typeof refreshHandler === 'function') {
    refreshHandler();
    return;
  }
  window.location.reload();
}
