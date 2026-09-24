<template>
  <div class="song-settings">
    <!-- v8：子页返回入口 -->
    <div class="back-row">
      <a class="back-link" @click="$router.push('/submit')">‹ 返回投稿 & 点歌审核</a>
      <span class="micro">点歌设置 · 排期容量 / 候补队列 / 点歌时间窗口 / 提交规则 / 播出时段 / 两份注意事项</span>
    </div>

    <!-- ══════════ 排期容量与候补 + 提交规则（双栏） ══════════ -->
    <div class="cols">
      <!-- 排期容量与候补（v2：日/周名额已退役，改为「每格正式位 × 格子数」+ 一条全局候补队列） -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">排期容量与候补</span>
          <span class="tag" :class="auth.isSuperAdmin ? 'tag-pass' : ''">
            {{ auth.isSuperAdmin ? '仅超管可改' : '只读 · 仅超管可改' }}
          </span>
        </div>
        <div class="card" style="padding:18px 20px">
          <div class="quota-grid">
            <div class="quota-item">
              <div class="rowc" style="justify-content:space-between">
                <span class="micro">下周正式位</span>
                <span>
                  <b class="num quota-num">{{ capUnlimited ? '不限' : (cap.weekCapacity ?? 0) }}</b>
                  <span class="micro">{{ capUnlimited ? ` 每格不限 × ${gridCount} 格` : ` = ${cap.capacity ?? 0} × ${gridCount} 格` }}</span>
                </span>
              </div>
            </div>
            <div class="quota-item">
              <div class="rowc" style="justify-content:space-between">
                <span class="micro">已占位</span>
                <span>
                  <b class="num quota-num">{{ seatedTotal }}</b>
                  <span class="micro"> / {{ capUnlimited ? '不限' : (cap.weekCapacity ?? 0) }}</span>
                </span>
              </div>
              <div v-if="!capUnlimited" class="bar"><i :style="{ width: pctOf(seatedTotal, cap.weekCapacity) }" /></div>
            </div>
            <div class="quota-item">
              <div class="rowc" style="justify-content:space-between">
                <span class="micro">候补队列</span>
                <span>
                  <b class="num quota-num">{{ queue.total ?? 0 }}</b>
                  <span class="micro"> / {{ queueUnlimited ? '不限' : (queue.limit ?? 0) }}<template v-if="queue.limitAuto">（自动）</template></span>
                </span>
              </div>
              <div class="bar"><i :style="{ width: pctOf(queue.total, queue.limit) }" /></div>
            </div>
            <div class="quota-item quota-item-text">
              <span class="micro">补位待审（最优先处理）</span>
              <b class="num quota-num">{{ promotedCount }}</b>
            </div>
          </div>

          <div class="quota-edit">
            <div class="quota-fields">
              <div class="field">
                <label class="field-label">每格正式位</label>
                <el-input-number v-model="capForm.capacity" :min="0" :max="99" controls-position="right" />
              </div>
              <div class="field">
                <label class="field-label">候补队列上限</label>
                <el-input-number v-model="capForm.queueLimit" :min="0" :max="999" controls-position="right" />
              </div>
            </div>
            <div class="quota-buttons">
              <!-- 普通管理员：接口已收超管（40301），这里一并置灰，别让人点了才吃 403 -->
              <el-button
                type="primary" :loading="capSaving" :disabled="!auth.isSuperAdmin"
                @click="saveCapacity" class="btn-save"
              >
                <IconCheck :size="15" class="btn-icon" />保存
              </el-button>
              <el-button
                :loading="sweeping" plain :disabled="!auth.isSuperAdmin"
                @click="sweepQueue" class="btn-sweep"
              >
                <IconRefresh :size="15" class="btn-icon" />递补 + 定稿检查
              </el-button>
            </div>
          </div>

          <div class="micro" style="margin-top:11px;line-height:1.7">
            每格正式位填 <b>0</b> = 不限；候补上限填 <b>0</b> = 自动（= 下周正式位总数）。
            学生<b>提交即占位</b>：格子满了就进全局候补队列（先进先出，跨所有时段）；
            <b>全部格子占满</b>时，整个候补队列由系统自动驳回（不占学生周次数）。
          </div>
        </div>
      </div>

      <!-- 提交规则段 -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">提交规则</span>
          <span class="tag" :class="auth.isSuperAdmin ? 'tag-pass' : ''">
            {{ auth.isSuperAdmin ? '即时生效 · 仅超管可改' : '只读 · 仅超管可改' }}
          </span>
        </div>
        <div class="card" style="padding:8px 20px">
          <div class="kv">
            <span class="k" style="width:132px">每人每周上限</span>
            <span class="rowc gap8">
              <el-input-number v-model="ruleForm.weeklyUserLimit" :min="0" :max="99" size="small" :controls="false" />
              <span class="micro">次 · 填 0 = 不限</span>
            </span>
          </div>
          <div class="kv">
            <span class="k" style="width:132px">同曲一周去重</span>
            <span class="rowc gap13">
              <el-switch v-model="ruleForm.dupBlock" :active-value="1" :inactive-value="0" />
              <span class="micro">开：同一首歌一周内只能点一次</span>
            </span>
          </div>
          <div class="kv">
            <span class="k" style="width:132px">生效范围</span>
            <span class="micro">只算点歌（文稿不受影响）；候补中的歌也算占用；因满额 / 窗口截止被系统驳回的不占个人次数</span>
          </div>
          <div class="kv" style="border-bottom:none">
            <span class="k" style="width:132px">保存</span>
            <span class="rowc gap13">
              <el-button
                type="primary" size="small" :loading="ruleSaving"
                :disabled="!auth.isSuperAdmin" @click="saveRules" class="btn-save"
              >
                <IconCheck :size="14" class="btn-icon" />保存规则
              </el-button>
              <span class="micro">
                {{ auth.isSuperAdmin
                  ? '改完点这里才生效 · 保存后会显示服务端真正生效的值'
                  : '只读 · 提交规则由超级管理员维护（后端 40301 把关）' }}
              </span>
            </span>
          </div>
        </div>
        <!-- v8：被拦下时用户看到什么（v2 的四个错误码） -->
        <div class="card" style="padding:14px 20px;margin-top:10px">
          <div class="micro" style="line-height:1.8">
            学生提交被拦下时看到的是：<br>
            · 「本周已经有人点过《晴天》了，换一首吧」／「本周点歌次数已用完」<span class="tag tag-pending">40903</span><br>
            · 「这个时段已经排满了，换个时段吧」<span class="tag tag-pending">40906</span><br>
            · 「这个时段和候补队列都满了」<span class="tag tag-pending">40904</span><br>
            · 「现在不在点歌时间段（每周六 18:00 – 周日 18:00）」<span class="tag tag-pending">40907</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 点歌时间窗口（v2 新增）══════════ -->
    <div class="sec">
      <div class="sec-head">
        <span class="sec-title">点歌时间窗口</span>
        <span class="rowc gap8">
          <span class="tag" :class="auth.isSuperAdmin ? 'tag-pass' : ''">
            {{ auth.isSuperAdmin ? '仅超管可改' : '只读 · 仅超管可改' }}
          </span>
          <span class="micro">收歌截止 ≠ 审核截止（本版拆开）</span>
        </span>
      </div>
      <div class="card" style="padding:18px 20px">
        <!-- 当前状态条（深色）：规则文案与时刻全部来自服务端，前端不硬编码 -->
        <div class="tile win-tile">
          <div class="rowc wrap" style="gap:26px;align-items:flex-start">
            <div class="grow">
              <div class="win-status">
                <i class="t-dot" :class="{ idle: !win.open }"></i>
                {{ win.enabled === false ? '点歌时间不限（窗口限制已关闭）' : (win.windowText || '—') }}
              </div>
              <div class="win-cd">
                <template v-if="win.enabled === false">一直开放</template>
                <template v-else-if="win.open">开放中 · 距收歌截止 {{ fmtDur(winCd?.ms) }}</template>
                <template v-else>未开放 · 距开放 {{ fmtDur(winCd?.ms) }}</template>
              </div>
            </div>
            <div class="win-meta">
              <div>本周收歌 {{ hhmm(win.start) }} → {{ hhmm(win.end) }}</div>
              <div v-if="win.reviewAt">审核截止 {{ hhmm(win.reviewAt) }}</div>
              <div v-else-if="win.opensAt">下次开放 {{ hhmm(win.opensAt) }}</div>
            </div>
          </div>
          <div class="win-note">
            {{ win.note || '收歌截止只停止新提交；到审核截止才自动排期、驳回剩余候补并锁定本周' }}
          </div>
        </div>

        <!-- 编辑区 -->
        <div class="win-form">
          <div class="kv">
            <span class="k" style="width:132px">启用窗口限制</span>
            <span class="rowc gap13">
              <el-switch v-model="winForm.enabled" :active-value="1" :inactive-value="0" :disabled="!auth.isSuperAdmin" />
              <span class="micro">关掉 = 学生任何时间都能提交（容量与候补仍照常生效）</span>
            </span>
          </div>
          <div class="kv">
            <span class="k" style="width:132px">收歌开始</span>
            <span class="rowc gap8 wrap">
              <el-select v-model="winForm.startDay" style="width:106px" :disabled="winDisabled">
                <el-option v-for="d in win.allowedDays || []" :key="d.day" :label="d.name" :value="d.day" />
              </el-select>
              <el-time-select
                v-model="winForm.startTime" start="00:00" step="00:10" end="23:50"
                placeholder="时刻" style="width:120px" :disabled="winDisabled"
              />
              <span class="micro">从这里开始可以点歌</span>
            </span>
          </div>
          <div class="kv">
            <span class="k" style="width:132px">收歌结束</span>
            <span class="rowc gap8 wrap">
              <el-select v-model="winForm.endDay" style="width:106px" :disabled="winDisabled">
                <el-option v-for="d in win.allowedDays || []" :key="d.day" :label="d.name" :value="d.day" />
              </el-select>
              <el-time-select
                v-model="winForm.endTime" start="00:00" step="00:10" end="23:50"
                placeholder="时刻" style="width:120px" :disabled="winDisabled"
              />
              <span class="micro">到点停止收新歌，已提交的继续审核</span>
            </span>
          </div>
          <!-- 审核截止（2026-09-25 与收歌截止拆开）：null = 跟随「收歌结束 + 偏移」，保住升级前的行为 -->
          <div class="kv">
            <span class="k" style="width:132px">审核截止</span>
            <span class="rowc gap8 wrap">
              <el-select v-model="winForm.reviewDay" style="width:158px" :disabled="winDisabled">
                <el-option :label="followLabel" :value="null" />
                <el-option v-for="d in win.allowedDays || []" :key="d.day" :label="d.name" :value="d.day" />
              </el-select>
              <el-time-select
                v-model="winForm.reviewTime" start="00:00" step="00:10" end="23:50"
                placeholder="时刻" style="width:120px"
                :disabled="winDisabled || winForm.reviewDay === null"
              />
              <span class="tag tag-pass" v-if="win.reviewConfigured">已单独配置</span>
              <span class="micro">到点自动排期 + 驳回剩余候补 + 锁定本周</span>
            </span>
          </div>
          <div class="kv" style="border-bottom:none">
            <span class="k" style="width:132px">保存</span>
            <span class="rowc gap13 wrap">
              <el-button
                type="primary" size="small" class="btn-save"
                :loading="winSaving" :disabled="!auth.isSuperAdmin" @click="saveWindow"
              >
                <IconCheck :size="14" class="btn-icon" />保存窗口
              </el-button>
              <span class="micro">
                {{ auth.isSuperAdmin
                  ? '星期任选 周一 → 周日（最长可铺满整周）；审核截止不得早于收歌结束、不得晚于播出周周一 00:00'
                  : '只有超级管理员能修改点歌时间窗口（后端 40301 把关）' }}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 小程序首页（仅超管，2026-09-21） ══════════ -->
    <div class="sec" v-if="auth.isSuperAdmin">
      <div class="sec-head">
        <span class="sec-title">小程序首页</span>
        <span class="rowc gap8">
          <span class="tag tag-pass">即时生效</span>
          <span class="micro">模块开关 home_song_schedule · 缺行视为开</span>
        </span>
      </div>
      <div class="card" style="padding:8px 20px">
        <div class="kv" style="border-bottom:none">
          <span class="k" style="width:132px">展示本周点歌排期</span>
          <span class="rowc gap13">
            <el-switch
              v-model="homeScheduleOn"
              :disabled="homeScheduleSaving"
              @change="toggleHomeSchedule"
            />
            <span class="micro">
              开：小程序首页展示「本周点歌排期」（只显示已排期的歌名，<b>不含点歌人信息</b>）；
              关：区块整体不渲染，接口不下发数据
            </span>
          </span>
        </div>
      </div>
    </div>

    <!-- ══════════ 播出时段 ══════════ -->
    <div class="sec">
      <div class="sec-head">
        <span class="sec-title">播出时段（用户只能从这儿选）</span>
        <span class="rowc gap8">
          <span class="tag tag-pass">后台发布</span>
          <span class="micro">当前来源：{{ sourceText }}</span>
        </span>
      </div>
      <div class="card" style="padding:18px 20px">
        <div class="cols" style="gap:26px">
          <!-- 左：编辑区 -->
          <div style="flex:1">
            <div class="rowc" style="justify-content:space-between;margin-bottom:13px">
              <span class="field-label">每天开放的场次（最多 6 个）</span>
              <span class="micro">格式 HH:mm，保存后自动按时间排序</span>
            </div>
            <div class="stack gap13">
              <div v-for="(t, i) in slotTimes" :key="i" class="rowc gap13 slot-edit-row">
                <el-time-select
                  v-model="t.time"
                  start="06:00" step="00:10" end="22:30"
                  placeholder="选时段"
                  style="width:120px"
                />
                <el-select v-model="t.label" style="width:110px">
                  <el-option label="早间" value="早间" />
                  <el-option label="午间" value="午间" />
                  <el-option label="晚间" value="晚间" />
                </el-select>
                <span class="micro slot-label-hint">标签，用户看到的是「周一 09-21 · 早间 07:20」</span>
                <a class="link op-delete" :class="{ disabled: slotTimes.length <= 1 }" @click="removeSlot(i)">删除</a>
              </div>
            </div>
            <div class="rowc gap8" style="margin-top:13px">
              <el-button
                :disabled="!auth.isSuperAdmin || slotTimes.length >= (slotConfig?.maxSlots || 6)"
                @click="addSlot"
              >
                <IconPlus :size="15" class="btn-icon" />
                加一个时段{{ slotTimes.length >= (slotConfig?.maxSlots || 6) ? '（已达上限）' : '' }}
              </el-button>
              <el-button
                type="primary" :loading="slotSaving" :disabled="!auth.isSuperAdmin"
                @click="saveSlots"
              >
                <IconCheck :size="15" class="btn-icon" />发布时段
              </el-button>
              <span class="micro" v-if="!auth.isSuperAdmin">只读 · 播出时段由超级管理员维护</span>
            </div>
            <div class="micro" style="margin-top:11px;line-height:1.7">
              留空则退回解析「开播时间」设置，再退回默认三个。
              <b>可选日期范围固定为下一周的周一到周五</b>，不在这里改；
              每格能排几首在「排期容量与候补」里设（当前每格 <b>{{ cap.capacity || '不限' }}</b> 首）。
            </div>
          </div>

          <!-- 右：用户预览 -->
          <div style="flex:1">
            <div class="rowc" style="justify-content:space-between;margin-bottom:13px">
              <span class="field-label">
                用户会看到{{ slotConfig ? `（${slotConfig.weekStart} ~ ${slotConfig.weekEnd}）` : '' }}
              </span>
              <span class="micro">与用户端同源</span>
            </div>
            <div class="stack gap13">
              <div v-for="day in weekDays" :key="day" class="rowc gap13 slot-day-row">
                <span class="micro slot-day-label">{{ day }}</span>
                <span class="rowc gap8">
                  <span v-for="slot in slotTimes" :key="slot.time" class="chip-pick on">
                    {{ slot.label }} {{ slot.time }}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 两份注意事项 ══════════ -->
    <div class="cols">
      <!-- 点歌注意事项 -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">点歌注意事项</span>
          <span class="micro">
            v{{ noticeList[0].version }} · 已确认 <b class="num">{{ noticeList[0].ackedCount }}</b> 人
          </span>
        </div>
        <div class="card" style="padding:18px 20px">
          <el-input
            v-model="noticeList[0].content"
            type="textarea"
            :rows="6"
            placeholder="一行一条，例如：&#10;一、点歌前请确认歌曲名与歌手填写正确。&#10;二、每人每周最多点 2 次。（留空 = 不启用）"
          />
          <div class="warnline" style="margin-top:13px">
            <IconInfo :size="14" />
            <span>内容有改动才 +1 版本，<b>所有用户需重新确认</b>；只改排版不打扰用户。</span>
          </div>
          <div class="rowc" style="justify-content:flex-end;gap:8px;margin-top:13px">
            <el-button size="small">预览用户端</el-button>
            <el-button type="primary" size="small" :loading="noticeList[0].saving" @click="saveNotice(noticeList[0])">
              <IconCheck :size="14" class="btn-icon" />保存
            </el-button>
          </div>
        </div>
      </div>

      <!-- 文稿注意事项 -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">文稿注意事项</span>
          <span class="rowc gap8">
            <span class="tag tag-pass">与点歌独立</span>
            <span class="micro">
              v{{ noticeList[1].version }} · 已确认 <b class="num">{{ noticeList[1].ackedCount }}</b> 人
            </span>
          </span>
        </div>
        <div class="card" style="padding:18px 20px">
          <el-input
            v-model="noticeList[1].content"
            type="textarea"
            :rows="6"
            placeholder="一行一条，例如：&#10;一、文稿须为原创，禁止抄袭转载。&#10;二、篇幅 300~1500 字，请勿提交纯图片内容。"
          />
          <div class="micro" style="margin-top:13px;line-height:1.7">
            两份内容、版本号、确认记录<b>互相独立</b>：改文稿这份不会让点歌那批人重新确认。
          </div>
          <div class="rowc" style="justify-content:flex-end;gap:8px;margin-top:13px">
            <el-button size="small">预览用户端</el-button>
            <el-button type="primary" size="small" :loading="noticeList[1].saving" @click="saveNotice(noticeList[1])">
              <IconCheck :size="14" class="btn-icon" />保存
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 危险区（仅超管） ══════════ -->
    <div class="sec danger-sec" v-if="auth.isSuperAdmin">
      <div class="sec-head">
        <span class="sec-title danger-title">危险区</span>
        <span class="rowc gap8">
          <span class="tag tag-danger">仅超级管理员</span>
          <span class="micro">服务端校验（40301）</span>
        </span>
      </div>
      <div class="card dangerzone" style="padding:18px 20px">
        <div class="rowc danger-row">
          <div class="grow">
            <div class="dz-title">一键清空全部点歌数据</div>
            <div class="dz-desc">
              删除<b>全部点歌记录</b>，<b>不可恢复</b>；文稿、注意事项确认记录、学生账号一概不动。
              v2 起容量与候补都是<b>实时统计</b>（直接数投稿记录），没有独立的名额计数器，
              所以清空数据 = 容量占用与候补队列自然归零，个人每周次数随之归零。
            </div>
            <div class="dz-desc muted">
              普通管理员调用此接口返回 40301；按钮对普通管理员不渲染 —— 显隐只是体验，边界在服务端。
            </div>
          </div>
          <div class="dz-action">
            <el-button type="danger" :loading="purging" @click="purgeSongs">清空全部点歌数据</el-button>
            <div class="dz-hint">点击后需输入 DELETE 二次确认</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import {
  IconCheck, IconPlus, IconRefresh, IconInfo,
} from '@/components/icons';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const hhmm = (iso) => (iso ? dayjs(iso).format('MM-DD HH:mm') : '—');
/** 进度条宽度（数字版；0 或未设上限按 0% 处理） */
function pctOf(used, limit) {
  if (!limit) return '0%';
  const r = Math.min((Number(used) || 0) / Number(limit), 1);
  return `${Math.round(r * 100)}%`;
}
/** 毫秒 → 「2 小时 15 分」 */
function fmtDur(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/* ─────────── 本地时钟（窗口倒计时） ─────────── */
const nowTs = ref(Date.now());
let ticker = null;

/* ─────────── v2：排期容量与候补 ─────────── */
const cap = ref({ capacity: 0, weekCapacity: 0, queue: {}, window: null, finalizeAt: null });
const queue = computed(() => cap.value.queue || {});
const capForm = reactive({ capacity: 0, queueLimit: 0 });
/** 每格正式位 0 = 不限（songQueueService.weekCapacity 的口径）——别照字面显示成 0 */
const capUnlimited = computed(() => !Number(cap.value.capacity));
/** 候补自动上限 = 正式位总数；正式位不限时队列同样不限 */
const queueUnlimited = computed(() => !!queue.value.limitAuto && capUnlimited.value);
const capSaving = ref(false);
const sweeping = ref(false);

/* 已占位 / 补位待审的口径只能从排期矩阵拿（/capacity 只给上限） */
const sched = ref({ days: [], capacity: 0, weekCapacity: 0, rangeText: '' });
const allSlots = computed(() => (sched.value.days || []).flatMap((d) => d.slots || []));
const gridCount = computed(() => allSlots.value.length);
const seatedTotal = computed(() => allSlots.value.reduce((n, s) => n + (s.seated || 0), 0));
const promotedCount = computed(() => allSlots.value.reduce((n, s) => n + (s.promoted || 0), 0));

async function fetchCapacity() {
  cap.value = await http.get('/admin/submit/capacity');
  capForm.capacity = cap.value?.capacity ?? 0;
  capForm.queueLimit = cap.value?.queue?.limitAuto ? 0 : (cap.value?.queue?.limit ?? 0);
}
async function fetchSchedule() {
  sched.value = await http.get('/admin/submit/schedule');
}
async function saveCapacity() {
  // 同 saveRules：el-input-number 清空时是 undefined，键会被 JSON 丢掉 → 后端保留旧值却弹「已更新」
  const c = Number(capForm.capacity);
  const q = Number(capForm.queueLimit);
  if (!Number.isFinite(c) || !Number.isFinite(q)) {
    ElMessage.warning('请填写每格正式位与候补上限（0 分别表示不限 / 自动）');
    return;
  }
  capSaving.value = true;
  try {
    const snap = await http.put('/admin/submit/quota', {
      capacity: Math.max(0, Math.floor(c)),
      queueLimit: Math.max(0, Math.floor(q)),
    });
    cap.value = { ...cap.value, queue: snap || cap.value.queue };
    await Promise.all([fetchCapacity(), fetchSchedule()]);
    ElMessage.success('容量与候补上限已更新');
  } finally { capSaving.value = false; }
}
async function sweepQueue() {
  sweeping.value = true;
  try {
    const r = await http.post('/admin/submit/queue/sweep');
    await Promise.all([fetchCapacity(), fetchSchedule()]);
    ElMessage.success(
      `已执行：递补 ${r?.promoted ?? 0} 条 · 满额清队 ${r?.closed ?? 0} 条 · 定稿清理 ${r?.weeks ?? 0} 周`,
    );
  } finally { sweeping.value = false; }
}

/* ─────────── v2：点歌时间窗口 ─────────── */
const win = ref({});
const winForm = reactive({
  enabled: 0, startDay: 6, startTime: '18:00', endDay: 0, endTime: '18:00',
  // null = 「跟随收歌结束 + 偏移」档位（升级前的旧行为，保持不变）
  reviewDay: null, reviewTime: '22:00',
});
const winSaving = ref(false);
/** 非超管或未启用窗口 → 表单只读 */
const winDisabled = computed(() => !auth.isSuperAdmin || !Number(winForm.enabled));

/** 「跟随收歌结束 + 偏移」档位的文案：偏移分钟数由服务端下发，前端不硬编码 360 */
const followLabel = computed(() => {
  const m = Number(win.value?.followOffsetMinutes);
  if (!Number.isFinite(m) || m <= 0) return '跟随收歌结束';
  const h = m / 60;
  return `跟随收歌结束 + ${Number.isInteger(h) ? `${h} 小时` : `${m} 分钟`}`;
});

const winCd = computed(() => {
  const w = win.value;
  if (w.enabled === false) return null;
  const target = w.open ? w.closesAt : w.opensAt;
  if (!target) return null;
  return { ms: new Date(target).getTime() - nowTs.value };
});

function fillWinForm(d) {
  const cfg = d?.config || {};
  winForm.enabled = cfg.enabled === undefined ? 0 : Number(cfg.enabled);
  winForm.startDay = Number(cfg.startDay ?? 6);
  winForm.startTime = cfg.startTime || '18:00';
  winForm.endDay = Number(cfg.endDay ?? 0);
  winForm.endTime = cfg.endTime || '18:00';
  // ⚠️ 未单独配置时必须回 null（下拉落在「跟随…」档），不能拿服务端推导出的生效值冒充配置值 ——
  //    否则管理员只是改了收歌时间、顺手保存，就把「收歌结束 + 偏移」固化成具体时刻，行为悄悄变了
  winForm.reviewDay = cfg.reviewDay === null || cfg.reviewDay === undefined ? null : Number(cfg.reviewDay);
  winForm.reviewTime = cfg.reviewTime || '22:00';
}
async function fetchWindow() {
  win.value = await http.get('/admin/submit/window');
  fillWinForm(win.value);
}
async function saveWindow() {
  if (Number(winForm.enabled) && (!winForm.startTime || !winForm.endTime)) {
    ElMessage.warning('请填写收歌开始与结束时刻（HH:mm）');
    return;
  }
  if (Number(winForm.enabled) && winForm.reviewDay !== null && !winForm.reviewTime) {
    ElMessage.warning('请填写审核截止时刻（HH:mm）');
    return;
  }
  winSaving.value = true;
  try {
    win.value = await http.put('/admin/submit/window', {
      enabled: Number(winForm.enabled) ? 1 : 0,
      startDay: Number(winForm.startDay),
      startTime: winForm.startTime,
      endDay: Number(winForm.endDay),
      endTime: winForm.endTime,
      // null 是合法档位（跟随收歌结束 + 偏移），后端不会当非法值拒掉
      reviewDay: winForm.reviewDay === null ? null : Number(winForm.reviewDay),
      reviewTime: winForm.reviewTime || null,
    });
    fillWinForm(win.value);
    await Promise.all([fetchCapacity(), fetchSchedule()]);
    ElMessage.success(`点歌时间已更新：${win.value?.windowText || '—'}（审核截止 ${win.value?.reviewText || '—'}）`);
  } finally { winSaving.value = false; }
}

/* ─────────── 提交规则 ─────────── */
const ruleForm = reactive({ weeklyUserLimit: 2, dupBlock: 1 });
const ruleSaving = ref(false);

async function fetchRules() {
  const data = await http.get('/admin/submit/rules');
  ruleForm.weeklyUserLimit = data.weeklyUserLimit;
  ruleForm.dupBlock = data.dupBlock;
}
async function saveRules() {
  // ⚠️ el-input-number 被「清空」时是 undefined：JSON.stringify 会丢掉这个键，
  // 后端就保留旧值，但页面照样弹「已更新」——管理员以为改成 0 了其实没改（2026-09-19 实际踩过）。
  const n = Number(ruleForm.weeklyUserLimit);
  if (!Number.isFinite(n) || ruleForm.weeklyUserLimit === null || ruleForm.weeklyUserLimit === undefined || ruleForm.weeklyUserLimit === '') {
    ElMessage.warning('请填写每人每周点歌次数（0 表示不限）');
    return;
  }
  ruleSaving.value = true;
  try {
    const data = await http.put('/admin/submit/rules', {
      weeklyUserLimit: Math.max(0, Math.floor(n)), dupBlock: ruleForm.dupBlock,
    });
    if (data) {
      ruleForm.weeklyUserLimit = data.weeklyUserLimit;
      ruleForm.dupBlock = data.dupBlock;
    }
    ElMessage.success(
      data?.weeklyUserLimit === 0
        ? '规则已更新：每人每周点歌不限次数，立即生效'
        : `规则已更新：每人每周最多 ${data?.weeklyUserLimit} 次，立即生效`
    );
  } finally { ruleSaving.value = false; }
}

/* ─────────── 播出时段 ─────────── */
const slotTimes = ref([]);
const slotConfig = ref(null);
const slotSaving = ref(false);

const SOURCE_LABEL = {
  custom: '你发布的',
  schedule: '播出台词解析',
  default: '默认时段',
};
const sourceText = computed(() => SOURCE_LABEL[slotConfig.value?.source] || '—');

/** 视觉稿右侧预览：根据 slotConfig.weekStart 算下一周周一~周五 */
const weekDays = computed(() => {
  const start = slotConfig.value?.weekStart;
  if (!start) return ['周一', '周二', '周三', '周四', '周五'];
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return ['周一', '周二', '周三', '周四', '周五'];
  return Array.from({ length: 5 }, (_, i) => {
    const cur = new Date(d);
    cur.setDate(d.getDate() + i);
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    const dd = String(cur.getDate()).padStart(2, '0');
    const wk = ['周一', '周二', '周三', '周四', '周五'][i];
    return `${wk} ${mm}-${dd}`;
  });
});

async function fetchSlots() {
  // GET 走 /admin/submit/timeslots（/submit/slots 只注册了 PUT，GET 会被 /submit/:id 吃掉）
  slotConfig.value = await http.get('/admin/submit/timeslots');
  slotTimes.value = (slotConfig.value?.times || []).map((t) => ({ time: t.time, label: t.label || '' }));
}
function addSlot() {
  slotTimes.value.push({ time: '', label: '午间' });
}
function removeSlot(i) {
  slotTimes.value.splice(i, 1);
}
async function saveSlots() {
  const times = slotTimes.value
    .map((t) => ({ time: (t.time || '').trim(), label: t.label }))
    .filter((t) => t.time);
  if (!times.length) return ElMessage.warning('至少要有一个时段');
  slotSaving.value = true;
  try {
    // ⚠️ 不再传 capacity —— v2 里「每格正式位」统一在「排期容量与候补」段维护，
    //    这里传了就会变成第二个入口，两边改同一个值容易互相覆盖。
    slotConfig.value = await http.put('/admin/submit/slots', { times });
    slotTimes.value = (slotConfig.value?.times || []).map((t) => ({ time: t.time, label: t.label || '' }));
    await fetchSchedule();   // 时段变了 → 格子数变 → 下周正式位跟着变
    ElMessage.success('已发布，用户端立即生效');
  } finally { slotSaving.value = false; }
}

/* ─────────── 注意事项 ─────────── */
const noticeList = ref([
  { type: 'song', label: '点歌注意事项', content: '', version: 0, ackedCount: 0, saving: false },
  { type: 'article', label: '文稿注意事项', content: '', version: 0, ackedCount: 0, saving: false },
]);

async function fetchNotices() {
  const data = await http.get('/admin/submit/notice');
  noticeList.value.forEach((nt) => {
    const one = data?.[nt.type];
    if (one) {
      nt.content = one.content;
      nt.version = one.version;
      nt.ackedCount = one.ackedCount;
    }
  });
}
async function saveNotice(nt) {
  nt.saving = true;
  try {
    const data = await http.put('/admin/submit/notice', { content: nt.content, type: nt.type });
    nt.version = data.version;
    nt.ackedCount = data.ackedCount;
    if (data.bumped) ElMessage.success(`${data.label}已保存，版本号 +1（所有用户需重新确认）`);
    else ElMessage.success('内容没有变化，版本号保持不变');
  } finally { nt.saving = false; }
}

/* ─────────── 危险区：一键清空点歌数据 ─────────── */
const purging = ref(false);

async function purgeSongs() {
  const { value } = await ElMessageBox.prompt(
    '将删除全部点歌记录，不可恢复；文稿与注意事项确认记录不受影响。请输入 DELETE 确认。',
    '清空全部点歌数据',
    {
      type: 'error',
      confirmButtonText: '确认清空',
      cancelButtonText: '取消',
      inputPattern: /^DELETE$/,
      inputErrorMessage: '请原样输入 DELETE',
    }
  );
  purging.value = true;
  try {
    const data = await http.delete('/admin/submit/songs', { data: { confirm: value } });
    ElMessage.success(`已清空 ${data?.deletedSongs ?? 0} 条点歌数据，文稿不受影响`);
    await Promise.allSettled([fetchCapacity(), fetchSchedule(), fetchNotices()]);
  } finally { purging.value = false; }
}

/* ─────────── 小程序首页：本周点歌排期开关（home_song_schedule） ─────────── */
const homeScheduleOn = ref(true);
const homeScheduleSaving = ref(false);

async function fetchHomeScheduleSwitch() {
  const data = await http.get('/admin/switch/list');
  const row = (data?.list || []).find((s) => s.key === 'home_song_schedule');
  homeScheduleOn.value = !row || row.value !== 'off';   // 缺行视为开（与后端 isEnabled 同口径）
}

async function toggleHomeSchedule(v) {
  homeScheduleSaving.value = true;
  try {
    await http.put('/admin/switch/home_song_schedule', { value: v ? 'on' : 'off' });
    ElMessage.success(v ? '已开启：小程序首页展示本周点歌排期' : '已关闭：小程序首页不再展示本周点歌排期');
  } catch (e) {
    homeScheduleOn.value = !v;   // http 拦截器对业务错误只 reject 不弹，这里自己回滚 + 提示
    ElMessage.error(e.message || '保存失败，请重试');
  } finally {
    homeScheduleSaving.value = false;
  }
}

onMounted(() => {
  fetchCapacity().catch(() => {});
  fetchSchedule().catch(() => {});
  fetchWindow().catch(() => {});
  fetchRules().catch(() => {});
  fetchSlots().catch(() => {});
  fetchNotices().catch(() => {});
  fetchHomeScheduleSwitch().catch(() => {});
  ticker = setInterval(() => { nowTs.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
});
</script>

<style scoped>
.song-settings {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* v8 子页返回入口 */
.back-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.back-link {
  font-size: var(--fs-md); font-weight: 600; color: var(--accent);
  cursor: pointer;
}
.back-link:hover { text-decoration: underline; }

/* ══════════ 视觉稿通用件（来自 preview/admin-ui-v8） ══════════ */
.sec { display: flex; flex-direction: column; gap: 13px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; flex-wrap: wrap; }
.sec-title {
  font-size: var(--fs-xl); font-weight: 600;
  letter-spacing: var(--ls-tight-sm); line-height: var(--lh-xl);
}
.danger-title { color: var(--red-fg); }

.cols { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
.cols > * { min-width: 0; }
.grow { flex: 1; min-width: 0; }

.card {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
}
.rowc { display: flex; align-items: center; }
.wrap { flex-wrap: wrap; }
.stack { display: flex; flex-direction: column; }
.gap8 { gap: 8px; }
.gap13 { gap: 13px; }

.kv {
  display: flex;
  align-items: center;
  font-size: var(--fs-md);
  padding: 13px 0;
  border-bottom: 1px solid var(--divider);
}
.kv:last-child { border-bottom: none; }
.kv .k {
  width: 132px; flex: none;
  color: var(--muted);
  font-size: var(--fs-sm);
}

.field-label {
  font-size: var(--fs-sm); font-weight: 500;
  color: var(--muted);
  letter-spacing: var(--ls-wide);
}

.bar {
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--divider);
  overflow: hidden;
  margin-top: 9px;
}
.bar i {
  display: block; height: 100%;
  border-radius: var(--r-pill);
  background: var(--accent);
  transition: width 0.3s var(--ease);
}

.chip-pick {
  height: 28px; padding: 0 12px;
  border-radius: var(--r-pill);
  background: #fff;
  border: 1px solid var(--hairline);
  font-size: var(--fs-sm);
  color: var(--ink-2);
  display: inline-flex; align-items: center;
}
.chip-pick.on {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
  background: #f4f9ff;
}

.warnline {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: var(--fs-xs);
  color: var(--red-fg);
  background: var(--red-bg);
  border-radius: 10px;
  padding: 10px 12px;
  line-height: 1.6;
}
.warnline :deep(svg) { flex-shrink: 0; margin-top: 2px; }

/* 视觉稿小标签：pass / danger / pending（与 el-tag 区分，不走 Element 主题） */
.tag {
  display: inline-flex; align-items: center; height: 22px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  letter-spacing: var(--ls-wide-sm);
  background: var(--divider);
  color: var(--muted-2);
  margin-right: 6px;
}
.tag-pass { background: var(--acc-bg); color: var(--accent); }
.tag-danger { background: var(--red-bg); color: var(--red-fg); }
.tag-pending { background: var(--amber-bg); color: var(--amber-fg); }

.num { font-variant-numeric: tabular-nums; }
.micro {
  font-size: var(--fs-xs);
  color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}

/* ══════════ 排期容量段：用量 2×2 网格 ══════════ */
.quota-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px 26px;
  margin-bottom: 16px;
}
.quota-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.quota-item-text {
  display: flex; flex-direction: row; justify-content: space-between; align-items: baseline;
  gap: 8px;
}
.quota-num {
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--ink);
}
.quota-edit {
  display: flex; flex-direction: column; gap: 13px;
  margin-top: 4px;
}
.quota-fields { display: flex; gap: 18px; }
.quota-fields > .field { flex: 1; min-width: 0; }
.quota-fields :deep(.el-input-number) { width: 100%; }
.quota-buttons {
  display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end;
}
.quota-buttons .btn-save { min-width: 96px; }
.quota-buttons .btn-sweep { min-width: 156px; }

/* ══════════ 点歌时间窗口 ══════════ */
.win-tile {
  flex-direction: column; gap: 10px;
  padding: 16px 20px; margin-bottom: 16px;
}
.win-status { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.84); }
.t-dot {
  width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--live); box-shadow: 0 0 8px rgba(255, 69, 58, 0.7);
}
.t-dot.idle { background: rgba(255, 255, 255, 0.34); box-shadow: none; }
.win-cd { font-size: 22px; font-weight: 600; color: #fff; letter-spacing: var(--ls-tight-sm); margin-top: 6px; }
.win-meta {
  flex: none; min-width: 190px;
  font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.62);
  line-height: 1.9; letter-spacing: var(--ls-wide-sm);
  font-variant-numeric: tabular-nums;
}
.win-note {
  font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.52);
  line-height: 1.7; letter-spacing: var(--ls-wide-sm);
  border-top: 1px solid rgba(255, 255, 255, 0.14); padding-top: 10px;
}

