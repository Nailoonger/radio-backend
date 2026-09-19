<template>
  <div class="submit-page">
    <!-- ══════════ 点歌设置摘要（v8：浅色卡 + 胶囊摘要，设置项都在「点歌设置」屏） ══════════ -->
    <div class="summary-card">
      <span class="rowc gap8">
        <span class="tag tag-amber">今日名额</span>
        <span class="micro">
          <b class="num">{{ quota.dailyUsed }}</b>/{{ quota.dailyLimit || '不限' }}<template v-if="quota.dailyLimit"> · 还剩 {{ Math.max(quota.dailyLimit - quota.dailyUsed, 0) }}</template>
        </span>
      </span>
      <span class="rowc gap8">
        <span class="tag tag-mute">本周</span>
        <span class="micro"><b class="num">{{ quota.weeklyUsed }}</b>/{{ quota.weeklyLimit || '不限' }}</span>
      </span>
      <span class="micro">
        每人每周最多 <b>{{ rule.weeklyUserLimit === 0 ? '不限' : rule.weeklyUserLimit }}</b> 次 · 同一首歌一周内{{ rule.dupBlock ? '不可重复' : '可重复' }}
      </span>
      <span class="rowc gap8">
        <span class="tag tag-outline">下周排期</span>
        <span class="micro">
          <b class="num">{{ schedule.totalPending }}</b> 首待审<template v-if="schedule.rangeText"> · {{ schedule.rangeText }}</template>
        </span>
        <a class="link" @click="openSchedule">查看排期 ›</a>
      </span>
      <span class="s-right">
        <span class="tag tag-reject" v-if="quota.exhausted">名额已满 · 剩余待审将自动驳回</span>
        <span class="tag tag-pass" v-else>名额未满</span>
        <a class="link" @click="goSettings">去「点歌设置」改 ›</a>
      </span>
    </div>

    <!-- 下周待审提醒（审核即排期：请在周日 18:00 前审完，下周排期即完整） -->
    <div class="slot-remind" v-if="schedule.totalPending > 0">
      <IconInfo :size="15" />
      <span>
        下周排期还有 <b class="num">{{ schedule.totalPending }}</b> 首待审 · 请在<b>周日 18:00 前</b>审完，下一周一到周五的排期即完整
      </span>
      <a class="link" @click="openSchedule">去处理 ›</a>
    </div>

    <!-- ══════════ 工具栏（v8：独立一行，不套卡片） ══════════ -->
    <div class="toolbar">
        <div class="seg">
          <button
            v-for="t in typeSegs" :key="t.label"
            class="seg-item" :class="{ on: query.type === t.v }"
            @click="setType(t.v)"
          >{{ t.label }}</button>
        </div>

        <div class="chips">
          <button
            v-for="c in statusChips" :key="c.label"
            class="chip" :class="{ on: query.status === c.v }"
            @click="setStatus(c.v)"
          >{{ c.label }} <em class="num">{{ c.n }}</em></button>
          <button type="button" class="chip on chip-slot" v-if="query.slot" @click="clearSlot">
            {{ slotLabel }} <em>✕</em>
          </button>
        </div>

        <div class="tb-right">
          <el-input
            v-model="query.keyword" placeholder="搜索歌名 / 文稿标题 / 投稿人"
            clearable style="width: 230px;" @keyup.enter="search"
          >
            <template #prefix><IconSearch :size="15" /></template>
          </el-input>
          <el-button @click="exportCsv">导出</el-button>
        </div>
      </div>

      <!-- ══════════ 列表 ══════════ -->
      <!-- 加载 = v8 表格骨架（圆角表格卡内），老的转圈 loading 已删 -->
      <div class="table-card" v-if="loading">
        <div class="sk-row" v-for="i in 6" :key="i">
          <span class="sk" style="width:16px;height:16px"></span>
          <span class="sk sk-title" :style="{ width: 30 + (i % 4) * 9 + '%' }"></span>
          <span class="sk sk-text" style="width:11%"></span>
          <span class="sk sk-text" style="width:12%"></span>
          <span class="sk sk-tag" style="width:56px;margin-left:auto"></span>
        </div>
      </div>

      <div class="table-card" v-else>
      <el-table
        :data="rows"
        @selection-change="(r) => (selection = r)"
        @row-dblclick="openConsole"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column label="内容" min-width="300">
          <template #default="{ row }">
            <div class="cell-content">
              <!-- v8：描边类型胶囊与标题同行，摘要在下（micro 单行截断） -->
              <div class="rowc gap8">
                <span class="tag tag-outline">{{ row.type === 1 ? '点歌' : '文稿' }}</span>
                <span class="c-strong el">
                  <template v-if="row.type === 1">{{ row.songName }} <span class="c-sep">·</span> {{ row.singer }}</template>
                  <template v-else>{{ row.articleTitle }}</template>
                </span>
              </div>
              <div class="c-sub el">{{ row.type === 1 ? (row.wishContent || '（没有留言）') : (row.articleContent || '—') }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="投稿人" width="150">
          <template #default="{ row }">
            <div class="user-cell">
              <span class="avatar-fallback">{{ (row.nickname || '?').charAt(0) }}</span>
              <span class="c-ellipsis">{{ row.nickname || '匿名' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="提交时间" width="118">
          <template #default="{ row }"><span class="c-time">{{ fmt(row.createTime).slice(5) }}</span></template>
        </el-table-column>
        <!-- ⚠️ 审核人 ≠ 投稿人：投稿人在上一列，这里显示是谁审的、什么时候审的 -->
        <el-table-column label="审核人 / 时间" width="142">
          <template #default="{ row }">
            <span class="micro" v-if="row.status === 0">—</span>
            <div class="user-cell" v-else>
              <span class="avatar-fallback" :class="{ sys: row.autoRejected }">{{ (row.reviewerName || '系').charAt(0) }}</span>
              <div class="rv-stack">
                <div class="micro el" :class="{ 'is-sys': row.autoRejected }">{{ row.reviewerName || '系统' }}</div>
                <div class="micro el num">{{ row.reviewTime ? fmt(row.reviewTime).slice(5) : '' }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="106" align="center">
          <template #default="{ row }">
            <StatusTag :status="row.status" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="182" fixed="right" align="right">
          <template #default="{ row }">
            <div class="op-cell">
              <!-- 待审：通过 / 驳回 -->
              <template v-if="row.status === 0">
                <el-button size="small" type="primary" @click="approve(row)">通过</el-button>
                <el-button size="small" @click="reject(row)">驳回</el-button>
              </template>
              <!-- 已处理：撤销 / 处理（打开处理台） -->
              <template v-else>
                <el-button size="small" @click="revoke(row)">撤销</el-button>
                <el-button size="small" type="primary" @click="openConsole(row, true)">处理</el-button>
              </template>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <EmptyState variant="review" title="暂无投稿" description="小程序端有新的点歌或文稿投稿时，会出现在这里" />
        </template>
      </el-table>
      </div>

      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        class="pager"
        @current-change="fetch"
        @size-change="fetch"
      />

    <!-- ══════════ 批量操作条（选中后才浮出） ══════════ -->
    <div class="sel-bar" v-if="selection.length">
      <span class="sel-count">已选 <b class="num">{{ selection.length }}</b> 条</span>
      <span class="sel-hint">驳回要求填写原因</span>
      <el-button type="primary" @click="batchApprove">批量通过</el-button>
      <el-button @click="batchReject">批量驳回</el-button>
      <el-button text @click="clearSelection">取消选择</el-button>
    </div>

    <!-- ══════════ 审核处理台（v8 屏 3：浮在页面上的卡片，不是全屏） ══════════ -->
    <el-dialog
      v-model="consoleVisible"
      width="1010px" top="7vh"
      :show-close="false" :close-on-click-modal="false"
      class="console-dialog"
    >
      <template #header>
        <div class="cs-head">
          <div class="cs-head-left">
            <!-- v8 屏 6：头部补类型 tag + 副标题「来自小程序投稿页」 -->
            <span class="cs-type-tag" v-if="consoleRow">
              {{ consoleRow.type === 1 ? '点歌' : '文稿' }}
            </span>
            <span class="cs-title">审核处理台</span>
            <span class="cs-sub">
              第 {{ consoleIndex + 1 }} / {{ consoleRows.length }} 条待审
            </span>
          </div>
          <el-button text circle @click="closeConsole"><IconClose :size="16" /></el-button>
        </div>
        <div class="cs-head-sub micro" v-if="consoleRow">
          #{{ consoleRow.id }} · {{ fmt(consoleRow.createTime) }} 提交 · 来自小程序投稿页
        </div>
      </template>

      <div class="cs-body" v-if="consoleRow">
        <!-- 左：投稿人 + 内容 -->
        <div class="cs-left">
          <!-- 投稿人画像：v8 方案原样·单块深色胶囊，上段头像姓名 + 下段三列（左对齐） -->
          <div class="cs-person">
            <!-- 上半段：头像 + 姓名班级（左） + 身份 tag（右，方案 chip 位置） -->
            <div class="cs-person-row">
              <span class="cs-avatar">{{ (consoleDetail?.submitter?.nickname || consoleRow.nickname || '?').charAt(0) }}</span>
              <div class="cs-person-main">
                <div class="cs-person-name">
                  {{ consoleDetail?.submitter?.nickname || consoleRow.nickname || '匿名' }}
                </div>
                <div class="cs-person-sub">
                  <template v-if="consoleDetail?.submitter">
                    {{ consoleDetail.submitter.className || '未分班' }}
                    <span class="cs-dot">·</span> 本次第 {{ consoleDetail.submitter.total || 1 }} 次投稿
                  </template>
                  <template v-else>学号 {{ consoleRow.studentNo || consoleRow.openid || '—' }}</template>
                </div>
              </div>
              <div class="cs-person-tags">
                <el-tag size="small" effect="dark" :type="consoleDetail?.submitter?.isAccount ? 'primary' : 'info'" class="cs-idtag">
                  {{ consoleDetail?.submitter?.isAccount ? '学号账号' : '微信用户' }}
                </el-tag>
                <el-tag v-if="consoleDetail?.submitter?.status === 0" size="small" type="danger" effect="dark">已停用</el-tag>
              </div>
            </div>
            <!-- 已处理条目的审核人一行（待审不显示） -->
            <div class="cs-reviewer" v-if="consoleRow.status !== 0">
              审核人 <b>{{ consoleRow.reviewerName || '—' }}</b>
              <span class="cs-dot">·</span> {{ consoleRow.reviewTime ? fmt(consoleRow.reviewTime) : '—' }}
            </div>

            <!-- 下半段：历史通过 / 历史驳回 / 首次投稿（方案原值：label 13px #d1d1d6 · 数字 22px · 首投 18px） -->
            <div class="cs-person-stats" v-if="consoleDetail?.submitter">
              <div class="cs-stat">
                <div class="cs-stat-label">历史通过</div>
                <div class="cs-stat-num num">{{ consoleDetail.submitter.approved }}</div>
              </div>
              <div class="cs-stat">
                <div class="cs-stat-label">历史驳回</div>
                <div class="cs-stat-num num">{{ consoleDetail.submitter.rejected }}</div>
              </div>
              <div class="cs-stat">
                <div class="cs-stat-label">首次投稿</div>
                <div class="cs-stat-num cs-stat-date">
                  {{ consoleDetail.submitter.firstAt ? mmdd(consoleDetail.submitter.firstAt) : '—' }}
                </div>
              </div>
            </div>
          </div>

          <div class="cs-card">
            <div class="cs-card-head">
              <span>投稿内容（{{ consoleRow.type === 1 ? '点歌' : '文稿' }}）</span>
              <span class="micro" v-if="consoleRow.type === 1 && consoleSlotCell">
                播出时段 {{ consoleRow.wantBroadcastTime }}
                · 该时段已排 <b class="num">{{ consoleSlotCell.approved }}</b>/{{ consoleSlotCell.capacity || '不限' }}<template v-if="consoleSlotCell.capacity && !consoleSlotCell.full"> · 还可排 {{ Math.max(consoleSlotCell.capacity - consoleSlotCell.approved, 0) }}</template><template v-if="consoleSlotCell.full"> · 已排满</template>
              </span>
              <span class="micro" v-else>完整内容，不做截断</span>
            </div>
            <div class="cs-fields" v-if="consoleRow.type === 1">
              <div class="cs-field"><span class="cs-k">歌曲</span><span class="cs-v">{{ consoleRow.songName }} · {{ consoleRow.singer }}</span></div>
              <div class="cs-field"><span class="cs-k">希望播出时段</span><span class="cs-v">{{ consoleRow.wantBroadcastTime || '—' }}</span></div>
              <div class="cs-field"><span class="cs-k">想说的话</span><span class="cs-v pre-wrap">{{ consoleRow.wishContent || '（没有留言）' }}</span></div>
            </div>
            <div class="cs-fields" v-else>
              <div class="cs-field"><span class="cs-k">标题</span><span class="cs-v">{{ consoleRow.articleTitle }}</span></div>
              <div class="cs-field"><span class="cs-k">正文</span><span class="cs-v pre-wrap read">{{ consoleRow.articleContent }}</span></div>
              <div class="cs-field" v-if="consoleRow.articleContent">
                <span class="cs-k">&nbsp;</span>
                <span class="micro">
                  共 {{ consoleRow.articleContent.length }} 字 ·
                  预计播音 {{ Math.max(1, Math.round(consoleRow.articleContent.length / 250)) }} 分
                  {{ Math.round((consoleRow.articleContent.length % 250) / 250 * 60) }} 秒
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 右：处理 -->
        <div class="cs-right">
          <div class="cs-card">
            <div class="cs-card-head"><span>处理结果</span></div>

            <div class="cs-actions">
              <el-button class="cs-approve" :loading="acting" @click="consoleApprove">通过</el-button>
              <el-button class="cs-reject" :class="{ on: rejectMode }" @click="rejectMode = true">驳回</el-button>
            </div>

            <div class="cs-quota">
              <div class="cs-quota-row">
                <span>今日名额</span>
                <b class="num">
                  {{ quota.dailyUsed }} / {{ quota.dailyLimit || '不限' }}
                  <span class="micro" v-if="quota.dailyLimit">· 还剩 {{ Math.max(quota.dailyLimit - quota.dailyUsed, 0) }}</span>
                </b>
              </div>
              <div class="bar" style="margin-top:8px" v-if="quota.dailyLimit">
                <i :style="{ width: pct(quota.dailyUsed, quota.dailyLimit) }" />
              </div>
              <div class="cs-quota-note">
                {{ quota.dailyLimit && quota.dailyUsed >= quota.dailyLimit
                  ? '名额已满：通过将不占名额（该条会被系统自动驳回）'
                  : '通过会占用一个名额（日 + 周一各一）' }}
              </div>
            </div>

            <!-- v8 屏 6：处理结果补充说明（与驳回原因/审核记录上下衔接） -->
            <div class="micro cs-extra-note" style="line-height:1.7">
              通过 = 写入审核人与审核时间，投稿人能看到「已通过」；<br>
              点歌类还会多一个动作：<b>排入某档节目</b>
              （需 <code>submit.program_id</code>，见「数据来源」屏）。
            </div>

            <!-- 驳回原因（必填） -->
            <div class="cs-reject-box" :class="{ off: !rejectMode }">
              <div class="cs-reject-head">
                <span>驳回原因</span>
                <span class="tag tag-reject cs-reject-required">必填</span>
              </div>
              <div class="cs-presets">
                <button
                  v-for="r in rejectPresets" :key="r"
                  class="preset" :class="{ on: rejectReason === r }"
                  @click="rejectReason = r; rejectMode = true"
                >{{ r }}</button>
              </div>
              <el-input
                v-model="rejectReason" type="textarea" :rows="3"
                placeholder="也可自定义原因，写清楚便于投稿人理解"
                @focus="rejectMode = true"
              />
              <div class="warnline" style="margin-top:10px">
                <IconInfo :size="14" />
                <span>原因会原样展示给投稿人（小程序「我的投稿」里可见），写清理由再驳回。</span>
              </div>
              <div class="micro cs-reject-disabled-hint">
                未填原因时「确认驳回」置灰，不可点。
              </div>
            </div>

            <!-- v8 屏 6：审核记录卡（右侧底部，固定位置） -->
            <div class="cs-history">
              <div class="cs-history-head">审核记录</div>
              <div class="cs-history-card">
                <template v-if="Number(consoleRow.status) === 0">
                  <div class="micro">本条目尚未处理。</div>
                </template>
                <template v-else>
                  <div class="cs-history-line">
                    <span class="cs-history-k">审核人</span>
                    <span>{{ consoleRow.reviewerName || '—' }}</span>
                  </div>
                  <div class="cs-history-line">
                    <span class="cs-history-k">审核时间</span>
                    <span class="num">{{ consoleRow.reviewTime ? fmt(consoleRow.reviewTime) : '—' }}</span>
                  </div>
                  <div class="cs-history-line" v-if="consoleRow.autoRejected">
                    <span class="cs-history-k">驳回原因</span>
                    <span class="cs-history-auto">系统自动驳回：{{ consoleRow.rejectReason || '名额已满' }}</span>
                  </div>
                  <div class="cs-history-line" v-else-if="consoleRow.rejectReason">
                    <span class="cs-history-k">驳回原因</span>
                    <span>{{ consoleRow.rejectReason }}</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="cs-foot">
          <div class="cs-nav">
            <el-button :disabled="consoleIndex <= 0" @click="consolePrev">‹ 上一条</el-button>
            <el-button :disabled="consoleIndex >= consoleRows.length - 1" @click="consoleNext">下一条 ›</el-button>
          </div>
          <div class="cs-keys micro">快捷键：J / K 切换条目 · Enter 通过</div>
          <div class="cs-foot-right">
            <el-button class="cs-cancel" @click="closeConsole">取消</el-button>
            <!-- v8：底部主按钮跟随处理模式 —— 驳回态变红色胶囊「驳回并取下一条」 -->
            <el-button
              v-if="rejectMode"
              class="cs-confirm cs-confirm--reject"
              :loading="acting"
              :disabled="!rejectReason.trim()"
              @click="consoleRejectAndNext"
            >驳回并取下一条</el-button>
            <el-button
              v-else
              class="cs-confirm cs-confirm--approve"
              :loading="acting"
              @click="consoleApproveAndNext"
            >通过并取下一条</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- 列表里的驳回弹窗（不含处理台时用） -->
    <el-dialog v-model="rejectVisible" title="驳回理由" width="440px">
      <el-input v-model="rejectReason" type="textarea" :rows="4" placeholder="请填写驳回理由（会展示给投稿人）" />
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" @click="confirmReject">确认驳回</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 下周排期矩阵（审核即排期：周末审完 = 下周排期完整） ══════════ -->
    <el-dialog v-model="scheduleVisible" title="下周排期" width="880px" class="schedule-dialog">
      <div class="sched-range micro" v-if="schedule.rangeText">
        {{ schedule.weekStart }} ~ {{ schedule.weekEnd }}（{{ schedule.rangeText }}） · 每场容量 {{ schedule.capacity || '不限' }}
      </div>
      <div class="sched-grid">
        <div class="sched-day" v-for="d in schedule.days" :key="d.date">
          <div class="sched-day-head">
            <b>{{ d.weekday }}</b><span class="micro">{{ d.monthDay }}</span>
          </div>
          <button
            v-for="s in d.slots" :key="s.value"
            type="button"
            class="sched-cell"
            :class="{ full: s.full, hot: s.pending > 0 }"
            @click="filterSlot(s)"
          >
            <span class="sc-time">{{ s.period }} {{ s.time }}</span>
            <span class="sc-count"><b class="num">{{ s.approved }}</b><i>/</i>{{ s.capacity || '不限' }}</span>
            <span class="sc-badge pend" v-if="s.pending > 0">待审 {{ s.pending }}</span>
            <span class="sc-badge fulltag" v-else-if="s.full">已排满</span>
          </button>
        </div>
      </div>
      <div class="micro sched-tip">
        点任意格子筛选该时段的待审投稿 · 满格时段的剩余待审会在审核时被系统自动驳回（不占学生周次数）
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import {
  IconSearch, IconCheck, IconClose, IconMusic, IconArticle, IconInfo,
} from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';
import { setPageHeader, clearPageHeader, setRefreshHandler, clearRefreshHandler } from '@/utils/pageHeader';

const router = useRouter();
const fmt = (t) => dayjs(t).format('YYYY-MM-DD HH:mm');
const mmdd = (t) => dayjs(t).format('MM-DD');
/** 名额进度条宽度（处理台内的精简版，与点歌设置页共用语义） */
function pct(used, limit) {
  if (!limit) return '0%';
  const r = Math.min((Number(used) || 0) / Number(limit), 1);
  return `${Math.round(r * 100)}%`;
}

const query = reactive({ page: 1, pageSize: 10, status: '', type: '', keyword: '', slot: '' });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const selection = ref([]);
const counts = reactive({ all: 0, pending: 0, approved: 0, rejected: 0 });
const rule = ref({ weeklyUserLimit: 2, dupBlock: 1 });

/* ── 名额面板 ── */
const quota = ref({ dailyUsed: 0, dailyLimit: 0, weeklyUsed: 0, weeklyLimit: 0, exhausted: false, autoRejectedToday: 0, pendingWhileExhausted: 0 });

async function fetchQuota() {
  try {
    const d = await http.get('/admin/submit/quota');
    quota.value = {
      dailyUsed: d?.daily?.used ?? 0,
      dailyLimit: d?.daily?.limit ?? 0,
      weeklyUsed: d?.weekly?.used ?? 0,
      weeklyLimit: d?.weekly?.limit ?? 0,
      exhausted: !!(d?.daily?.exhausted || d?.weekly?.exhausted),
      autoRejectedToday: d?.autoRejectedToday ?? 0,
      pendingWhileExhausted: d?.pendingWhileExhausted ?? 0,
    };
  } catch { /* 静默 */ }
}

async function fetchRule() {
  try {
    const d = await http.get('/admin/submit/rules');
    rule.value = { weeklyUserLimit: d.weeklyUserLimit, dupBlock: d.dupBlock };
  } catch { /* 静默 */ }
}

/* ── 列表 ── */
const typeSegs = [
  { label: '全部', v: '' },
  { label: '点歌', v: 1 },
  { label: '文稿', v: 2 },
];

const statusChips = computed(() => [
  { label: '全部', v: '', n: counts.all },
  { label: '待审核', v: 0, n: counts.pending },
  { label: '已通过', v: 1, n: counts.approved },
  { label: '已驳回', v: 2, n: counts.rejected },
]);

async function fetchCounts() {
  try {
    const [a, p, y, n] = await Promise.all([
      http.get('/admin/submit/list', { params: { page: 1, pageSize: 1 } }),
      http.get('/admin/submit/list', { params: { page: 1, pageSize: 1, status: 0 } }),
      http.get('/admin/submit/list', { params: { page: 1, pageSize: 1, status: 1 } }),
      http.get('/admin/submit/list', { params: { page: 1, pageSize: 1, status: 2 } }),
    ]);
    counts.all = a.total; counts.pending = p.total; counts.approved = y.total; counts.rejected = n.total;
  } catch { /* 静默 */ }
}

async function fetch() {
  loading.value = true;
  try {
    const params = { ...query };
    if (params.status === '') delete params.status;
    if (params.type === '') delete params.type;
    if (params.slot === '') delete params.slot;
    const data = await http.get('/admin/submit/list', { params });
    rows.value = data.list; total.value = data.total;
  } finally { loading.value = false; }
}

function search() { query.page = 1; fetch(); }
function setType(v) { query.type = v; search(); }
function setStatus(v) { query.status = v; search(); }
function clearSelection() { selection.value = []; }
function goSettings() { router.push('/submit/settings'); }

/* ── 下周排期（审核即排期，2026-09-19）── */
const schedule = ref({ days: [], totalPending: 0, rangeText: '', capacity: 0 });
const scheduleVisible = ref(false);

async function fetchSchedule() {
  try {
    schedule.value = await http.get('/admin/submit/schedule');
  } catch { /* 静默 */ }
}
function openSchedule() { scheduleVisible.value = true; }

/** 点矩阵格子：筛出该时段的待审投稿 */
function filterSlot(cell) {
  scheduleVisible.value = false;
  query.slot = cell.value;
  query.status = 0;
  query.page = 1;
  fetch();
}
function clearSlot() { query.slot = ''; search(); }

/** 当前筛的时段标签（从矩阵里找） */
const slotLabel = computed(() => {
  if (!query.slot) return '';
  for (const d of schedule.value.days || []) {
    const hit = (d.slots || []).find((s) => s.value === query.slot);
    if (hit) return `${d.weekday} ${d.monthDay} · ${hit.period} ${hit.time}`;
  }
  return query.slot;
});

/** 审核处理台当前条的时段占用格 */
const consoleSlotCell = computed(() => {
  const v = consoleRow.value?.wantBroadcastTime;
  if (!v) return null;
  for (const d of schedule.value.days || []) {
    const hit = (d.slots || []).find((s) => s.value === v);
    if (hit) return hit;
  }
  return null;
});

async function refreshAll() {
  await Promise.all([fetch(), fetchQuota(), fetchCounts(), fetchSchedule()]);
  // 顶栏副标题（v8 Topbar）：条数口径与页面一致
  setPageHeader({
    title: '投稿 & 点歌审核',
    subtitle: `共 ${counts.all} 条 · 待审 ${counts.pending} 条`
      + (quota.dailyLimit ? ` · 今日名额 ${quota.dailyUsed}/${quota.dailyLimit}` : ''),
  });
}

/* ── 单条 / 批量操作 ── */
const acting = ref(false);
async function approve(row) {
  try {
    await http.put(`/admin/submit/${row.id}/approve`);
    ElMessage.success('已通过');
    await refreshAll();
  } catch (e) { /* 拦截器已提示（名额满 40902 等） */ }
}

const rejectVisible = ref(false);
const rejectReason = ref('');
const rejectTarget = ref(null);
function reject(row) {
  rejectTarget.value = row;
  rejectReason.value = '';
  rejectVisible.value = true;
}
async function confirmReject() {
  if (!rejectReason.value.trim()) return ElMessage.warning('请填写驳回理由');
  await http.put(`/admin/submit/${rejectTarget.value.id}/reject`, { reason: rejectReason.value });
  ElMessage.success('已驳回');
  rejectVisible.value = false;
  await refreshAll();
}

async function revoke(row) {
  await ElMessageBox.confirm('撤销后这条回到「待审」；若是已通过的点歌，占用的名额会同时归还。', '撤销审核结果', {
    type: 'warning', confirmButtonText: '撤销',
  });
  await http.put(`/admin/submit/${row.id}/revoke`);
  ElMessage.success('已撤销，回到待审');
  await refreshAll();
}

async function batchApprove() {
  const r = await http.post('/admin/submit/batch', { ids: selection.value.map((x) => x.id), action: 'approve' });
  ElMessage.success(`批量通过完成${r?.skipped?.length ? `，${r.skipped.length} 条因名额已满被跳过` : ''}`);
  selection.value = [];
  await refreshAll();
}
async function batchReject() {
  const { value: reason } = await ElMessageBox.prompt('驳回原因（会展示给投稿人）', '批量驳回', {
    inputValidator: (v) => (v && v.trim() ? true : '不能为空'),
  });
  await http.post('/admin/submit/batch', { ids: selection.value.map((x) => x.id), action: 'reject', reason });
  ElMessage.success('批量驳回完成');
  selection.value = [];
  await refreshAll();
}

/** 导出当前筛选结果为 CSV（前端生成，不需要后端接口） */
async function exportCsv() {
  const params = { ...query, page: 1, pageSize: 500 };
  delete params.status; delete params.type;
  if (query.status !== '') params.status = query.status;
  if (query.type !== '') params.type = query.type;
  const data = await http.get('/admin/submit/list', { params });
  const head = ['ID', '类型', '内容', '歌手/标题', '祝福语/正文', '希望播出时段', '投稿人', '学号', '提交时间', '状态', '驳回原因'];
  const state = { 0: '待审核', 1: '已通过', 2: '已驳回' };
  const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(',')];
  data.list.forEach((r) => {
    lines.push([
      r.id, r.type === 1 ? '点歌' : '文稿',
      r.type === 1 ? r.songName : r.articleTitle,
      r.type === 1 ? r.singer : '',
      r.type === 1 ? (r.wishContent || '') : (r.articleContent || ''),
      r.wantBroadcastTime || '', r.nickname || '', r.openid || '',
      fmt(r.createTime), state[r.status] || '', r.rejectReason || '',
    ].map(esc).join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `投稿导出_${dayjs().format('YYYYMMDD-HHmm')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success(`已导出 ${data.list.length} 条`);
}

/* ── 审核处理台 ── */
const consoleVisible = ref(false);
const consoleRow = ref(null);
const consoleIndex = ref(0);
const consoleDetail = ref(null);   // GET /admin/submit/:id → 含 submitter 画像
const rejectMode = ref(false);
const rejectPresets = ['内容不适合播出', '重复投稿', '信息不完整', '已过播出时段'];

/** 拉当前这条的详情（投稿内容 + 投稿人画像） */
async function fetchConsoleDetail(row) {
  consoleDetail.value = null;
  if (!row) return;
  try {
    consoleDetail.value = await http.get(`/admin/submit/${row.id}`);
  } catch { /* 静默：拿不到就只显示列表里已有的字段 */ }
}

/** 处理台里的条目集合 = 当前筛选下的待审条目（没有待审则用当前页） */
const consoleRows = computed(() => {
  const pending = rows.value.filter((r) => Number(r.status) === 0);
  return pending.length ? pending : rows.value;
});

function openConsole(row, keepReject = false) {
  const list = rows.value.filter((r) => Number(r.status) === 0);
  const source = list.length ? list : rows.value;
  const idx = source.findIndex((r) => r.id === row.id);
  consoleIndex.value = idx >= 0 ? idx : 0;
  consoleRow.value = source[consoleIndex.value] || row;
  rejectReason.value = '';
  rejectMode.value = false;
  consoleVisible.value = true;
  window.addEventListener('keydown', onConsoleKey);
  fetchConsoleDetail(consoleRow.value);
}

function closeConsole() {
  consoleVisible.value = false;
  window.removeEventListener('keydown', onConsoleKey);
}

function consolePrev() {
  if (consoleIndex.value <= 0) return;
  consoleIndex.value -= 1;
  consoleRow.value = consoleRows.value[consoleIndex.value];
  rejectReason.value = '';
  rejectMode.value = false;
  fetchConsoleDetail(consoleRow.value);
}
function consoleNext() {
  if (consoleIndex.value >= consoleRows.value.length - 1) {
    ElMessage.success('已经是最后一条了');
    return;
  }
  consoleIndex.value += 1;
  consoleRow.value = consoleRows.value[consoleIndex.value];
  rejectReason.value = '';
  rejectMode.value = false;
  fetchConsoleDetail(consoleRow.value);
}

async function consoleApprove() {
  if (!consoleRow.value) return;
  acting.value = true;
  try {
    await http.put(`/admin/submit/${consoleRow.value.id}/approve`);
    ElMessage.success('已通过');
    await refreshAll();
    await afterActioned();
  } catch (e) { /* 拦截器已提示 */ }
  finally { acting.value = false; }
}

async function consoleReject() {
  if (!rejectReason.value.trim()) {
    rejectMode.value = true;
    return ElMessage.warning('请先填写驳回原因');
  }
  acting.value = true;
  try {
    await http.put(`/admin/submit/${consoleRow.value.id}/reject`, { reason: rejectReason.value });
    ElMessage.success('已驳回');
    await refreshAll();
    await afterActioned();
  } finally { acting.value = false; }
}

/** 处理完一条后的去向：还有待审就取下一条，否则收工 */
async function afterActioned() {
  const left = rows.value.filter((r) => Number(r.status) === 0);
  if (!left.length) {
    closeConsole();
    ElMessage.success('这一批处理完了');
    return;
  }
  consoleIndex.value = 0;
  consoleRow.value = left[0];
  rejectReason.value = '';
  rejectMode.value = false;
}

async function consoleApproveAndNext() {
  if (rejectMode.value) return consoleRejectAndNext();
  await consoleApprove();
}

/** 驳回态下的底部主按钮：红色胶囊「驳回并取下一条」 */
async function consoleRejectAndNext() {
  if (!rejectReason.value.trim()) {
    rejectMode.value = true;
    return ElMessage.warning('请先填写驳回原因');
  }
  await consoleReject();
}

function onConsoleKey(e) {
  if (!consoleVisible.value) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'TEXTAREA' || tag === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); consoleNext(); }
  else if (k === 'k') { e.preventDefault(); consolePrev(); }
  else if (e.key === 'Enter') { e.preventDefault(); consoleApprove(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeConsole(); }
}

onMounted(() => {
  // 顶栏全局搜索带过来的关键词
  const kw = router.currentRoute.value.query.keyword;
  if (kw) query.keyword = String(kw);
  setRefreshHandler(refreshAll);
  refreshAll();
  fetchRule();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onConsoleKey);
  clearRefreshHandler(refreshAll);
  clearPageHeader();
});
</script>

<style scoped>
.submit-page { display: flex; flex-direction: column; gap: 16px; position: relative; }

/* ══════════ 通用原子（v8：与 Showcase 等页同一套，便于复用） ══════════ */
.rowc { display: flex; align-items: center; }
.gap8 { gap: 8px; }
.el { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { font-size: var(--fs-sm); color: var(--accent); font-weight: 500; cursor: pointer; white-space: nowrap; }
.link:hover { text-decoration: underline; }

/* 标签体系（v8：浅色胶囊，语义色只出现在这里） */
.tag {
  display: inline-flex; align-items: center; height: 22px; padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm); white-space: nowrap;
}
.tag-amber { background: var(--amber-bg); color: var(--amber-fg); }
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-reject { background: var(--red-bg); color: var(--red-fg); }
.tag-mute { background: var(--divider); color: var(--muted-2); }
.tag-outline { border: 1px solid var(--hairline); color: var(--muted-2); background: var(--canvas); }

/* ══════════ 点歌设置摘要卡（v8：浅色卡 + 胶囊摘要） ══════════ */
.summary-card {
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 13px 18px;
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
}
.summary-card .micro b { color: var(--ink); font-weight: 600; }
.s-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

/* ══════════ 工具栏 ══════════ */
.toolbar {
  display: flex; align-items: center; gap: 16px;
  flex-wrap: wrap; margin-bottom: 16px;
}
.seg {
  display: inline-flex; gap: 4px; padding: 4px;
  background: var(--parchment); border-radius: var(--r-pill);
}
.seg-item {
  border: none; background: transparent; cursor: pointer;
  height: 30px; padding: 0 16px; border-radius: var(--r-pill);
  font-size: var(--fs-md); font-family: inherit; color: var(--muted);
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.seg-item:hover { color: var(--ink); }
.seg-item.on { background: var(--canvas); color: var(--ink); font-weight: 600; }

.chips { display: inline-flex; gap: 8px; flex-wrap: wrap; }
.chip {
  border: 1px solid var(--hairline); background: var(--canvas); cursor: pointer;
  height: 30px; padding: 0 14px; border-radius: var(--r-pill);
  font-size: var(--fs-md); font-family: inherit; color: var(--ink-2);
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease);
}
.chip:hover { border-color: var(--soft); }
.chip.on { background: var(--ink); border-color: var(--ink); color: #fff; font-weight: 600; }
.chip em { font-style: normal; opacity: 0.7; margin-left: 4px; }
/* 时段筛选 chip：label 长，禁换行；✕ 与文字留 6px */
.chip-slot { white-space: nowrap; }
.chip-slot em { margin-left: 6px; opacity: 0.85; }

.tb-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

/* ══════════ 加载骨架（v8 组件板 · 表格行骨架：复选框+标题+次要列+状态位） ══════════ */
.sk {
  position: relative; overflow: hidden; flex: none;
  border-radius: 6px; background: var(--divider);
  display: inline-block;
}
.sk::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.72), transparent);
  transform: translateX(-100%);
  animation: skSweep 1.4s var(--ease) infinite;
}
@keyframes skSweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .sk::after { animation: none; background: none; } }
.sk-row { display: flex; align-items: center; gap: 13px; padding: 12px 18px; }
.sk-row + .sk-row { border-top: 1px solid var(--divider); }
.sk-text { height: 12px; }
.sk-title { height: 15px; }
.sk-tag { height: 22px; border-radius: var(--r-pill); }

/* ══════════ 下周排期（审核即排期） ══════════ */
.slot-remind {
  display: flex; align-items: center; gap: 8px;
  margin: -6px 0 14px; padding: 10px 16px;
  background: var(--parchment); border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  font-size: var(--fs-sm); color: var(--ink-2);
}
.slot-remind b { color: var(--accent); }

.sched-range { margin-bottom: 12px; }
.sched-grid {
  display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 900px) { .sched-grid { grid-template-columns: repeat(2, 1fr); } }
.sched-day { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.sched-day-head {
  display: flex; align-items: baseline; gap: 6px;
  font-size: var(--fs-md); color: var(--ink);
  padding-bottom: 6px; border-bottom: 1px solid var(--divider);
}
.sched-cell {
  position: relative; text-align: left; cursor: pointer;
  border: 1px solid var(--hairline); border-radius: 10px;
  background: var(--canvas);
  padding: 9px 11px;
  display: flex; flex-direction: column; gap: 3px;
  font-family: inherit;
  transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
}
.sched-cell:hover { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.12); }
.sched-cell.hot { border-color: var(--amber-fg); }
.sched-cell.full { opacity: 0.62; }
.sched-cell.full:hover { border-color: var(--hairline); box-shadow: none; cursor: default; }
.sc-time { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.sc-count { font-size: var(--fs-md); color: var(--ink-2); }
.sc-count b { font-size: var(--fs-xl); color: var(--ink); }
.sc-count i { font-style: normal; color: var(--soft); margin: 0 1px; }
.sc-badge {
  position: absolute; top: 8px; right: 9px;
  font-size: var(--fs-2xs); font-weight: 600; line-height: 1;
  padding: 3px 7px; border-radius: var(--r-pill);
}
.sc-badge.pend { background: var(--amber-bg); color: var(--amber-fg); }
.sc-badge.fulltag { background: var(--tile); color: #fff; }
.sched-tip { margin-top: 14px; }

/* ══════════ 表格卡（v8 card-flush：羊皮纸底 + 圆角，表格透明融进去） ══════════ */
.table-card {
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 6px 0;
  overflow: hidden;
}
.table-card :deep(.el-table) {
  background: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: transparent;
  --el-table-row-hover-bg-color: rgba(255, 255, 255, 0.72);
  --el-table-border-color: rgba(0, 0, 0, 0.05);
}
.table-card :deep(.el-table__inner-wrapper::before) { display: none; }
.table-card :deep(.el-table th.el-table__cell) { background: transparent; }

/* ══════════ 列表 ══════════ */
.pager { margin-top: 16px; justify-content: flex-end; }
.cell-content { min-width: 0; }
.c-strong { font-weight: 600; color: var(--ink); }
.c-sep { color: var(--soft); }
.c-sub {
  margin-top: 4px; font-size: var(--fs-xs); color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
  max-width: 460px;
}
.c-time { color: var(--ink-2); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); }
.c-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* v8 头像：白底 + 1px 描边 + 姓首字（不用墨黑实心） */
.avatar-fallback {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  background: var(--canvas); border: 1px solid var(--hairline); color: var(--ink-2);
  font-size: 12.5px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
}
.avatar-fallback.sys { color: var(--amber-fg); border-color: var(--amber-bg); }
.rv-stack { min-width: 0; line-height: 1.45; }
.micro.is-sys { color: var(--amber-fg); }
.op-cell { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; }
.op-cell :deep(.el-button) {
  margin-left: 0; border-radius: var(--r-pill) !important;
  height: 30px; padding: 0 14px;
}

/* ══════════ 批量操作条 ══════════ */
.sel-bar {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 20;
  display: flex; align-items: center; gap: 14px;
  padding: 10px 18px;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-pill);
  box-shadow: 0 16px 40px -18px rgba(0, 0, 0, 0.35);
}
.sel-count { font-size: var(--fs-md); color: var(--ink-2); }
.sel-count b { color: var(--ink); font-size: var(--fs-xl); }
.sel-hint { font-size: var(--fs-sm); color: var(--muted); }

/* ══════════ 审核处理台（浮层卡片：1000×自动，内部滚动） ══════════ */
:deep(.console-dialog) {
  border-radius: var(--r-tile) !important;
  overflow: hidden;
  box-shadow: 0 30px 80px -30px rgba(0, 0, 0, 0.45) !important;
}
:deep(.console-dialog .el-dialog__header) { margin: 0; padding: 14px 22px; border-bottom: 1px solid var(--divider); }
:deep(.console-dialog .el-dialog__body) { padding: 0; background: var(--parchment); }
:deep(.console-dialog .el-dialog__footer) { padding: 10px 22px; border-top: 1px solid var(--divider); background: var(--canvas); }
.cs-head { display: flex; align-items: center; justify-content: space-between; }
.cs-head-left { display: flex; align-items: baseline; gap: 12px; }
.cs-type-tag {
  display: inline-flex; align-items: center; height: 22px; padding: 0 10px;
  border-radius: var(--r-pill); background: #fff; border: 1px solid var(--hairline);
  font-size: var(--fs-xs); font-weight: 500; color: var(--muted); letter-spacing: var(--ls-wide-sm);
}
.cs-title { font-size: var(--fs-2xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.cs-sub { font-size: var(--fs-sm); color: var(--muted); }
.cs-head-sub {
  padding: 6px 22px 0;
  font-size: var(--fs-xs); color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}

.cs-body {
  display: grid; grid-template-columns: minmax(0, 1fr) 306px;
  gap: 16px; padding: 16px 22px; align-items: start;
  max-height: 62vh; overflow: auto;
}
@media (max-width: 1100px) { .cs-body { grid-template-columns: 1fr; } }
.cs-left, .cs-right { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

.cs-person {
  background: var(--tile); color: #fff;
  border-radius: var(--r-card);
  padding: 15px 18px;
  display: flex; flex-direction: column;
  gap: 10px;            /* 与 v8 方案 .tile { gap: 10px } 一致 */
}
.cs-person-row { display: flex; align-items: center; gap: 13px; }
.cs-avatar {
  width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
  background: rgba(255, 255, 255, 0.14); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-md); font-weight: 600;
}
.cs-person-name { font-size: 15px; font-weight: 600; }
.cs-person-sub { font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.66); margin-top: 3px; }
.cs-person-tags { margin-left: auto; display: flex; gap: 6px; flex: none; align-items: center; }
.cs-person-tags :deep(.el-tag) { border: none; }
.cs-dot { color: rgba(255, 255, 255, 0.4); margin: 0 4px; }
.cs-reviewer { font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.72); }
.cs-reviewer b { color: #fff; font-weight: 600; }

/* 胶囊下半段：三列左对齐（方案 rowc gap13 + border-top rgba(.22) + padding-top 13） */
.cs-person-stats {
  padding-top: 13px;
  border-top: 1px solid rgba(255, 255, 255, 0.22);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 13px;
}
.cs-stat {
  display: flex; flex-direction: column;
  align-items: flex-start;
  text-align: left;
  min-width: 0;
}
.cs-stat-label {
  font-size: 13px; font-weight: 500;
  color: #d1d1d6;
  letter-spacing: 0.3px;
}
.cs-stat-num {
  font-size: 22px; font-weight: 600;
  color: #fff;
  line-height: 1.2;
  margin-top: 1px;
}
/* 首次投稿：方案原文 18px / margin-top 5px（比另两列数字略小） */
.cs-stat-date {
  font-size: 18px; font-weight: 600;
  color: #fff;
  margin-top: 5px;
}

.cs-card {
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-card); padding: 18px 20px;
}
.cs-card-head {
  display: flex; align-items: baseline; justify-content: space-between;
  font-size: var(--fs-md); font-weight: 600; color: var(--ink);
  padding-bottom: 12px; border-bottom: 1px solid var(--divider); margin-bottom: 14px;
}
.cs-fields { display: flex; flex-direction: column; gap: 14px; }
.cs-field { display: flex; gap: 14px; }
.cs-k { width: 84px; flex-shrink: 0; font-size: var(--fs-sm); color: var(--muted); padding-top: 2px; }
.cs-v { flex: 1; min-width: 0; font-size: var(--fs-md); color: var(--ink-2); }
.cs-v.read { line-height: 1.7; max-height: 30vh; overflow: auto; }
.pre-wrap { white-space: pre-wrap; }

.cs-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cs-actions :deep(.el-button) { height: 40px; margin-left: 0; font-size: var(--fs-md); font-weight: 600; }
.cs-approve { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; }
.cs-approve:hover { background: #0059b3 !important; }
.cs-reject { background: var(--canvas) !important; border-color: var(--hairline) !important; color: var(--ink-2) !important; }
.cs-reject.on { border-color: var(--red-fg) !important; color: var(--red-fg) !important; }

.cs-quota {
  margin-top: 14px; padding: 12px 14px;
  background: var(--parchment); border-radius: 12px;
}
.cs-quota-row { display: flex; align-items: baseline; justify-content: space-between; font-size: var(--fs-sm); color: var(--muted); }
.cs-quota-row b { font-size: var(--fs-xl); color: var(--ink); }
.cs-quota-note { margin-top: 5px; font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }

.cs-reject-box { margin-top: 16px; opacity: 1; transition: opacity 0.16s var(--ease); }
.cs-reject-box.off { opacity: 0.55; }
.cs-reject-head {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-sm); color: var(--muted); margin-bottom: 10px;
}
.cs-reject-head em { font-style: normal; color: var(--red-fg); margin-left: 4px; }
.cs-reject-required { height: 19px; font-size: 10.5px; }
.cs-presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.preset {
  border: 1px solid var(--hairline); background: var(--canvas); cursor: pointer;
  height: 28px; padding: 0 12px; border-radius: var(--r-pill);
  font-size: var(--fs-sm); font-family: inherit; color: var(--ink-2);
}
.preset:hover { border-color: var(--soft); }
.preset.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.cs-reject-disabled-hint {
  margin-top: 8px;
  color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}

/* warnline（红底告警条）—— v8 屏 6 驳回原因下用 */
.warnline {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: var(--fs-xs); color: var(--red-fg);
  background: var(--red-bg);
  border-radius: 10px; padding: 10px 12px;
  line-height: 1.6;
}
.warnline :deep(svg) { flex-shrink: 0; margin-top: 2px; }

/* v8 屏 6：处理结果补充说明 */
.cs-extra-note {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--divider);
  color: var(--muted-2);
}
.cs-extra-note code {
  font-family: var(--mono); font-size: 10.5px;
  background: var(--parchment); border-radius: 4px; padding: 1px 5px;
  color: var(--ink-2);
}

/* v8 屏 6：审核记录卡（右侧底部） */
.cs-history {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--divider);
}
.cs-history-head {
  font-size: var(--fs-md); font-weight: 600;
  color: var(--ink); margin-bottom: 10px;
  letter-spacing: var(--ls-tight-sm);
}
.cs-history-card {
  background: var(--parchment);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: var(--fs-sm);
  color: var(--ink-2);
  line-height: 1.75;
}
.cs-history-line {
  display: flex; align-items: baseline; gap: 10px;
}
.cs-history-k {
  width: 64px; flex: none;
  color: var(--muted); font-size: var(--fs-xs);
}
.cs-history-auto { color: var(--amber-fg); }

.cs-foot { display: flex; align-items: center; gap: 16px; }
.cs-nav { display: flex; gap: 8px; }
.cs-keys { flex: 1; text-align: center; }
.cs-foot-right { display: flex; gap: 10px; }

/* v8：底部按钮一律胶囊形；主按钮跟随处理模式变色 */
.cs-foot :deep(.el-button) { border-radius: var(--r-pill) !important; height: 34px; padding: 0 18px; }
.cs-cancel { color: var(--ink-2) !important; }
.cs-confirm { font-weight: 600; }
.cs-confirm--approve { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; }
.cs-confirm--approve:hover { background: #0059b3 !important; border-color: #0059b3 !important; }
.cs-confirm--reject { background: var(--red-fg) !important; border-color: var(--red-fg) !important; color: #fff !important; }
.cs-confirm--reject:hover { background: #9a1d14 !important; border-color: #9a1d14 !important; }
.cs-confirm.is-disabled,
.cs-confirm.is-disabled:hover { background: #e3a9a4 !important; border-color: #e3a9a4 !important; color: #fff !important; }
</style>
