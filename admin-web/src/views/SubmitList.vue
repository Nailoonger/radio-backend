<template>
  <div class="submit-page">
    <!-- ══════════ v2 状态条（深色，视觉主角）
         规则 v2 里「容量」不再是日/周名额，而是「下周排期格子 × 每格正式位」+ 一条全局候补队列；
         点歌窗口（默认周六 18:00 → 周日 18:00）结束时刻 = 审核截止时刻。 ══════════ -->
    <div class="tile summary-tile">
      <div class="tile-main">
        <div class="tile-status">
          <i class="t-dot" :class="{ idle: !win.open }"></i>
          <span>{{ win.enabled === false ? '点歌时间不限（窗口已关闭）' : (win.windowText || '点歌时间窗口') }}</span>
        </div>
        <div class="tile-cd">
          <template v-if="win.enabled === false">一直开放</template>
          <template v-else-if="win.open">距提交截止 {{ fmtDur(cd?.ms) }}</template>
          <template v-else>距开放 {{ fmtDur(cd?.ms) }}</template>
        </div>
        <div class="tile-meta">
          窗口结束 = 审核截止（{{ hhmm(win.closesAt || cap.finalizeAt) }}）。到点后：候补队列（3）与已补位待审（4）由系统统一驳回，待审（0）保留到下一定稿检查。
        </div>
      </div>

      <div class="tile-metric">
        <div class="k">下周正式位</div>
        <div class="v num">{{ cap.weekCapacity || 0 }}</div>
        <div class="d">每格 <b>{{ cap.capacity || 0 }}</b> 个 × {{ gridCount }} 格<br>（周一~周五 × {{ perDaySlots }} 个时段）</div>
      </div>

      <div class="tile-metric">
        <div class="k">已占位</div>
        <div class="v num">{{ seatedTotal }}<em>/{{ cap.weekCapacity || 0 }}</em></div>
        <div class="d">已排 <b>{{ approvedCount }}</b> · 待审 <b>{{ pendingCount }}</b> · 补位待审 <b>{{ promotedCount }}</b></div>
      </div>

      <div class="tile-metric">
        <div class="k">候补队列</div>
        <div class="v num">{{ queue.total || 0 }}<em>/{{ queue.limit || 0 }}</em></div>
        <div class="d">{{ queue.limitAuto ? '上限自动（= 正式位总数）' : '上限已手动设置' }}<br><template v-if="queue.headWaitMinutes != null">队首已等待 <b>{{ fmtWait(queue.headWaitMinutes) }}</b></template><template v-else>队列目前是空的</template></div>
      </div>
    </div>

    <!-- ══════════ 规则摘要 ══════════ -->
    <div class="card-plain">
      <div class="rowc wrap gap18">
        <span class="rowc gap8">
          <span class="tag tag-outline">提交规则</span>
          <span class="micro">每人每周最多 <b>{{ rule.weeklyUserLimit === 0 ? '不限' : rule.weeklyUserLimit }}</b> 次 · 同一首歌一周内{{ rule.dupBlock ? '不可重复' : '可重复' }}</span>
        </span>
        <span class="rowc gap8">
          <span class="tag tag-outline">下周排期</span>
          <span class="micro">
            <template v-if="schedule.rangeText">{{ schedule.rangeText }} · </template>还有 <b>{{ freeCount }}</b> 个空格
          </span>
          <a class="link" @click="openSchedule">看排期矩阵 ›</a>
        </span>
        <a class="link" style="margin-left:auto" @click="goSettings">去「点歌设置」改 ›</a>
      </div>
    </div>

    <!-- 定稿提醒（审核即排期：补位件必须在下周一定稿前审完） -->
    <div class="slot-remind" v-if="schedule.totalPending > 0">
      <IconInfo :size="15" />
      <span>
        下周排期还有 <b class="num">{{ schedule.totalPending }}</b> 首待处理<template v-if="pendingCount || promotedCount">（<b>{{ pendingCount }}</b> 首待审<template v-if="promotedCount"> + <b>{{ promotedCount }}</b> 首补位待审</template>）</template>。
        请在 <b>{{ hhmm(win.closesAt) }}</b>（点歌窗口截止 = 审核截止）前审完，否则补位件会被系统自动驳回、位子继续往下递补。
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
        <!-- ⚠️ v2：点歌这条「排到哪一格」的权威字段是 scheduled_slot（实际排期）；
             候补件还没排期，只有 want_broadcast_time（学生首选），所以在副行里分开写。 -->
        <el-table-column label="内容 · 排到的时段" min-width="330">
          <template #default="{ row }">
            <div class="cell-content">
              <div class="rowc gap8">
                <span class="tag tag-outline">{{ row.type === 1 ? '点歌' : '文稿' }}</span>
                <span class="c-strong el">
                  <template v-if="row.type === 1">{{ row.songName }} <span class="c-sep">·</span> {{ row.singer }}</template>
                  <template v-else>{{ row.articleTitle }}</template>
                </span>
                <span v-if="rowBadge(row)" class="ano" :class="badgeClass(rowBadge(row).kind)">{{ rowBadge(row).text }}</span>
              </div>
              <div class="rownote el" v-html="rowNote(row)"></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="投稿人" width="140">
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
        <!-- ⚠️ 列宽 124 是量出来的，别改回 106：
             v2 的 4 号状态胶囊文案是「已补位 · 待审」，实测 97.6px（fs-xs + padding 0 10px + letter-spacing .5px）；
             106px 列减去 td 左右各 10px padding 只剩 86px → 胶囊溢出 ~12px 被裁。
             124px 列留 104px 可用，刚好放得下（其余三字胶囊 55px，不受影响）。 -->
        <el-table-column label="状态" width="124" align="center">
          <template #default="{ row }">
            <StatusTag :status="row.status" :label="statusLabel(row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="182" fixed="right" align="right">
          <template #default="{ row }">
            <div class="op-cell">
              <!-- 待审(0) / 候补中(3) / 已补位待审(4)：都能通过或驳回 -->
              <template v-if="[0, 3, 4].includes(Number(row.status))">
                <el-button size="small" type="primary" @click="approve(row)">通过</el-button>
                <el-button size="small" @click="reject(row)">驳回</el-button>
              </template>
              <!-- 已排期(1) / 已驳回(2)：撤销 / 处理 -->
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
      <span class="sel-hint">驳回要求填写原因 · 已驳回的会被自动跳过</span>
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
            <span class="cs-type-tag" v-if="consoleRow">
              {{ consoleRow.type === 1 ? '点歌' : '文稿' }}
            </span>
            <span class="cs-title">审核处理台</span>
            <span class="cs-sub">
              第 {{ consoleIndex + 1 }} / {{ consoleRows.length }} 条待处理
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

            <!-- 下半段：历史通过 / 历史驳回 / 首次投稿 -->
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
                {{ consoleSlotHeadText }}
                · 该格已占 <b class="num">{{ consoleSlotCell.seated }}</b>/{{ consoleSlotCell.capacity || '不限' }}<template v-if="consoleSlotCell.capacity && !consoleSlotCell.full"> · 还可排 {{ Math.max(consoleSlotCell.capacity - consoleSlotCell.seated, 0) }}</template><template v-if="consoleSlotCell.full"> · 已排满</template>
              </span>
              <span class="micro" v-else>完整内容，不做截断</span>
            </div>
            <div class="cs-fields" v-if="consoleRow.type === 1">
              <div class="cs-field"><span class="cs-k">歌曲</span><span class="cs-v">{{ consoleRow.songName }} · {{ consoleRow.singer }}</span></div>
              <div class="cs-field">
                <span class="cs-k">希望播出时段</span>
                <span class="cs-v">
                  <template v-if="consoleCard && consoleCard.status === 'promoted'">
                    <span class="strike">{{ consoleRow.wantBroadcastTime || '—' }}</span>
                    <span class="arrow">→</span>
                    <b class="acc">实际排到 {{ consoleRow.scheduledSlot || '—' }}</b>
                  </template>
                  <template v-else-if="Number(consoleRow.status) === 3">
                    {{ consoleRow.wantBroadcastTime || '—' }}
                    <span class="micro">（首选 · 该格已满，本条在候补队列里）</span>
                  </template>
                  <template v-else>{{ consoleRow.scheduledSlot || consoleRow.wantBroadcastTime || '—' }}</template>
                </span>
              </div>
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

          <!-- ══ v2 新增：候补说明卡（只对 3 / 4 出现）
               这两类都是「系统排的，不是人工排的」，必须把来龙去脉写在审核按钮旁边。 ══ -->
          <div class="cs-v2card" v-if="consoleCard && (consoleCard.status === 'promoted' || consoleCard.status === 'waiting')">
            <div class="rowc gap8" style="margin-bottom:10px">
              <StatusTag :status="consoleCard.status === 'promoted' ? 4 : 3" />
              <span class="micro">{{ consoleCard.status === 'promoted' ? '这条不是人工排的，是候补队列自动补上来的' : '这条还没排到期，正在全局候补队列里排队' }}</span>
            </div>

            <template v-if="consoleCard.status === 'promoted'">
              <div class="rowc wrap gap13">
                <span class="rowc gap8">
                  <span class="micro">首选</span>
                  <span class="strong strike">{{ consoleCard.preferred || '—' }}</span>
                </span>
                <span class="arrow">→</span>
                <span class="rowc gap8">
                  <span class="micro">实际排到</span>
                  <span class="strong acc">{{ consoleCard.scheduledSlot || '—' }}</span>
                </span>
                <span class="pos-chip" v-if="consoleCard.queuePos" style="margin-left:auto">补位时队列第 {{ consoleCard.queuePos }} 位</span>
              </div>
              <div class="hint" style="margin-top:10px">
                <b>补位不等于通过</b> —— 学生端已看到「已补位，等审核」，通过后才算正式播出。
              </div>
            </template>

            <template v-else>
              <div class="rowc wrap gap13">
                <span class="rowc gap8"><span class="micro">队内位次</span><span class="strong">第 {{ consoleCard.queuePos || '?' }} 位</span></span>
                <span class="rowc gap8"><span class="micro">前面还有</span><span class="strong">{{ consoleCard.aheadCount ?? 0 }} 人</span></span>
                <span class="rowc gap8"><span class="micro">首选</span><span class="strong">{{ consoleCard.preferred || '—' }}</span></span>
              </div>
              <div class="hint" style="margin-top:10px">
                {{ consoleCard.hint || '下周任意时段有空位时按提交先后自动补位，实际排到的时段可能与你首选不同。' }}
              </div>
            </template>

            <div class="hint" style="margin-top:6px" v-if="consoleCard.finalizeAt">
              定稿时刻 <b>{{ hhmm(consoleCard.finalizeAt) }}</b>（= 点歌窗口结束）· 到点仍未补位 / 未审完的会被系统自动驳回。
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

            <!-- ══ v2：该格占位（替代旧的「今日名额」） ══ -->
            <div class="cs-block" v-if="consoleRow.type === 1 && consoleSlotCell">
              <div class="cs-block-head">
                <span class="field-label">该格占位 · {{ consoleSlotValue }}</span>
              </div>
              <div class="cs-quota-row">
                <span><b class="num" style="font-size:17px">{{ consoleSlotCell.seated }}</b> <span class="micro">/ {{ consoleSlotCell.capacity || '不限' }}</span></span>
                <span class="micro">
                  <template v-if="Number(consoleRow.status) !== 3">含本条 · </template>{{ consoleSlotCell.full ? '已满' : `还可排 ${consoleSlotCell.left}` }}
                </span>
              </div>
              <div class="bar" style="margin-top:8px" v-if="consoleSlotCell.capacity">
                <i :style="{ width: pct(consoleSlotCell.seated, consoleSlotCell.capacity) }" />
              </div>
              <div class="hint">驳回 / 撤销 = 立刻把位子让给候补队首，会自动递补。</div>
            </div>

            <!-- ══ v2：全局候补队列 ══ -->
            <div class="cs-block" v-if="consoleRow.type === 1">
              <div class="cs-block-head">
                <span class="field-label">全局候补队列</span>
              </div>
              <div class="cs-quota-row">
                <span><b class="num" style="font-size:17px">{{ queue.total || 0 }}</b> <span class="micro">/ {{ queue.limit || 0 }}（{{ queue.limitAuto ? '自动上限' : '手动上限' }}）</span></span>
                <span class="micro" v-if="queue.headWaitMinutes != null">队首已等 {{ fmtWait(queue.headWaitMinutes) }}</span>
              </div>
              <div class="bar" style="margin-top:8px" v-if="queue.limit">
                <i :style="{ width: pct(queue.total, queue.limit) }" />
              </div>
              <div class="rowc gap8" style="margin-top:8px" v-if="queueHead">
                <span class="pos-chip">第 1 位</span>
                <span class="micro el">{{ queueHead.songName }} · {{ queueHead.singer }}</span>
              </div>
              <div class="hint">跨所有时段、先进先出；全部格子满额时整体关闭（已入队的自动驳回，不占学生周次数）。</div>
            </div>

            <!-- ══ v2：点歌时间窗口（文案一律来自服务端，前端不硬编码星期与时刻） ══ -->
            <div class="cs-block">
              <div class="cs-block-head"><span class="field-label">点歌时间窗口</span></div>
              <div class="rowc gap8">
                <i class="t-dot2" :class="{ idle: !win.open }"></i>
                <span class="strong">{{ win.enabled === false ? '不限时间' : (win.open ? `开放中 · 距截止 ${fmtDur(cd?.ms)}` : `未开放 · 距开放 ${fmtDur(cd?.ms)}`) }}</span>
              </div>
              <div class="micro" style="margin-top:4px">
                {{ win.windowText || '—' }}
                <template v-if="win.closesAt"> · 结束时刻 {{ hhmm(win.closesAt) }}</template>
              </div>
              <div class="hint">窗口结束 = 审核截止；到点仍未补位 / 未审完的补位件（含本条）会被系统自动驳回。</div>
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
                  <div class="cs-history-line" v-if="consoleRow.type === 1 && consoleRow.queueAt">
                    <span class="cs-history-k">入队</span>
                    <span class="num">{{ fmt(consoleRow.queueAt) }}</span>
                  </div>
                  <div class="cs-history-line" v-if="consoleRow.type === 1 && consoleRow.promotedAt">
                    <span class="cs-history-k">补位</span>
                    <span class="num">{{ fmt(consoleRow.promotedAt) }}<template v-if="consoleRow.scheduledSlot"> · {{ consoleRow.scheduledSlot }}</template></span>
                  </div>
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

    <!-- ══════════ 下周排期矩阵（v2：每格四类徽标 + 全局候补队列） ══════════ -->
    <el-dialog v-model="scheduleVisible" title="下周排期" width="920px" class="schedule-dialog">
      <div class="tile sched-tile">
        <div class="rowc" style="gap:26px;align-items:flex-start">
          <div class="grow" style="flex:1;min-width:200px">
            <div class="tile-status"><i class="t-dot" :class="{ idle: !win.open }"></i>定稿时刻 {{ hhmm(win.closesAt) }}</div>
            <div class="tile-meta" style="margin-top:6px">
              = 点歌窗口结束。到点后清掉候补（3）与补位待审（4），只留待审（0）。
            </div>
          </div>
          <div class="tile-metric"><div class="k">待审</div><div class="v num">{{ pendingCount }}</div><div class="d">已占位，等人工审</div></div>
          <div class="tile-metric"><div class="k">补位待审</div><div class="v num">{{ promotedCount }}</div><div class="d">候补递补上来 · 定稿前必须审完</div></div>
          <div class="tile-metric"><div class="k">已排期</div><div class="v num">{{ approvedCount }}</div><div class="d">已通过、正式播出</div></div>
          <div class="tile-metric"><div class="k">空位</div><div class="v num">{{ freeCount }}</div><div class="d">候补会自动递补进来</div></div>
        </div>
      </div>

      <div class="sched-range micro">
        <template v-if="schedule.rangeText">{{ schedule.weekStart }} ~ {{ schedule.weekEnd }}（{{ schedule.rangeText }}） · </template>每格正式位 {{ schedule.capacity || 0 }}
        <span style="margin-left:6px">已占位 = 已排 + 待审 + 补位待审（全部按实际排期 <code>scheduled_slot</code> 统计）</span>
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
            :class="{ full: s.full, hot: s.pending > 0 && !s.promoted, acc: s.promoted > 0, free: !s.seated }"
            @click="filterSlot(s)"
          >
            <span class="sc-time">{{ s.period }} {{ s.time }}</span>
            <span class="sc-count"><b class="num">{{ s.seated }}</b><i>/</i>{{ s.capacity || '不限' }}</span>
            <span class="sc-badge acc" v-if="s.promoted > 0">补位 {{ s.promoted }}</span>
            <span class="sc-badge pend" v-else-if="s.pending > 0">待审 {{ s.pending }}</span>
            <span class="sc-badge fulltag" v-else-if="s.full">已满</span>
            <span class="sc-badge freetag" v-else-if="!s.seated">空位</span>
          </button>
        </div>
      </div>

      <div class="legend">
        <span><span class="sc-badge pend">待审 n</span>占位中，等人工审</span>
        <span><span class="sc-badge acc">补位 n</span>候补递补上来，定稿前必须审完</span>
        <span><span class="sc-badge fulltag">已满</span>该格正式位用尽</span>
        <span><span class="sc-badge freetag">空位</span>还有位子，候补会自动递补进来</span>
      </div>

      <!-- 全局候补队列（跨所有时段，先进先出） -->
      <div class="sched-queue" v-if="queue.items && queue.items.length">
        <div class="rowc gap8" style="margin-bottom:10px">
          <span class="sec-title" style="font-size:14px">全局候补队列</span>
          <span class="micro">{{ queue.total }} / {{ queue.limit }}（{{ queue.limitAuto ? '自动上限 = 下周正式位总数' : '手动上限' }}）· 跨所有时段、先进先出</span>
        </div>
        <div class="qitem" v-for="it in queue.items" :key="it.id">
          <span class="pos-chip">第 {{ it.pos }} 位</span>
          <span class="strong el">{{ it.songName }} <span class="c-sep">·</span> {{ it.singer }}</span>
          <span class="micro el">首选 {{ it.wantBroadcastTime || '—' }}</span>
          <span class="micro num" style="margin-left:auto">{{ it.queueAt ? fmt(it.queueAt).slice(5) : '' }}</span>
          <span class="ano" :class="it.reviewed ? 'ano-acc' : 'ano-mid'">{{ it.reviewed ? '已审' : '未审' }}</span>
        </div>
      </div>
      <div class="micro sched-tip" v-else>
        候补队列目前是空的 —— 每格都有空位，学生提交即落座。
      </div>

      <div class="micro sched-tip">
        点任意格子筛出该时段的投稿（含候补件的首选时段） · 全部格子满额时，候补队列会整体关闭（已入队的被自动驳回，不占学生周次数）。
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
import { IconSearch, IconClose, IconInfo } from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';
import { setPageHeader, clearPageHeader, setRefreshHandler, clearRefreshHandler } from '@/utils/pageHeader';