/* ══════════ 时段段：编辑行 ══════════ */
.slot-edit-row { align-items: center; }
.slot-label-hint {
  color: var(--muted-2);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op-delete { margin-left: auto; flex: none; }
.op-delete.disabled {
  color: var(--soft);
  cursor: not-allowed;
  pointer-events: none;
}
.link { font-size: var(--fs-sm); color: var(--accent); font-weight: 500; cursor: pointer; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.slot-day-row { align-items: center; min-height: 28px; }
.slot-day-label { width: 86px; flex: none; }

/* ══════════ 危险区 ══════════ */
.danger-sec .sec-title { color: var(--red-fg); }
.dangerzone { border-color: #f0c4c0; }
.danger-row { gap: 24px; align-items: flex-start; }
.dz-title {
  font-size: var(--fs-md); font-weight: 600;
  color: var(--red-fg);
}
.dz-desc {
  margin-top: 6px;
  font-size: var(--fs-sm);
  color: var(--ink-2);
  line-height: 1.7;
}
.dz-desc.muted {
  color: var(--muted);
  font-size: var(--fs-xs);
  margin-top: 8px;
}
.dz-action {
  flex-shrink: 0;
  text-align: right;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
}
.dz-hint { font-size: var(--fs-xs); color: var(--red-fg); }

/* 按钮：图标与文字对齐 */
.btn-icon { margin-right: 5px; vertical-align: -2px; }
</style>
