<!-- admin-web/src/components/ImageUpload.vue
     ============================================================================
     图片上传（头像 / 节目封面共用）—— 2026-11-02

     ⚠️⚠️ 为什么要有这个组件：节目排期和风采展示原来只给了个「URL 输入框」，
        因为那两页根本没接上传。校园场景里没人手里有图片链接 ⇒ 等于这个字段填不了。
        （带上传的 Cadre/Staff 是 v8 之前的独立页，菜单已经并进 Showcase 了，
         而且它们**上传前没压图**，手机原图 2MB → base64 2.7MB → HTTP 访问服务
         100KB 上限直接 413，等于上传也是坏的。）

     ⚠️ 上传契约：POST /admin/upload/avatar，请求体是 FormData，
        由 http.js 的 formDataToFilePayload() 自动换成 {filename,fileBase64}。
        调用方**只写 FormData**，不要自己拼 base64。
     ⚠️ 压图是硬要求（见 utils/imageCompress.js 的文件头）：
        400px / ≤60KB 是给头像的；封面按 maxEdge 单独给，但仍受 100KB 上限约束。
     ⚠️ 返回值是云存储 fileID（cloud://…）：小程序直接认，浏览器靠 avatarSrc() 换算。
        ⇒ 显示一律走 avatarSrc，别把 fileID 直接塞 <img src>。
     ============================================================================ -->
<template>
  <div class="iu" :class="shape">
    <el-upload
      class="iu-up"
      :show-file-list="false"
      :http-request="doUpload"
      :before-upload="beforeUpload"
      :disabled="uploading || disabled"
      accept="image/jpeg,image/png,image/webp"
    >
      <div class="iu-box" :class="{ busy: uploading }">
        <img v-if="src && !uploading" :src="src" alt="" />
        <span v-else class="iu-placeholder">{{ uploading ? '上传中…' : emptyText }}</span>
        <span v-if="src && !uploading" class="iu-mask">更换</span>
      </div>
    </el-upload>

    <div class="iu-side">
      <div class="iu-hint">{{ hint }}</div>
      <!-- URL 兜底：只在确实有图链接的人手里有用，默认收起成一行输入 -->
      <el-input
        v-if="allowUrl"
        v-model="urlDraft"
        size="small"
        class="iu-url"
        placeholder="或粘贴图片链接"
        @change="applyUrl"
      />
      <el-button v-if="src" link size="small" class="iu-clear" @click="clear">移除</el-button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import { avatarSrc } from '@/utils/avatar';
import { compressImage } from '@/utils/imageCompress';

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** circle = 头像（圆形 76px）；rect = 封面（16:9 横图） */
  shape: { type: String, default: 'circle' },
  hint: { type: String, default: '支持 jpg/png/webp，选图后自动压缩' },
  emptyText: { type: String, default: '上传图片' },
  disabled: { type: Boolean, default: false },
  /** 压图上限：头像 400 够；封面给大一点，但 budget 仍要压在 100KB 请求体里 */
  maxEdge: { type: Number, default: 400 },
  budgetBytes: { type: Number, default: 60 * 1024 },
  allowUrl: { type: Boolean, default: true },
});
const emit = defineEmits(['update:modelValue']);

const uploading = ref(false);
const urlDraft = ref('');
const src = computed(() => avatarSrc(props.modelValue));

watch(() => props.modelValue, (v) => { urlDraft.value = v || ''; }, { immediate: true });

function beforeUpload(file) {
  const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  if (!ok) ElMessage.error('仅支持 jpg/png/webp');
  return ok;
}

async function doUpload(option) {
  const file = option.file;
  uploading.value = true;
  try {
    // ⚠️ 先压再发：不压的话大图必然 413（见文件头）
    const out = await compressImage(file, { maxEdge: props.maxEdge, budgetBytes: props.budgetBytes });
    const fd = new FormData();
    fd.append('file', out.blob, out.filename);
    const data = await http.post('/admin/upload/avatar', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    if (!data || !data.url) throw new Error('没有拿到图片地址');
    emit('update:modelValue', data.url);
    ElMessage.success(out.overBudget ? '已上传（图片较大，已尽量压缩）' : '已上传');
  } catch (err) {
    // 拦截器已经弹过一次的，别重复报错；这里只兜「压缩失败」这类本地错误
    if (err && /没有拿到|压缩/.test(String(err.message || ''))) {
      ElMessage.error(String(err.message || '上传失败'));
    }
  } finally {
    uploading.value = false;
  }
}

function applyUrl(v) {
  const s = String(v || '').trim();
  if (s !== (props.modelValue || '')) emit('update:modelValue', s);
}

function clear() { emit('update:modelValue', ''); }
</script>

<style scoped>
.iu { display: flex; align-items: flex-start; gap: 14px; }
.iu-up :deep(.el-upload) { display: block; }
.iu-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--parchment);
  overflow: hidden;
  cursor: pointer;
}
.iu.circle .iu-box { width: 76px; height: 76px; border-radius: 50%; }
.iu.rect .iu-box { width: 160px; height: 90px; border-radius: 12px; }
.iu-box img { width: 100%; height: 100%; object-fit: cover; display: block; }
.iu-placeholder { font-size: 12px; color: var(--muted); }
.iu-box.busy { opacity: .6; }
/* 「更换」只在有图时浮一层，纯黑透明，不做彩色投影 */
.iu-mask {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: #fff;
  background: rgba(0, 0, 0, .38);
  opacity: 0; transition: opacity .16s var(--ease, ease);
}
.iu-box:hover .iu-mask { opacity: 1; }

.iu-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.iu-hint { font-size: 12px; color: var(--muted); line-height: 1.5; }
.iu-url :deep(.el-input__wrapper) { background: var(--parchment); box-shadow: none; }
.iu-clear { align-self: flex-start; color: var(--muted); padding: 0; }
</style>