/* ══════════ 规则 v2 的状态机（与后端 songQueueService.ST 一致） ══════════ */
const ST = { PENDING: 0, SCHEDULED: 1, REJECTED: 2, QUEUED: 3, PROMOTED: 4 };

const router = useRouter();
const fmt = (t) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '—');
const mmdd = (t) => (t ? dayjs(t).format('MM-DD') : '—');
/** 带明确 +08:00 偏移的 ISO → MM-DD HH:mm（服务端下发的时刻一律走这里） */
const hhmm = (iso) => (iso ? dayjs(iso).format('MM-DD HH:mm') : '—');
/** 进度条宽度 */
function pct(used, limit) {
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
/** 分钟 → 「3 小时」 */
function fmtWait(min) {
  const n = Number(min) || 0;
  if (n < 60) return `${n} 分钟`;
  if (n < 1440) return `${Math.floor(n / 60)} 小时`;
  return `${Math.floor(n / 1440)} 天${Math.floor((n % 1440) / 60) ? ` ${Math.floor((n % 1440) / 60)} 小时` : ''}`;
}

/* ── 本地时钟（窗口倒计时用；服务端只给一次 secondsToClose，本地按秒递减更省请求） ── */
const nowTs = ref(Date.now());
let ticker = null;

const query = reactive({ page: 1, pageSize: 10, status: '', type: '', keyword: '', slot: '' });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const selection = ref([]);
const counts = reactive({ all: 0, pending: 0, queued: 0, promoted: 0, approved: 0, rejected: 0 });
const rule = ref({ weeklyUserLimit: 2, dupBlock: 1 });

/* ══════════ 容量 / 候补 / 窗口（v2：/capacity 取代旧的 /quota） ══════════ */
const cap = ref({ capacity: 0, weekCapacity: 0, queue: {}, window: null, finalizeAt: null });
const win = computed(() => cap.value.window || {});
const queue = computed(() => cap.value.queue || {});
const queueHead = computed(() => (queue.value.items || [])[0] || null);

/** 倒计时：开放中看 closesAt，未开放看 opensAt */
const cd = computed(() => {
  const w = win.value;
  if (w.enabled === false) return null;
  const target = w.open ? w.closesAt : w.opensAt;
  if (!target) return null;
  return { open: !!w.open, ms: new Date(target).getTime() - nowTs.value, target };
});

async function fetchCapacity() {
  try {
    const d = await http.get('/admin/submit/capacity');
    cap.value = {
      capacity: d?.capacity ?? 0,
      weekCapacity: d?.weekCapacity ?? 0,
      queue: d?.queue || {},
      window: d?.window || null,
      finalizeAt: d?.finalizeAt || null,
    };
  } catch { /* 静默 */ }
}

async function fetchRule() {
  try {
    const d = await http.get('/admin/submit/rules');
    rule.value = { weeklyUserLimit: d.weeklyUserLimit, dupBlock: d.dupBlock };
  } catch { /* 静默 */ }
}

/* ══════════ 下周排期矩阵（同时也是容量的口径来源） ══════════ */
const schedule = ref({ days: [], totalPending: 0, rangeText: '', capacity: 0, weekStart: '', weekEnd: '' });
const scheduleVisible = ref(false);

async function fetchSchedule() {
  try {
    schedule.value = await http.get('/admin/submit/schedule');
  } catch { /* 静默 */ }
}
function openSchedule() { scheduleVisible.value = true; }

const allSlots = computed(() => (schedule.value.days || []).flatMap((d) => d.slots || []));
const gridCount = computed(() => allSlots.value.length);
const perDaySlots = computed(() => {
  const d0 = (schedule.value.days || [])[0];
  return (d0 && d0.slots ? d0.slots.length : 0) || '?';
});
const seatedTotal = computed(() => allSlots.value.reduce((n, s) => n + (s.seated || 0), 0));
const pendingCount = computed(() => allSlots.value.reduce((n, s) => n + (s.pending || 0), 0));
const promotedCount = computed(() => allSlots.value.reduce((n, s) => n + (s.promoted || 0), 0));
const approvedCount = computed(() => Math.max(seatedTotal.value - pendingCount.value - promotedCount.value, 0));
const freeCount = computed(() => Math.max((cap.value.weekCapacity || 0) - seatedTotal.value, 0));

/** 从矩阵里取某一格的实时占用 */
function cellOf(slotValue) {
  if (!slotValue) return null;
  for (const d of schedule.value.days || []) {
    const hit = (d.slots || []).find((s) => s.value === slotValue);
    if (hit) return hit;
  }
  return null;
}

/** 当前筛的时段标签（从矩阵里找） */
const slotLabel = computed(() => {
  if (!query.slot) return '';
  for (const d of schedule.value.days || []) {
    const hit = (d.slots || []).find((s) => s.value === query.slot);
    if (hit) return `${d.weekday} ${d.monthDay} · ${hit.period} ${hit.time}`;
  }
  return query.slot;
});

/** 点矩阵格子：筛出该时段的投稿（v2 不锁状态，否则补位件会被藏掉） */
function filterSlot(cell) {
  scheduleVisible.value = false;
  query.slot = cell.value;
  query.status = '';
  query.page = 1;
  fetch();
}
function clearSlot() { query.slot = ''; search(); }

/* ══════════ 列表 ══════════ */
const typeSegs = [
  { label: '全部', v: '' },
  { label: '点歌', v: 1 },
  { label: '文稿', v: 2 },
];

const statusChips = computed(() => [
  { label: '全部', v: '', n: counts.all },
  { label: '待审核', v: 0, n: counts.pending },
  { label: '候补中', v: 3, n: counts.queued },
  { label: '已补位待审', v: 4, n: counts.promoted },
  { label: '已排期', v: 1, n: counts.approved },
  { label: '已驳回', v: 2, n: counts.rejected },
]);

/** 状态胶囊文案：点歌 1 = 已排期；文稿 1 = 已通过（文稿没有播出时段） */
function statusLabel(row) {
  if (Number(row.type) === 2 && Number(row.status) === ST.SCHEDULED) return '已通过';
  return '';
}

/** 标题行的 v2 小徽章 */
function rowBadge(row) {
  if (Number(row.type) === 2) return null;
  const st = Number(row.status);
  if (st === ST.PENDING) return { kind: 'seat', text: '占位中' };
  if (st === ST.QUEUED) return { kind: 'queue', text: `第 ${row.queuePos || '?'} 位` };
  if (st === ST.PROMOTED) return { kind: 'promoted', text: '补位' };
  if (st === ST.REJECTED && row.autoRejected) return { kind: 'sys', text: '系统' };
  return null;
}
function badgeClass(kind) {
  if (kind === 'promoted') return 'ano-acc';
  if (kind === 'queue') return 'pos-chip';
  return 'ano-mid';
}

/** 副行：点歌写「排到哪一格 / 为什么在候补 / 首选→实际」，文稿写正文摘要 */
function rowNote(row) {
  if (Number(row.type) === 2) return esc(row.articleContent || '—');
  const st = Number(row.status);
  if (st === ST.QUEUED) {
    const ahead = row.queueAhead != null ? row.queueAhead : Math.max((Number(row.queuePos) || 1) - 1, 0);
    return `首选 ${esc(row.wantBroadcastTime || '—')}（已满）· 前面 <b>${ahead}</b> 人`
      + (row.queueAt ? ` · ${fmt(row.queueAt).slice(5)} 入队` : '');
  }
  if (st === ST.PROMOTED) {
    return `首选 <span class="strike">${esc(row.wantBroadcastTime || '—')}</span> <span class="arrow">→</span> 实际 <b class="acc">${esc(row.scheduledSlot || '—')}</b>`;
  }
  if (st === ST.REJECTED) {
    return `${row.autoRejected ? '系统驳回' : '驳回'}：${esc(row.rejectReason || '—')}`;
  }
  const slot = row.scheduledSlot || row.wantBroadcastTime || '';
  const cell = cellOf(slot);
  const occ = cell ? ` · 该格已占 ${cell.seated}/${cell.capacity || '不限'}（含本条）` : '';
  return `${esc(slot || '未选时段')}${occ}`;
}
/** 副行用 innerHTML 渲染（要画删除线/强调色），所有来源文本先转义 */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchCounts() {
  try {
    const one = (params) => http.get('/admin/submit/list', { params: { page: 1, pageSize: 1, ...params } });
    const [a, p, q, m, y, n] = await Promise.all([
      one({}), one({ status: 0 }), one({ status: 3 }), one({ status: 4 }), one({ status: 1 }), one({ status: 2 }),
    ]);
    counts.all = a.total; counts.pending = p.total; counts.queued = q.total;
    counts.promoted = m.total; counts.approved = y.total; counts.rejected = n.total;
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

async function refreshAll() {
  await Promise.all([fetch(), fetchCapacity(), fetchCounts(), fetchSchedule()]);
  setPageHeader({
    title: '投稿 & 点歌审核',
    subtitle: `共 ${counts.all} 条 · 待审 ${counts.pending} 条 · 已补位待审 ${counts.promoted} 条 · 候补队列 ${queue.value.total || 0} 人`,
  });
}

/* ── 单条 / 批量操作 ── */
const acting = ref(false);
async function approve(row) {
  try {
    await http.put(`/admin/submit/${row.id}/approve`);
    ElMessage.success(Number(row.status) === ST.QUEUED ? '已记审核痕迹，仍在候补队列等空位' : '已通过');
    await refreshAll();
  } catch (e) { /* 拦截器已提示 */ }
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
  await ElMessageBox.confirm(
    '撤销后这条回到「待审」。若是已排期/已补位的点歌，位子会释放并立刻由候补队首递补；若是已驳回的点歌，原格满了会转入候补队列。',
    '撤销审核结果',
    { type: 'warning', confirmButtonText: '撤销' },
  );
  await http.put(`/admin/submit/${row.id}/revoke`);
  ElMessage.success('已撤销，回到待审');
  await refreshAll();
}

async function batchApprove() {
  const r = await http.post('/admin/submit/batch', { ids: selection.value.map((x) => x.id), action: 'approve' });
  ElMessage.success(`批量通过完成${r?.skipped?.length ? `，${r.skipped.length} 条已驳回/已排期被跳过` : ''}`);
  selection.value = [];
  await refreshAll();
}
async function batchReject() {
  const { value: reason } = await ElMessageBox.prompt('驳回原因（会展示给投稿人）', '批量驳回', {
    inputValidator: (v) => (v && v.trim() ? true : '不能为空'),
  });
  const r = await http.post('/admin/submit/batch', { ids: selection.value.map((x) => x.id), action: 'reject', reason });
  ElMessage.success(`批量驳回完成${r?.skipped ? `，${r.skipped} 条已是驳回状态被跳过` : ''}`);
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
  const head = ['ID', '类型', '内容', '歌手/标题', '祝福语/正文', '首选时段', '实际排到时', '候补位次', '投稿人', '学号', '提交时间', '状态', '驳回原因'];
  const state = { 0: '待审核', 1: '已排期/已通过', 2: '已驳回', 3: '候补中', 4: '已补位·待审' };
  const esc2 = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const lines = [head.map(esc2).join(',')];
  data.list.forEach((r) => {
    lines.push([
      r.id, r.type === 1 ? '点歌' : '文稿',
      r.type === 1 ? r.songName : r.articleTitle,
      r.type === 1 ? r.singer : '',
      r.type === 1 ? (r.wishContent || '') : (r.articleContent || ''),
      r.wantBroadcastTime || '', r.scheduledSlot || '',
      Number(r.status) === ST.QUEUED ? (r.queuePos || '') : '',
      r.nickname || '', r.studentNo || r.openid || '',
      fmt(r.createTime), state[r.status] || '', r.rejectReason || '',
    ].map(esc2).join(','));
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
const consoleDetail = ref(null);   // GET /admin/submit/:id → 含 submitter 画像 + v2 card
const rejectMode = ref(false);
const rejectPresets = ['内容不适合播出', '重复投稿', '信息不完整', '时段已排满', '已过播出时段'];

const consoleCard = computed(() => consoleDetail.value?.card || null);

/** 处理台里「这条实际排到哪一格」——补位件看 scheduledSlot，候补件只能看首选 */
const consoleSlotValue = computed(() => {
  const r = consoleRow.value;
  if (!r) return '';
  return r.scheduledSlot || r.wantBroadcastTime || '';
});
const consoleSlotCell = computed(() => cellOf(consoleSlotValue.value));
const consoleSlotHeadText = computed(() => {
  const r = consoleRow.value;
  if (!r) return '';
  const st = Number(r.status);
  if (st === ST.QUEUED) return `首选时段 ${r.wantBroadcastTime || '—'}（候补中，尚未排期）`;
  if (st === ST.PROMOTED) return `实际排到 ${r.scheduledSlot || '—'}`;
  return `播出时段 ${r.scheduledSlot || r.wantBroadcastTime || '—'}`;
});

/** 拉当前这条的详情（投稿内容 + 投稿人画像 + v2 card） */
async function fetchConsoleDetail(row) {
  consoleDetail.value = null;
  if (!row) return;
  try {
    consoleDetail.value = await http.get(`/admin/submit/${row.id}`);
  } catch { /* 静默：拿不到就只显示列表里已有的字段 */ }
}

/** 处理台里的条目集合 = 当前筛选下的待处理条目（0 / 3 / 4；没有则用当前页） */
const consoleRows = computed(() => {
  const todo = rows.value.filter((r) => [ST.PENDING, ST.QUEUED, ST.PROMOTED].includes(Number(r.status)));
  return todo.length ? todo : rows.value;
});

function openConsole(row, keepReject = false) {
  const list = rows.value.filter((r) => [ST.PENDING, ST.QUEUED, ST.PROMOTED].includes(Number(r.status)));
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
  const wasQueued = Number(consoleRow.value.status) === ST.QUEUED;
  acting.value = true;
  try {
    await http.put(`/admin/submit/${consoleRow.value.id}/approve`);
    ElMessage.success(wasQueued ? '已记审核痕迹，仍在候补队列等空位' : '已通过');
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
    ElMessage.success(Number(consoleRow.value.status) === ST.PENDING || Number(consoleRow.value.status) === ST.PROMOTED
      ? '已驳回，位子已释放并由候补队首递补' : '已驳回');
    await refreshAll();
    await afterActioned();
  } finally { acting.value = false; }
}

/** 处理完一条后的去向：还有待处理就取下一条，否则收工 */
async function afterActioned() {
  const left = rows.value.filter((r) => [ST.PENDING, ST.QUEUED, ST.PROMOTED].includes(Number(r.status)));
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
  const kw = router.currentRoute.value.query.keyword;
  if (kw) query.keyword = String(kw);
  setRefreshHandler(refreshAll);
  refreshAll();
  fetchRule();
  ticker = setInterval(() => { nowTs.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
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
.gap18 { gap: 18px; }
.wrap { flex-wrap: wrap; }
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
.s-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

/* ══════════ v2 状态条（深色 tile） ══════════ */
.summary-tile {
  flex-direction: row; align-items: flex-start; flex-wrap: wrap;
  gap: 26px; padding: 18px 22px;
}
.tile-main { flex: 1; min-width: 280px; display: flex; flex-direction: column; gap: 8px; }
.tile-status { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.84); }
.t-dot, .t-dot2 {
  width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--live); box-shadow: 0 0 8px rgba(255, 69, 58, 0.7);
}
.t-dot2 { width: 6px; height: 6px; }
.t-dot.idle, .t-dot2.idle { background: rgba(255, 255, 255, 0.34); box-shadow: none; }
.t-dot2.idle { background: var(--soft); }
.tile-cd { font-size: var(--fs-3xl); font-weight: 600; color: #fff; letter-spacing: var(--ls-tight); line-height: 1.15; }
.tile-meta { font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.56); line-height: 1.7; letter-spacing: var(--ls-wide-sm); }
.tile-metric { flex: none; min-width: 118px; }
.tile-metric .k { font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.62); letter-spacing: var(--ls-wide-sm); }
.tile-metric .v { font-size: var(--fs-num); font-weight: 600; color: #fff; line-height: 1.15; }
.tile-metric .v em { font-style: normal; font-size: var(--fs-xl); color: rgba(255, 255, 255, 0.5); }
.tile-metric .d { font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.5); line-height: 1.6; margin-top: 2px; }
.tile-metric .d b { color: #fff; font-weight: 600; }

/* ══════════ 规则摘要（浅色卡） ══════════ */
.card-plain {
  background: var(--parchment); border-radius: var(--r-card);
  padding: 13px 18px;
}
.card-plain .micro b { color: var(--ink); font-weight: 600; }

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
.chip-slot { white-space: nowrap; }
.chip-slot em { margin-left: 6px; opacity: 0.85; }

.tb-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

/* ══════════ 加载骨架（v8 组件板 · 表格行骨架） ══════════ */
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

/* ══════════ 定稿提醒 ══════════ */
.slot-remind {
  display: flex; align-items: center; gap: 8px;
  margin: -6px 0 14px; padding: 10px 16px;
  background: var(--parchment); border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  font-size: var(--fs-sm); color: var(--ink-2);
}
.slot-remind b { color: var(--accent); }

/* ══════════ 表格卡（v8 card-flush） ══════════ */
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
.rownote {
  margin-top: 4px; font-size: var(--fs-xs); color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
  max-width: 460px; line-height: 1.6;
}
.rownote b { color: var(--ink-2); font-weight: 600; }
.c-time { color: var(--ink-2); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); }
.c-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
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

/* v2 小胶囊（19px）：ano = 说明性微标；pos-chip = 候补位次 */
.ano {
  display: inline-flex; align-items: center; height: 19px; padding: 0 7px;
  border-radius: var(--r-pill); flex: none;
  font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: var(--ls-wide-sm); white-space: nowrap;
}
.ano-acc { background: var(--acc-bg); color: var(--accent); }
.ano-mid { background: var(--divider); color: var(--muted-2); }
.ano-mute { background: var(--parchment); color: var(--muted-2); }
.pos-chip {
  display: inline-flex; align-items: center; height: 19px; padding: 0 8px;
  border-radius: var(--r-pill); flex: none;
  background: #ebebee; color: var(--ink-2);
  font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: var(--ls-wide-sm); white-space: nowrap;
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

/* ══════════ 审核处理台 ══════════ */
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
  max-height: 64vh; overflow: auto;
}
@media (max-width: 1100px) { .cs-body { grid-template-columns: 1fr; } }
.cs-left, .cs-right { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

.cs-person {
  background: var(--tile); color: #fff;
  border-radius: var(--r-card);
  padding: 15px 18px;
  display: flex; flex-direction: column;
  gap: 10px;
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

.cs-person-stats {
  padding-top: 13px;
  border-top: 1px solid rgba(255, 255, 255, 0.22);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 13px;
}
.cs-stat { display: flex; flex-direction: column; align-items: flex-start; text-align: left; min-width: 0; }
.cs-stat-label { font-size: 13px; font-weight: 500; color: #d1d1d6; letter-spacing: 0.3px; }
.cs-stat-num { font-size: 22px; font-weight: 600; color: #fff; line-height: 1.2; margin-top: 1px; }
.cs-stat-date { font-size: 18px; font-weight: 600; color: #fff; margin-top: 5px; }

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
.strike { text-decoration: line-through; color: var(--muted); }
.arrow { color: var(--soft); margin: 0 6px; }
.acc { color: var(--accent); }

/* v2 候补说明卡（强调色描边，只在 3 / 4 出现） */
.cs-v2card {
  background: var(--canvas);
  border: 1px solid #cfe2f7;
  border-radius: var(--r-card);
  padding: 16px 20px;
}
.cs-v2card .hint { font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.7; letter-spacing: var(--ls-wide-sm); }
.cs-v2card .micro b { color: var(--ink-2); }
.cs-v2card .strong { font-weight: 600; color: var(--ink); }

.cs-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cs-actions :deep(.el-button) { height: 40px; margin-left: 0; font-size: var(--fs-md); font-weight: 600; }
.cs-approve { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; }
.cs-approve:hover { background: #0059b3 !important; }
.cs-reject { background: var(--canvas) !important; border-color: var(--hairline) !important; color: var(--ink-2) !important; }
.cs-reject.on { border-color: var(--red-fg) !important; color: var(--red-fg) !important; }

/* v2：处理台右侧的信息块（该格占位 / 候补队列 / 时间窗口） */
.cs-block {
  margin-top: 14px; padding-top: 14px;
  border-top: 1px solid var(--divider);
}
.cs-block-head { margin-bottom: 8px; }
.field-label { font-size: var(--fs-sm); color: var(--muted); }
.cs-block .hint {
  margin-top: 8px; font-size: var(--fs-xs);
  color: var(--muted-2); line-height: 1.65; letter-spacing: var(--ls-wide-sm);
}
.cs-block .strong { font-weight: 600; color: var(--ink); }
.cs-quota-row { display: flex; align-items: baseline; justify-content: space-between; font-size: var(--fs-sm); color: var(--muted); }
.cs-quota-row b { font-size: var(--fs-xl); color: var(--ink); }
.bar { height: 6px; border-radius: 9999px; background: var(--divider); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); border-radius: 9999px; }

.cs-reject-box { margin-top: 16px; opacity: 1; transition: opacity 0.16s var(--ease); }
.cs-reject-box.off { opacity: 0.55; }
.cs-reject-head {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-sm); color: var(--muted); margin-bottom: 10px;
}
.cs-reject-required { height: 19px; font-size: 10.5px; }
.cs-presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.preset {
  border: 1px solid var(--hairline); background: var(--canvas); cursor: pointer;
  height: 28px; padding: 0 12px; border-radius: var(--r-pill);
  font-size: var(--fs-sm); font-family: inherit; color: var(--ink-2);
}
.preset:hover { border-color: var(--soft); }
.preset.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.cs-reject-disabled-hint { margin-top: 8px; color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }

.warnline {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: var(--fs-xs); color: var(--red-fg);
  background: var(--red-bg);
  border-radius: 10px; padding: 10px 12px;
  line-height: 1.6;
}
.warnline :deep(svg) { flex-shrink: 0; margin-top: 2px; }

.cs-history { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--divider); }
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
.cs-history-line { display: flex; align-items: baseline; gap: 10px; }
.cs-history-k { width: 64px; flex: none; color: var(--muted); font-size: var(--fs-xs); }
.cs-history-auto { color: var(--amber-fg); }

.cs-foot { display: flex; align-items: center; gap: 16px; }
.cs-nav { display: flex; gap: 8px; }
.cs-keys { flex: 1; text-align: center; }
.cs-foot-right { display: flex; gap: 10px; }
.cs-foot :deep(.el-button) { border-radius: var(--r-pill) !important; height: 34px; padding: 0 18px; }
.cs-cancel { color: var(--ink-2) !important; }
.cs-confirm { font-weight: 600; }
.cs-confirm--approve { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; }
.cs-confirm--approve:hover { background: #0059b3 !important; border-color: #0059b3 !important; }
.cs-confirm--reject { background: var(--red-fg) !important; border-color: var(--red-fg) !important; color: #fff !important; }
.cs-confirm--reject:hover { background: #9a1d14 !important; border-color: #9a1d14 !important; }
.cs-confirm.is-disabled,
.cs-confirm.is-disabled:hover { background: #e3a9a4 !important; border-color: #e3a9a4 !important; color: #fff !important; }

/* ══════════ 下周排期矩阵 ══════════ */
.sched-tile { flex-direction: row; align-items: flex-start; flex-wrap: wrap; gap: 26px; padding: 16px 20px; margin-bottom: 12px; }
.sched-range { margin-bottom: 12px; line-height: 1.7; }
.sched-range code { font-family: var(--mono); font-size: 11px; }
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
.sched-cell.acc { border-color: var(--accent); }
.sched-cell.free { background: var(--parchment); border-style: dashed; }
.sched-cell.full { opacity: 0.62; }
.sched-cell.full:hover { border-color: var(--hairline); box-shadow: none; }
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
.sc-badge.acc { background: var(--acc-bg); color: var(--accent); }
.sc-badge.fulltag { background: var(--tile); color: #fff; }
.sc-badge.freetag { background: var(--parchment); color: var(--muted); }
.legend {
  display: flex; flex-wrap: wrap; gap: 16px;
  margin-top: 14px; font-size: var(--fs-xs); color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend .sc-badge { position: static; }
.sched-queue { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--divider); }
.qitem {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 10px;
  background: var(--parchment);
  font-size: var(--fs-sm); color: var(--ink-2);
}
.qitem + .qitem { margin-top: 6px; }
.qitem .strong { font-weight: 600; color: var(--ink); }
.qitem .c-sep { color: var(--soft); }
.sched-tip { margin-top: 14px; line-height: 1.7; }
</style>
