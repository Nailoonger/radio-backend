<template>
  <div class="submit-page">
    <!-- ══════════ 协议版周状态条（深色，视觉主角）
         点歌规则已从 v2 的「提交即占位 + 全局候补 + 窗口定稿」改成
         「提交只进审核队列 → 审核通过才拿到候选资格 → 系统按首选时段分组、组内按提交先后统一排期
          → 排不上的进候补 → 到 schedule_lock_at 跑最后一次调度并锁定」。
         所以主角从「窗口定稿时刻」换成「周状态 + 排期锁定倒计时」。
         锁定时刻 = **独立的「审核截止」**（2026-09-25 起与收歌截止拆开：收歌结束只停止收新歌，
         到审核截止才自动排期 + 驳回候补 + 锁定）。所有时刻一律由服务端字段下发，前端不硬编码。 ══════════ -->
    <div class="tile summary-tile">
      <div class="tile-main">
        <div class="tile-status">
          <i class="t-dot" :class="{ idle: !lockMs }"></i>
          <span>
            播出周 {{ weekRangeText }}
            · {{ week.statusText || '—' }}<template v-if="week.status">（{{ week.status }}）</template>
            <template v-if="week.locked"> · 已锁定，排期只读</template>
            <template v-else-if="week.lockPaused"> · 已解锁，<b>自动锁定已暂停</b></template>
          </span>
        </div>
        <div class="tile-cd">
          <template v-if="week.locked">本周排期已锁定</template>
          <template v-else-if="week.lockPaused">已解锁 · 自动锁定已暂停</template>
          <template v-else-if="lockMs === null">锁定时刻未定</template>
          <template v-else>距排期锁定 {{ fmtDur(lockMs) }}</template>
        </div>
        <div class="tile-meta">
          锁定时刻 <b class="tile-strong">{{ hhmm(week.scheduleLockAt) }}</b>
          = 审核截止（收歌截止 {{ hhmm(week.applicationEndAt) }} → 留白 {{ lockOffsetMin }} 分钟）。<br>
          到点系统跑最后一次调度：排不上的候补转「未排上」，该周置为已锁定。
        </div>
        <!-- 写数据的动作仅超管（后端 requireSuperAdmin 已经拦死，前端给出一致的观感） -->
        <div class="tile-actions" v-if="canWrite">
          <el-button
            class="tile-btn tile-btn--primary" size="small"
            :loading="running" :disabled="weekLocked"
            @click="runSchedule"
          >执行排期</el-button>
          <el-button
            class="tile-btn tile-btn--ghost" size="small"
            :disabled="weekLocked"
            @click="openPreview"
          >模拟排期</el-button>
          <span class="tile-sep" />
          <el-button
            v-if="!weekLocked"
            class="tile-btn tile-btn--ghost" size="small"
            :loading="locking"
            @click="lockWeek"
          >锁定本周</el-button>
          <el-button
            v-else
            class="tile-btn tile-btn--ghost" size="small"
            :loading="unlocking"
            @click="unlockWeek"
          >解锁本周</el-button>
          <span class="tile-act-hint">{{ weekLocked ? '已锁定 · 解锁后才能改'
            : (week.lockPaused ? '已解锁 · 改完请手动锁' : '模拟排期只算不写库') }}</span>
        </div>
        <div class="tile-readonly" v-else>
          <i class="t-dot2 idle" />
          <span>排期的执行与锁定由超级管理员负责，你只能审核与查看</span>
        </div>
      </div>

      <div class="tile-metric">
        <div class="k">已排期</div>
        <div class="v num">{{ approvedCount }}</div>
        <div class="d">= 占位（已审且已排）</div>
      </div>

      <div class="tile-metric">
        <div class="k">待排期</div>
        <div class="v num">{{ counts.approveWait || 0 }}</div>
        <div class="d">审核已过 · 等调度</div>
      </div>

      <div class="tile-metric">
        <div class="k">候补中</div>
        <div class="v num">{{ counts.queued || 0 }}</div>
        <div class="d">首选已满 · 等空位</div>
      </div>

      <div class="tile-metric">
        <div class="k">正式位</div>
        <div class="v num">
          {{ approvedCount }}<em>/{{ capUnlimited ? '不限' : (cap.weekCapacity || 0) }}</em>
        </div>
        <div class="d">
          <template v-if="capUnlimited">每格<b>不限</b> × {{ gridCount }} 格</template>
          <template v-else>占位 <b>{{ approvedCount }}</b> · 空 <b>{{ freeCount }}</b></template><br>
          （周一~周五 × {{ perDaySlots }} 个时段）
        </div>
      </div>
    </div>

    <!-- ══════════ 规则摘要（协议版口径） ══════════ -->
    <div class="card-plain">
      <div class="rowc wrap gap18">
        <span class="rowc gap8">
          <span class="tag tag-outline">提交规则</span>
          <span class="micro">每人每周最多 <b>{{ rule.weeklyUserLimit === 0 ? '不限' : rule.weeklyUserLimit }}</b> 次 · 同一首歌一周内{{ rule.dupBlock ? '不可重复' : '可重复' }}</span>
        </span>
        <span class="rowc gap8">
          <span class="tag tag-outline">占位口径</span>
          <span class="micro">
            只有「审核通过 <b>且</b> 已排期」才占位，待审与待排期都<b>不占位</b><template v-if="!capUnlimited"> · 还剩 <b>{{ freeCount }}</b> 个正式位</template>
          </span>
          <a class="link" @click="openSchedule">看排期矩阵 ›</a>
        </span>
        <a class="link" style="margin-left:auto" @click="goSettings">去「点歌设置」改 ›</a>
      </div>
    </div>

    <!-- 锁定提醒（协议版：窗口结束只是停止收歌，真正的死线是排期锁定时刻） -->
    <div class="slot-remind" v-if="todoCounts.total > 0">
      <IconInfo :size="15" />
      <span>
        排期将在 <b>{{ hhmm(week.scheduleLockAt) }}</b> 锁定<template v-if="lockMs !== null">（还有 {{ fmtDur(lockMs) }}）</template>。
        还有 <b class="num">{{ todoCounts.pending }}</b> 首待审<template v-if="todoCounts.approveWait">、<b class="num">{{ todoCounts.approveWait }}</b> 首审核已过但还没排上</template>。
        <template v-if="todoCounts.approveWait">先<b>执行排期</b>把它们落座；</template>待审的在锁定后就没法再通过了。
      </span>
      <a class="link" @click="openSchedule">去处理 ›</a>
    </div>
    <div class="slot-remind is-done" v-else-if="week.locked">
      <IconInfo :size="15" />
      <span>本周已锁定（{{ hhmm(week.lockedAt) }}），排期结果不再变化，剩余候补已转为「未排上」。</span>
      <a class="link" @click="openSchedule">看排期矩阵 ›</a>
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
        <!-- 投稿人 + 学号（协议版把「谁的投稿」压成两行，省一列宽度留给内容） -->
        <el-table-column label="投稿人" width="150">
          <template #default="{ row }">
            <div class="user-cell">
              <span class="avatar-fallback">{{ (row.nickname || '?').charAt(0) }}</span>
              <div class="rv-stack">
                <div class="c-ellipsis">{{ row.nickname || '匿名' }}</div>
                <div class="micro el num">{{ row.studentNo || row.openid || '—' }}</div>
              </div>
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
        <!-- ⚠️ 列宽 148 是量出来的，别改小：
             协议版最长胶囊是「已通过 · 待排期」（8 字），实测 ≈116px
             （fs-xs 11.5px × 8 + 「 · 」间隔 + padding 0 10px + letter-spacing）；
             减去 td 左右各 10px padding，列宽低于 140 就会把胶囊裁掉一截。
             其余胶囊最长 6 字（已补位 · 待审）/ 4 字，都放得下。 -->
        <el-table-column label="状态" width="148" align="center">
          <template #default="{ row }">
            <StatusTag :status="row.status" :label="statusLabel(row)" />
          </template>
        </el-table-column>
        <!-- 操作列按协议版七态分组：改数据一律实体描边按钮，只切视图用文字链接 -->
        <el-table-column label="操作" width="200" fixed="right" align="right">
          <template #default="{ row }">
            <div class="op-cell">
              <!-- 待审(0) / v2 遗留的补位待审(4)：通过 or 驳回 —— 审核员也有权限 -->
              <template v-if="[0, 4].includes(Number(row.status))">
                <el-button size="small" type="primary" @click="approve(row)">通过</el-button>
                <el-button size="small" @click="reject(row)">驳回</el-button>
              </template>

              <!-- 已通过·待排期(6)：超管可手动指派；审核员只能改驳回或看轨迹 -->
              <template v-else-if="Number(row.status) === 6">
                <el-button v-if="canWrite" size="small" type="primary" @click="openAssign(row)">指派时段</el-button>
                <el-button size="small" @click="reject(row)">改驳回</el-button>
                <el-button v-if="!canWrite" size="small" @click="openAssign(row, true)">查看日志</el-button>
              </template>

              <!-- 候补中(3)：等空位；也能人工插队指派（指派 = 改数据，仅超管） -->
              <template v-else-if="Number(row.status) === 3">
                <el-button v-if="canWrite" size="small" type="primary" @click="openAssign(row)">指派时段</el-button>
                <el-button size="small" @click="reject(row)">驳回</el-button>
                <el-button v-if="!canWrite" size="small" @click="openAssign(row, true)">查看日志</el-button>
              </template>

              <!-- 已排期(1)：换格 / 补标播放 —— 均改数据，仅超管 -->
              <template v-else-if="Number(row.status) === 1">
                <template v-if="canWrite">
                  <el-button size="small" :disabled="weekLocked" @click="openAssign(row)">改时段</el-button>
                  <el-button size="small" :disabled="weekLocked" @click="markPlayed(row)">标记播放</el-button>
                </template>
                <el-button size="small" @click="openAssign(row, true)">查看日志</el-button>
              </template>

              <!-- 已播放(5)：只能反悔（仅超管） -->
              <template v-else-if="Number(row.status) === 5">
                <el-button v-if="canWrite" size="small" :disabled="weekLocked" @click="markPlayed(row, false)">取消播放</el-button>
                <el-button size="small" @click="openAssign(row, true)">查看日志</el-button>
              </template>

              <!-- 已驳回(2)：撤销可拉回待审重走流程（仅超管） -->
              <template v-else-if="Number(row.status) === 2">
                <el-button v-if="canWrite" size="small" :disabled="weekLocked" @click="revoke(row)">撤销</el-button>
                <el-button size="small" @click="openAssign(row, true)">查看日志</el-button>
              </template>

              <!-- 已取消(7)：学生自己撤的，终态，只能看轨迹 -->
              <template v-else>
                <el-button size="small" @click="openAssign(row, true)">查看日志</el-button>
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
                  <!-- 被调剂过：首选 → 实际都要写出来，否则审核员会以为学生选错了 -->
                  <template v-if="Number(consoleRow.status) === ST.SCHEDULED && consoleRow.scheduledSlot
                    && consoleRow.wantBroadcastTime && consoleRow.scheduledSlot !== consoleRow.wantBroadcastTime">
                    <span class="strike">{{ consoleRow.wantBroadcastTime }}</span>
                    <span class="arrow">←</span>
                    <b class="acc">实际排到 {{ consoleRow.scheduledSlot }}</b>
                  </template>
                  <template v-else-if="Number(consoleRow.status) === ST.QUEUED">
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

          <!-- ══ 协议版：这条的排期来龙去脉 ══
               「排到哪」交给系统之后，审核按钮旁边必须写清系统会怎么处理它，
               否则管理员只会看到「已通过但没时段」而不知道要不要动手。 -->
          <div class="cs-v2card" v-if="consoleCard && consoleCard.status">
            <div class="rowc gap8" style="margin-bottom:10px">
              <StatusTag :status="Number(consoleRow.status)" :label="statusLabel(consoleRow)" />
              <span class="micro">{{ cardLead }}</span>
            </div>

            <!-- 候补中：位次 + 前面几人 + 首选 + 是否接受调剂 + 锁定时刻 -->
            <template v-if="consoleCard.status === 'waiting'">
              <div class="rowc wrap gap13">
                <span class="rowc gap8"><span class="micro">队内位次</span><span class="strong">第 {{ consoleCard.queuePos || '?' }} 位</span></span>
                <span class="rowc gap8"><span class="micro">前面还有</span><span class="strong">{{ consoleCard.aheadCount ?? 0 }} 人</span></span>
                <span class="rowc gap8"><span class="micro">首选</span><span class="strong">{{ consoleCard.preferred || consoleRow.wantBroadcastTime || '—' }}</span></span>
                <span class="ano" :class="Number(consoleRow.allowReschedule) === 0 ? 'ano-warn' : 'ano-mid'" style="margin-left:auto">
                  {{ Number(consoleRow.allowReschedule) === 0 ? '不接受调剂' : '接受调剂' }}
                </span>
              </div>
              <div class="hint" style="margin-top:10px">
                {{ consoleCard.hint || '有空位时按三级排序自动补位：可接受位置少 → 提交时间早 → 距原时段近。' }}
              </div>
              <div class="hint" style="margin-top:6px">
                不接受调剂的学生只会被补到他的首选时段；队列位次只在同分情况下才起作用。
              </div>
              <div class="hint" style="margin-top:6px" v-if="consoleCard.lockAt || consoleCard.finalizeAt">
                排期锁定 <b>{{ hhmm(consoleCard.lockAt || consoleCard.finalizeAt) }}</b> · 到点仍未排上的候补会被系统转为「未排上」，不占学生每周点歌额度。
              </div>
            </template>

            <!-- 已通过 · 待排期：审核过了，系统还没给它落座 -->
            <template v-else-if="consoleCard.status === 'pending_schedule'">
              <div class="rowc wrap gap13">
                <span class="rowc gap8"><span class="micro">首选</span><span class="strong">{{ consoleCard.preferred || consoleRow.wantBroadcastTime || '—' }}</span></span>
                <span class="ano" :class="Number(consoleRow.allowReschedule) === 0 ? 'ano-warn' : 'ano-mid'" style="margin-left:auto">
                  {{ Number(consoleRow.allowReschedule) === 0 ? '不接受调剂' : '接受调剂' }}
                </span>
              </div>
              <div class="hint" style="margin-top:10px">
                {{ consoleCard.hint || '审核已通过，等系统统一排期：首选时段有空位就落座，排满则转候补。' }}
              </div>
              <div class="hint" style="margin-top:6px">
                想让这条立刻落到某个时段，用列表行上的「<b>指派时段</b>」。
              </div>
            </template>

            <!-- 已排期：实际时段 + 是否被调剂 -->
            <template v-else-if="consoleCard.status === 'scheduled'">
              <div class="rowc wrap gap13">
                <span class="rowc gap8"><span class="micro">播出时段</span><span class="strong acc">{{ consoleCard.scheduledSlot || consoleRow.scheduledSlot || '—' }}</span></span>
                <span class="rowc gap8" v-if="consoleCard.changed">
                  <span class="micro">首选</span><span class="strong strike">{{ consoleCard.preferred || '—' }}</span>
                </span>
                <span class="ano ano-acc" v-if="consoleCard.changed" style="margin-left:auto">已被调剂</span>
              </div>
              <div class="hint" style="margin-top:10px">
                {{ consoleCard.hint || '已占正式位。驳回会立刻释放位子，并自动重跑该周调剂。' }}
              </div>
            </template>

            <!-- 未排上 / 已驳回 -->
            <template v-else-if="consoleCard.status === 'failed'">
              <div class="rowc wrap gap13">
                <span class="rowc gap8"><span class="micro">原因</span><span class="strong">{{ consoleCard.reason || '—' }}</span></span>
                <span class="rowc gap8" v-if="consoleCard.preferred"><span class="micro">首选</span><span class="strong">{{ consoleCard.preferred }}</span></span>
                <span class="ano" :class="consoleCard.systemRejected ? 'ano-warn' : 'ano-mid'" style="margin-left:auto">
                  {{ consoleCard.systemRejected ? '系统未排上' : '人工驳回' }}
                </span>
              </div>
              <div class="hint" style="margin-top:10px">
                <template v-if="consoleCard.systemRejected">排期锁定后仍没有可用位置，系统自动结束 —— 不占学生每周点歌额度。</template>
                <template v-else>人工驳回，位子已释放（协议版口径：驳回自动释放，不需要另跑 release）。</template>
              </div>
            </template>
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

            <!-- ══ 该格占位（协议版口径：占位 = 审核通过 且 已排期） ══ -->
            <div class="cs-block" v-if="consoleRow.type === 1 && consoleSlotCell">
              <div class="cs-block-head">
                <span class="field-label">{{ Number(consoleRow.status) === ST.QUEUED ? '首选格占用' : '该格占位' }} · {{ consoleSlotValue }}</span>
              </div>
              <div class="cs-quota-row">
                <span>
                  <b class="num" style="font-size:17px">{{ consoleSlotCell.scheduled ?? consoleSlotCell.seated }}</b>
                  <span class="micro">/ {{ consoleSlotCell.capacity || '不限' }}</span>
                </span>
                <span class="micro">
                  <template v-if="Number(consoleRow.status) === ST.SCHEDULED">含本条 · </template>
                  {{ consoleSlotCell.full ? '已满' : `还可排 ${consoleSlotCell.left}` }}
                </span>
              </div>
              <div class="bar" style="margin-top:8px" v-if="consoleSlotCell.capacity">
                <i :style="{ width: pct(consoleSlotCell.scheduled ?? consoleSlotCell.seated, consoleSlotCell.capacity) }" />
              </div>
              <div class="hint">
                占位口径：<b>审核通过 且 已排期</b>。驳回 / 撤销会立刻释放位子并自动重跑该周调剂，不需要另跑 release。
              </div>
            </div>

            <!-- ══ 候补队列（协议版：没有人数上限） ══ -->
            <div class="cs-block" v-if="consoleRow.type === 1">
              <div class="cs-block-head">
                <span class="field-label">候补队列（全局 · 无上限）</span>
              </div>
              <div class="cs-quota-row">
                <span><b class="num" style="font-size:17px">{{ queue.total || 0 }}</b> <span class="micro">条候补</span></span>
                <span class="micro" v-if="queue.headWaitMinutes != null">队首已等 {{ fmtWait(queue.headWaitMinutes) }}</span>
                <span class="micro" v-else>队列目前是空的</span>
              </div>
              <div class="rowc gap8" style="margin-top:8px" v-if="queueHead">
                <span class="pos-chip">第 1 位</span>
                <span class="micro el">{{ queueHead.songName }} · {{ queueHead.singer }}</span>
                <span class="ano" :class="queueHead.allowReschedule ? 'ano-mid' : 'ano-warn'">
                  {{ queueHead.allowReschedule ? '接受调剂' : '不接受调剂' }}
                </span>
              </div>
              <div class="hint">
                协议版取消了候补人数上限。顺序只是展示 —— 真正的补位按三级排序：
                <b>可接受位置少 → 提交时间早 → 距原时段近</b>，所以排在队首不等于先补上。
              </div>
            </div>

            <!-- ══ 点歌时间窗口（文案一律来自服务端，前端不硬编码星期与时刻） ══ -->
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
              <div class="hint">
                窗口结束只是<b>停止收歌</b>。真正的死线是<b>排期锁定时刻</b> {{ hhmm(week.scheduleLockAt) }} —— 到点系统跑最后一次调度，
                排不上的候补才转「未排上」；没审完的会停在待审，不会自动驳回。
              </div>
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

    <!-- ══════════ 下周排期矩阵（协议版：周状态机 + 三维格 + 全局候补） ══════════ -->
    <el-dialog v-model="scheduleVisible" title="下周排期" width="1000px" class="schedule-dialog">
      <!-- 周状态机（展示用，不是可点的流程控件）：已走过浅底 / 当前深色实心 / 未到的羊皮纸 -->
      <div class="wkbar">
        <div class="wkflow">
          <template v-for="(w, i) in weekFlow" :key="w.key">
            <span v-if="i" class="wkarrow"></span>
            <span class="wkstep" :class="w.state">{{ w.cn }} <i>{{ w.key }}</i></span>
          </template>
        </div>
        <div class="wkcd">
          <div class="micro">距排期锁定</div>
          <div class="wkcd-v num">
            <template v-if="week.locked">已锁定</template>
            <template v-else-if="week.lockPaused">已解锁</template>
            <template v-else-if="lockMs === null">—</template>
            <template v-else>{{ fmtDur(lockMs) }}</template>
          </div>
          <div class="micro">{{ hhmm(week.scheduleLockAt) }} = 审核截止（收歌截止 {{ hhmm(week.applicationEndAt) }} → 留白 {{ lockOffsetMin }} 分钟）</div>
        </div>
      </div>

      <!-- 深色指标条 -->
      <div class="tile sched-tile">
        <div class="grow" style="flex:1;min-width:200px">
          <div class="tile-status">
            <i class="t-dot" :class="{ idle: !win.open }"></i>
            收歌 {{ hhmm(win.start || week.applicationStartAt) }} ~ {{ hhmm(week.applicationEndAt || win.closesAt) }} · {{ win.open ? '收歌中' : '已截止' }}
          </div>
          <div class="tile-meta" style="margin-top:8px">
            占位口径：<b class="tile-strong">审核通过 且 已排期</b>。待审与待排期都<b class="tile-strong">不占位</b>，
            所以「已排期」会小于「已提交」。<br>
            审核截止 <b class="tile-strong">{{ hhmm(week.scheduleLockAt) }}</b> —— 收歌结束后到这一刻之前，都还能慢慢审、手动调格子。
          </div>
          <!-- 排期执行 / 模拟 / 锁定 = 写数据，仅超管（后端 requireSuperAdmin 已锁） -->
          <div class="tile-actions" v-if="canWrite">
            <el-button class="tile-btn tile-btn--primary" size="small" :loading="running" :disabled="weekLocked" @click="runSchedule">执行排期</el-button>
            <el-button class="tile-btn tile-btn--ghost" size="small" :disabled="weekLocked" @click="openPreview">模拟排期</el-button>
            <span class="tile-sep" />
            <el-button
              v-if="!weekLocked"
              class="tile-btn tile-btn--ghost" size="small" :loading="locking" @click="lockWeek"
            >锁定本周</el-button>
            <el-button
              v-else
              class="tile-btn tile-btn--ghost" size="small" :loading="unlocking" @click="unlockWeek"
            >解锁本周</el-button>
            <span class="tile-act-hint">{{ weekLocked ? '已锁定 · 解锁后才能改'
              : (week.lockPaused ? '已解锁 · 改完请手动锁' : '模拟排期只算不写库') }}</span>
          </div>
          <div class="tile-readonly" v-else>
            <i class="t-dot2 idle" />
            <span>排期的执行与锁定由超级管理员负责，你只能审核与查看</span>
          </div>
        </div>
        <div class="tile-metric"><div class="k">已排期</div><div class="v num">{{ approvedCount }}</div><div class="d">= 占位</div></div>
        <div class="tile-metric"><div class="k">待排期</div><div class="v num">{{ counts.approveWait || 0 }}</div><div class="d">审核已过</div></div>
        <div class="tile-metric"><div class="k">候补中</div><div class="v num">{{ queue.total || 0 }}</div><div class="d">等空位</div></div>
        <div class="tile-metric"><div class="k">空位</div><div class="v num">{{ capUnlimited ? '不限' : freeCount }}</div><div class="d">{{ capUnlimited ? '每格不限' : `${gridCount} 格 × ${cap.capacity || 0} − 占位 ${approvedCount}` }}</div></div>
      </div>

      <div class="sched-range micro">
        <template v-if="schedule.rangeText">{{ schedule.weekStart }} ~ {{ schedule.weekEnd }}（{{ schedule.rangeText }}） · </template>
        每格正式位 {{ cap.capacity || '不限' }}
        <span style="margin-left:6px">已排期 = <code>review_status=APPROVED</code> 且 <code>schedule_status=APPROVED</code>（按实际排期 <code>scheduled_slot</code> 统计）</span>
      </div>

      <!-- 三维矩阵：一格可以同时有「已排期 / 候补 / 待审」三类人，所以用三行标签，不用单一角标 -->
      <div class="sched-grid">
        <div class="sched-day" v-for="d in schedule.days" :key="d.date">
          <div class="sched-day-head">
            <b>{{ d.weekday }}</b><span class="micro">{{ d.monthDay }}</span>
          </div>
          <button
            v-for="s in d.slots" :key="s.value"
            type="button"
            class="sched-cell"
            :class="{ haswait: s.waiting > 0, haspend: s.pending > 0, free: !s.scheduled }"
            @click="filterSlot(s)"
          >
            <span class="sc-time">{{ s.period }} {{ s.time }}</span>
            <span class="sc-count"><b class="num">{{ s.scheduled }}</b><i>/</i>{{ s.capacity || '不限' }}</span>
            <span class="sc-tags">
              <span class="sc-tag fulltag" v-if="s.full">已满</span>
              <span class="sc-tag freetag" v-else-if="!s.scheduled">{{ freeSlotLabel }}</span>
              <span class="sc-tag wait" v-if="s.waiting > 0">候补 {{ s.waiting }}</span>
              <span class="sc-tag pend" v-if="s.pending > 0">待审 {{ s.pending }}</span>
            </span>
          </button>
        </div>
      </div>

      <div class="legend">
        <span><span class="sc-tag wait">候补 n</span>首选这一格、还没排上（可能被调剂走）</span>
        <span><span class="sc-tag pend">待审 n</span>还没审，不占位</span>
        <span><span class="sc-tag fulltag">已满</span>该格正式位用尽</span>
        <span><span class="sc-tag freetag">{{ freeSlotLabel }}</span>{{ freeSlotWhy }}</span>
      </div>

      <!-- 全局候补队列（协议版取消了候补人数上限） -->
      <div class="sched-queue" v-if="queue.items && queue.items.length">
        <div class="rowc gap8" style="margin-bottom:10px">
          <span class="sec-title" style="font-size:14px">候补队列（全局 · 无人数上限）</span>
          <span class="micro">顺序只是展示，真正的补位由三级排序决定 · 跨所有时段</span>
        </div>
        <div class="qitem" v-for="it in queue.items" :key="it.id">
          <span class="pos-chip">第 {{ it.pos }} 位</span>
          <span class="strong el">{{ it.songName }} <span class="c-sep">·</span> {{ it.singer }}</span>
          <span class="micro el">首选 {{ it.wantBroadcastTime || '—' }}</span>
          <span class="micro num">{{ it.submittedAt ? fmt(it.submittedAt).slice(5) : '' }}</span>
          <span class="ano" :class="it.allowReschedule ? 'ano-mid' : 'ano-warn'">
            {{ it.allowReschedule ? '接受调剂' : '不接受调剂' }}
          </span>
        </div>
      </div>
      <div class="micro sched-tip" v-else>
        候补队列目前是空的 —— 首选时段还有空位的人都已经落座了。
      </div>

      <div class="micro sched-tip">
        点任意格子筛出该时段的投稿（含候补件的首选时段） · 三级排序 = <b>可接受位置少 → 提交时间早 → 距原时段近</b>，
        所以「排在队首」不等于「先补上」—— 不接受调剂的人只在首选时段空出来时才动。
      </div>
    </el-dialog>

    <!-- ══════════ 人工指派时段 / 状态轨迹 ══════════
         协议版把「排到哪」交给了系统（initialAllocate + reschedule），
         所以管理端必须留一个能手动兜底的入口：POST /admin/submit/:id/assign。
         已驳回 / 已取消（终态）进来时只读，只看轨迹不做写入。 -->
    <el-dialog
      v-model="assignVisible"
      :title="assignReadonly ? '状态轨迹' : '人工指派时段'"
      width="960px" top="7vh" class="assign-dialog"
    >
      <div class="as-head" v-if="assignRow">
        <StatusTag :status="assignRow.status" :label="statusLabel(assignRow)" />
        <span class="pos-chip" v-if="Number(assignRow.status) === ST.QUEUED && assignRow.queuePos">
          第 {{ assignRow.queuePos }} 位
        </span>
        <div class="grow">
          <div class="as-title">
            <template v-if="assignRow.type === 1">{{ assignRow.songName }} <span class="c-sep">·</span> {{ assignRow.singer }}</template>
            <template v-else>{{ assignRow.articleTitle }}</template>
          </div>
          <div class="micro" style="margin-top:3px">
            {{ assignRow.nickname || '匿名' }}（{{ assignRow.studentNo || assignRow.openid || '—' }}）
            <template v-if="assignRow.type === 1">
              · 首选 <b>{{ assignRow.wantBroadcastTime || '—' }}</b>
              · <b :class="noReschedule ? 'is-red' : ''">{{ noReschedule ? '不接受调剂' : '接受调剂' }}</b>
              · {{ fmt(assignRow.createTime) }} 提交
            </template>
          </div>
        </div>
      </div>

      <div class="as-body">
        <!-- 左：选新时段（只读模式不显示） -->
        <div class="as-main" v-if="!assignReadonly">
          <div class="sec-head">
            <span class="as-sub-title">选一个新时段</span>
            <span class="micro">周一~周五 · 每格正式位 {{ cap.capacity || '不限' }} · 括号里是「已占 / 上限」</span>
          </div>

          <div class="slot-list" v-if="assignOptions.length">
            <button
              v-for="o in assignOptions" :key="o.value"
              type="button"
              class="slotbtn"
              :class="{ cur: o.isPreferred, selected: o.selected }"
              :disabled="o.disabled"
              @click="assignSlot = o.value"
            >
              <span class="slotbtn-l">
                {{ o.label }}<template v-if="o.isPreferred">（当前首选）</template>
              </span>
              <span class="micro num">
                {{ o.seated }} / {{ o.capacity || '不限' }}
                · <template v-if="o.disabled">已满</template><template v-else-if="!o.seated">空位</template><template v-else>还可排 {{ o.left }}</template>
                <template v-if="o.waiting"> · {{ o.waiting }} 人在候补</template>
              </span>
            </button>
          </div>
          <div class="micro" v-else>下周还没有配置播出时段，先去「点歌设置」加时段。</div>

          <div class="micro as-note" v-if="noReschedule">
            <b class="is-amber">该学生不接受调剂。</b>
            人工指派可以越过这条限制（管理员权限），但服务端会把这次指派记为 <code>MANUAL</code>，
            学生端会如实显示「系统把你调剂到了 X」。
          </div>
          <div class="micro as-note">
            指派后：这条立刻置为<b>已排期</b>并占住所选格子；若它原本在候补队列里，队列会自动重排。
            已满的格子不能指派（按钮置灰）—— 避免把原来占着的人挤掉。
          </div>
        </div>

        <!-- 右：这条的完整轨迹（读 request_status_log，三维各自的 from → to） -->
        <div class="as-side">
          <div class="as-sub-title">这条的完整轨迹</div>
          <div class="as-logs" v-if="assignLogs.length">
            <div class="as-log" v-for="(g, i) in assignLogs" :key="g.id || i">
              <div class="micro">{{ dimCn(g.dimension) }}</div>
              <div class="as-log-v">{{ g.from_status || g.fromStatus || '—' }} → {{ g.to_status || g.toStatus }}</div>
              <div class="micro">
                {{ fmt(g.created_at || g.create_time) }} · {{ opCn(g.operator_name || g.operatorName) }}<template v-if="g.reason"> · {{ g.reason }}</template>
              </div>
            </div>
          </div>
          <div class="micro as-empty" v-else>还没有状态变更记录。</div>

          <div class="micro as-note">
            轨迹读 <code>GET /admin/submit/:id/status-logs</code>；
            时段的变动另记在 <code>assignment_logs</code>（from_slot → to_slot）。
          </div>

          <div class="as-side-acts" v-if="assignRow && Number(assignRow.type) === 1">
            <el-button
              v-if="Number(assignRow.status) === ST.PLAYED"
              size="small" style="width:100%"
              @click="markPlayed(assignRow, false)"
            >取消播放标记</el-button>
            <el-button
              v-else-if="Number(assignRow.status) === ST.SCHEDULED"
              size="small" style="width:100%"
              @click="markPlayed(assignRow, true)"
            >标记为已播放</el-button>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="as-foot">
          <span class="micro grow">
            {{ assignReadonly ? '只读：这条已经到终态了' : '保存后立刻重跑该周的调剂，并刷新排期矩阵' }}
          </span>
          <el-button @click="assignVisible = false">取消</el-button>
          <el-button
            v-if="!assignReadonly"
            type="primary"
            :loading="assigning"
            :disabled="!assignSlot"
            @click="saveAssign"
          >保存指派</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- ══════════ 模拟排期（dryRun，只算不写库；超管） ══════════ -->
    <el-dialog v-model="previewVisible" width="880px" top="7vh" class="preview-dialog">
      <template #header>
        <div class="pp-head">
          <span class="pp-title">模拟排期结果</span>
          <span class="micro">只算不写库 · {{ preview.week?.weekStartDate || week.weekStartDate || '—' }} 那一周</span>
          <span class="tag" :class="preview.crossSlot ? 'tag-pass' : 'tag-amber'">
            {{ preview.crossSlot ? '已放开跨时段调剂' : '收歌中 · 只做原位递补' }}
          </span>
        </div>
        <div class="pp-modes">
          <el-radio-group v-model="previewMode" size="small" @change="loadPreview">
            <el-radio-button value="auto">按闸门（收歌中只原位递补）</el-radio-button>
            <el-radio-button value="force">模拟「立即执行排期」</el-radio-button>
          </el-radio-group>
          <span class="micro">{{ preview.crossSlotReason || '' }}</span>
        </div>
      </template>

      <div v-loading="previewLoading" class="pp-wrap">
        <div class="pp-grid">
          <div class="pp-block">
            <div class="pp-bt"><span class="n">本次落座</span><span class="c">{{ preview.plan?.assign?.length || 0 }} 条</span></div>
            <div class="pp-item" v-for="x in preview.plan?.assign || []" :key="'a' + x.id">
              <span class="nm">{{ x.songName }}</span>
              <span class="fl">{{ x.want }}</span><span class="ar">→</span><span class="to">{{ x.to }}</span>
              <span class="cost">{{ costText(x.cost) }}</span>
            </div>
            <div class="pp-empty" v-if="!(preview.plan?.assign || []).length">当前没有新的落座动作（都已在位上）</div>
          </div>

          <div class="pp-block">
            <div class="pp-bt"><span class="n">原位递补</span><span class="c">{{ preview.plan?.promote?.length || 0 }} 条</span></div>
            <div class="pp-item" v-for="x in preview.plan?.promote || []" :key="'p' + x.id">
              <span class="nm">{{ x.songName }}</span>
              <span class="fl">{{ x.want }}</span><span class="ar">→</span><span class="to">{{ x.to }}</span>
              <span class="cost">{{ costText(x.cost) }}</span>
            </div>
            <div class="pp-empty" v-if="!(preview.plan?.promote || []).length">本格没空出位置，无需递补</div>
            <div class="pp-note" v-else>本格空出，按提交时间补上最早的一位</div>
          </div>

          <div class="pp-block">
            <div class="pp-bt"><span class="n">跨时段调剂</span><span class="c">{{ preview.plan?.rescheduled?.length || 0 }} 条</span></div>
            <div class="pp-item" v-for="x in preview.plan?.rescheduled || []" :key="'r' + x.id">
              <span class="nm">{{ x.songName }}</span>
              <span class="fl">{{ x.want }}</span><span class="ar">→</span><span class="to">{{ x.to }}</span>
              <span class="cost">{{ costText(x.cost) }}</span>
            </div>
            <div class="pp-empty" v-if="!(preview.plan?.rescheduled || []).length">
              <template v-if="!preview.crossSlot">
                <span class="tag tag-mute">收歌未截止</span>
                空位<b>不外借</b> —— 要留给首选那一格的申请者。收歌截止后再看，这一栏才会有内容。
              </template>
              <template v-else>没有需要跨时段调剂的人（要么都在首选位上了，要么不接受调剂）</template>
            </div>
          </div>

          <div class="pp-block">
            <div class="pp-bt"><span class="n">锁定后将被自动驳回</span><span class="c">{{ preview.plan?.waiting?.length || 0 }} 条</span></div>
            <div class="pp-item" v-for="x in preview.plan?.waiting || []" :key="'w' + x.id">
              <span class="nm">{{ x.songName }}</span>
              <span class="fl">{{ x.want }}</span><span class="ar">→</span><span class="to">无可用位置</span>
              <span class="cost">—</span>
            </div>
            <div class="pp-empty" v-if="!(preview.plan?.waiting || []).length">太好了，没有会被驳回的候补</div>
          </div>
        </div>

        <div class="pp-slots" v-if="(preview.slots || []).length">
          <span class="micro">模拟后各格占用：</span>
          <span class="pp-slot" v-for="s in preview.slots" :key="'s' + s.value" :class="{ full: s.full }">
            {{ s.value }} <b>{{ s.seated }}</b>→<b>{{ s.after }}</b>/{{ s.capacity || '不限' }}
          </span>
        </div>

        <div class="pp-foot">
          这张面板<b>不改动任何数据</b>，纯粹先看一眼。跨时段调剂的代价列用的是成本表 ——
          <b>同一天其他时段 10 · 前后一天相同时段 20 · 前后一天其他时段 30 · 更远日期 50</b>。
        </div>
      </div>

      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
        <el-button type="primary" :loading="running" @click="runScheduleFromPreview">按此结果执行排期</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { useAuthStore } from '@/stores/auth';
import { IconSearch, IconClose, IconInfo } from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';
import { setPageHeader, clearPageHeader, setRefreshHandler, clearRefreshHandler } from '@/utils/pageHeader';

/* ══════════ 协议版派生镜像 status（与后端 songStatusService.ST 一致）
     真实状态在后端三维（review_status / schedule_status / play_status）里，
     前端只用这个镜像做筛选与显示，**不要反推三维**。 ══════════ */
const ST = {
  PENDING: 0,        // 待审核
  SCHEDULED: 1,      // 已排期
  REJECTED: 2,       // 已驳回（人工驳回，或锁定后系统「未排上」）
  QUEUED: 3,         // 候补中
  PROMOTED: 4,       // 【v2 遗留】已补位 · 待审 —— 协议版不再产生，只用于读旧数据
  PLAYED: 5,         // 已播放
  APPROVE_WAIT: 6,   // 已通过 · 待排期
  CANCELLED: 7,      // 已取消（学生撤销 / 放弃候补）
};

const router = useRouter();
const auth = useAuthStore();
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
/**
 * 8 个桶的计数，与派生镜像 status 一一对应（协议版）：
 *   0 待审核 / 6 已通过·待排期 / 3 候补中 / 1 已排期 / 5 已播放 / 2 已驳回 / 7 已取消
 * ⚠️ v2 的 4「已补位 · 待审」在协议版不再产生，所以没有它的桶。
 */
const counts = reactive({
  all: 0, pending: 0, approveWait: 0, queued: 0,
  approved: 0, played: 0, rejected: 0, cancelled: 0,
});
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

/* ══════════ 下周排期矩阵（同时也是容量与周状态的口径来源） ══════════ */
const schedule = ref({ days: [], rangeText: '', capacity: 0, weekStart: '', weekEnd: '' });
const scheduleVisible = ref(false);

/* ── 协议版：周状态 + 排期锁定倒计时 ──
   week 来自 GET /admin/submit/schedule 的 week 字段（songSchedulingService.weekView）。
   secondsToLock 服务端只给一次，本地按秒递减（ticker 已在跑），所以倒计时不再发请求。 */
const week = ref({});
const running = ref(false);   // 执行排期 in-flight
const locking = ref(false);   // 锁定本周 in-flight
const unlocking = ref(false); // 解锁本周 in-flight

const lockMs = computed(() => {
  const iso = week.value.scheduleLockAt;
  if (!iso) return null;
  return new Date(iso).getTime() - nowTs.value;
});

/** 收歌截止 → 审核截止的留白（分钟）。锁定时刻 = 审核截止，所以这个差值就是「审稿窗口」 */
const lockOffsetMin = computed(() => {
  const a = week.value.applicationEndAt;
  const b = week.value.scheduleLockAt;
  if (!a || !b) return 0;
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
});

/**
 * 跨时段闸门（与后端 `songSchedulingService.canCrossSlot()` 同口径）：
 * 收歌截止前，别处的空位**不外借** —— 要留给首选那一格的原申请者。
 * 只用来切文案，真正拦人的是服务端。
 */
const crossSlotAllowed = computed(() => {
  const end = week.value.applicationEndAt;
  if (!end) return false;
  return nowTs.value >= new Date(end).getTime();
});
/** 空位格子的说法：收歌中「不外借」 / 已截止「可填」 */
const freeSlotLabel = computed(() => (crossSlotAllowed.value ? '可填' : '不外借'));
const freeSlotWhy = computed(() => (crossSlotAllowed.value
  ? '执行排期时会被填上'
  : '发给本时段提交最早的候补'));

/**
 * 写数据的动作一律仅超管 —— 与后端 `requireSuperAdmin` 对齐（V1 §2.1）。
 * 不是「点了才吃 403」：执行排期 / 模拟排期 / 锁定 / 改时段 / 指派 / 标记播放 / 撤销 全部按角色显隐。
 */
const canWrite = computed(() => !!auth.isSuperAdmin);
/** 已锁定的周排期只读（后端也会拒，这里给出一致的观感） */
const weekLocked = computed(() => !!week.value.locked);

const weekRangeText = computed(() => {
  const s = schedule.value.weekStart || week.value.weekStartDate;
  const e = schedule.value.weekEnd;
  if (!s) return '—';
  return e ? `${dayjs(s).format('MM-DD')} ~ ${dayjs(e).format('MM-DD')}` : dayjs(s).format('MM-DD');
});

/** 周状态机（week.status 的中文镜像，与后端 WEEK_STATUS_CN 同口径；只用于画状态带） */
const WEEK_FLOW = [
  { key: 'DRAFT', cn: '未发布' },
  { key: 'APPLICATION', cn: '收歌中' },
  { key: 'REVIEW', cn: '审核中' },
  { key: 'SCHEDULING', cn: '排期已生成' },
  { key: 'LOCKED', cn: '已锁定' },
];
const weekFlow = computed(() => {
  const cur = week.value.status;
  const ci = WEEK_FLOW.findIndex((x) => x.key === cur);
  return WEEK_FLOW.map((x, i) => ({
    ...x,
    state: x.key === cur ? 'on' : (ci >= 0 && i < ci ? 'done' : ''),
  }));
});

/** 锁定前要盯的两类：还没审的、审过但还没落座的 */
const todoCounts = computed(() => ({
  pending: counts.pending || 0,
  approveWait: counts.approveWait || 0,
  total: (counts.pending || 0) + (counts.approveWait || 0),
}));

async function fetchSchedule() {
  try {
    const d = await http.get('/admin/submit/schedule');
    schedule.value = d || {};
    week.value = d?.week || {};
  } catch { /* 静默 */ }
}

/** 执行第一轮排期 + 全局调剂（幂等，重复点不会重复落座） */
async function runSchedule() {
  running.value = true;
  try {
    const r = await http.post('/admin/submit/schedule/run', {});
    ElMessage.success(
      `排期完成：落座 ${r?.assigned ?? 0} 条 · 进候补 ${r?.waiting ?? 0} 条 · 递补 ${(r?.promoted || 0) + (r?.rescheduled || 0)} 条`
    );
    await refreshAll();
  } catch { /* 拦截器已提示 */ }
  finally { running.value = false; }
}

/* ══════════ 模拟排期（只算不写库，超管专用）
     接 POST /admin/submit/schedule/preview —— dryRun 不落库，算法出问题也不污染正式数据。
     twoMode：「自动路径」= 受收歌闸门约束（收歌中只做原位递补）；
               「立即执行」= 等同于点「执行排期」（放开跨时段调剂）。 ══════════ */
const previewVisible = ref(false);
const previewLoading = ref(false);
const preview = ref({});
const previewMode = ref('auto');   // auto | force
const COST_CN = {
  0: '首选', 10: '同天异时段', 20: '隔天同时段', 30: '隔天异时段', 50: '更远日期',
};
const costText = (c) => {
  if (c === null || c === undefined) return '—';
  return COST_CN[c] || `成本 ${c}`;
};

async function loadPreview() {
  previewLoading.value = true;
  try {
    const body = previewMode.value === 'force' ? { crossSlot: true } : {};
    preview.value = await http.post('/admin/submit/schedule/preview', body) || {};
  } catch { /* 拦截器已提示 */ }
  finally { previewLoading.value = false; }
}
function openPreview() {
  previewVisible.value = true;
  previewMode.value = 'auto';
  loadPreview();
}
/** 按预览结果执行（= 正式跑一遍，会写库） */
async function runScheduleFromPreview() {
  await runSchedule();
  if (!running.value) previewVisible.value = false;
}

/**
 * 锁定本周（协议 §18）。到点由调度器自动执行，这里只是人工提前锁。
 * 服务端未到锁定时刻会拒；这时问一次要不要 force —— 提前锁是不可逆的，必须二次确认。
 */
async function lockWeek() {
  try {
    await ElMessageBox.confirm(
      '锁定后这一周的排期不再变化：剩余候补会被系统自动驳回（学生端显示「未排上」）。确定锁定？',
      '锁定本周排期',
      { type: 'warning', confirmButtonText: '锁定' },
    );
  } catch { return; }

  locking.value = true;
  try {
    await http.post('/admin/submit/schedule/lock', {});
    ElMessage.success('已锁定本周排期');
    await refreshAll();
  } catch (e) {
    // 「还没到锁定时刻」→ 再确认一次，走 force
    if (e && /锁定时刻/.test(e.message || '')) {
      try {
        await ElMessageBox.confirm(`${e.message}。仍要提前锁定吗？`, '提前锁定', {
          type: 'warning', confirmButtonText: '强制锁定',
        });
      } catch { return; }
      await http.post('/admin/submit/schedule/lock', { force: true });
      ElMessage.success('已强制锁定本周排期');
      await refreshAll();
    }
  } finally { locking.value = false; }
}

/**
 * 解锁本周（撤销锁定）—— 超管专用，给「锁错了 / 锁完发现还要改」兜底。
 *
 * 服务端做三件事：退回 SCHEDULING、把锁定时被系统自动驳回的候补退回「候补中」、
 * **暂停本周的自动锁定**（否则下一轮 sweep 会立刻按 schedule_lock_at 把它锁回去，
 * 解锁就等于没做）。所以恢复自动锁定的唯一办法是重新点一次「锁定本周」。
 */
async function unlockWeek() {
  try {
    await ElMessageBox.confirm(
      '解锁后这一周退回「排期已定稿」，可以继续改格子、重跑排期。\n'
      + '锁定时被系统自动驳回的候补会退回「候补中」。\n'
      + '⚠️ 本周的自动锁定会被暂停 —— 改完请手动点「锁定本周」，否则它不会自己锁。',
      '解锁本周排期',
      { type: 'warning', confirmButtonText: '确认解锁' },
    );
  } catch { return; }

  unlocking.value = true;
  try {
    const r = await http.post('/admin/submit/schedule/unlock', {});
    ElMessage.success(
      r?.restored
        ? `已解锁，锁定时被自动驳回的 ${r.restored} 条已退回候补`
        : '已解锁（自动锁定已暂停）',
    );
    await refreshAll();
  } catch { /* 拦截器已提示 */ }
  finally { unlocking.value = false; }
}

/* ══════════ 人工指派（协议版新增：排到哪交给了系统，所以必须留手动兜底） ══════════ */
const assignVisible = ref(false);
const assignReadonly = ref(false);   // 已驳回 / 已取消 → 只读看轨迹
const assignRow = ref(null);
const assignSlot = ref('');
const assignLogs = ref([]);
const assigning = ref(false);

/** 可选时段列表：从排期矩阵展开，标出「当前首选 / 已满不可选 / 已选中」 */
const assignOptions = computed(() => {
  const r = assignRow.value;
  const out = [];
  for (const d of schedule.value.days || []) {
    for (const s of d.slots || []) {
      const isPreferred = !!(r && s.value === r.wantBroadcastTime);
      const seated = s.scheduled ?? s.seated ?? 0;
      out.push({
        value: s.value,
        label: `${d.monthDay} ${d.weekday} · ${s.period} ${s.time}`,
        seated,
        capacity: s.capacity || 0,
        left: s.left,
        waiting: s.waiting || 0,
        isPreferred,
        // 已满的格子不能指派进去（除非它本来就是这条的首选，那只是「回到原位」）
        disabled: !!s.full && !isPreferred,
        selected: assignSlot.value === s.value,
      });
    }
  }
  return out;
});

const noReschedule = computed(() => Number(assignRow.value?.allowReschedule) === 0);

const DIM_CN = { review: '审核', schedule: '排期', play: '播放' };
const OP_CN = { SYSTEM: '系统', ADMIN: '管理员', USER: '学生本人' };
function dimCn(d) { return DIM_CN[d] || d || '—'; }
function opCn(o) { return OP_CN[o] || o || '系统'; }

async function fetchAssignLogs(id) {
  try {
    const d = await http.get(`/admin/submit/${id}/status-logs`);
    // ⚠️ 服务端 raw:true 返回的是**下划线列名**，同时模型里 timestamps 又加了 create_time，
    //    所以时间字段两个都取一下，别只认一个。
    assignLogs.value = Array.isArray(d) ? d : [];
  } catch { assignLogs.value = []; }
}

async function openAssign(row, readonly = false) {
  assignRow.value = row;
  assignReadonly.value = !!readonly;
  assignSlot.value = '';
  assignLogs.value = [];
  assignVisible.value = true;
  fetchAssignLogs(row.id);
  // 顺手拉一次 detail，拿到最新的 allow_reschedule / scheduled_slot（列表可能是几分钟前的快照）
  try {
    const d = await http.get(`/admin/submit/${row.id}`);
    if (d && assignRow.value && assignRow.value.id === row.id) assignRow.value = { ...row, ...d };
  } catch { /* 静默：拿不到就用列表里的字段 */ }
}

async function saveAssign() {
  if (!assignSlot.value) return ElMessage.warning('请先选一个新时段');
  assigning.value = true;
  try {
    await http.post(`/admin/submit/${assignRow.value.id}/assign`, { slot: assignSlot.value });
    ElMessage.success('已调整播出时段，该周调剂已重跑');
    assignVisible.value = false;
    await refreshAll();
  } catch { /* 拦截器已提示 */ }
  finally { assigning.value = false; }
}

/** 标记已播放 / 取消播放标记（协议版平时由系统到点自动标，人工只在出事时补） */
async function markPlayed(row, played = true) {
  if (!played) {
    try {
      await ElMessageBox.confirm('取消后这条会从「已播放」回到「已排期」。', '取消播放标记', {
        type: 'warning', confirmButtonText: '取消播放标记',
      });
    } catch { return; }
  }
  try {
    await http.put(`/admin/submit/${row.id}/played`, { played });
    ElMessage.success(played ? '已标记为已播放' : '已取消播放标记');
    await refreshAll();
  } catch { /* 拦截器已提示 */ }
}
function openSchedule() { scheduleVisible.value = true; }

const allSlots = computed(() => (schedule.value.days || []).flatMap((d) => d.slots || []));
const gridCount = computed(() => allSlots.value.length);
const perDaySlots = computed(() => {
  const d0 = (schedule.value.days || [])[0];
  return (d0 && d0.slots ? d0.slots.length : 0) || '?';
});
const seatedTotal = computed(() => allSlots.value.reduce((n, s) => n + (s.scheduled ?? s.seated ?? 0), 0));

/**
 * 「已排期」= 占了正式位的条数。
 *
 * ⚠️ 协议版把占位口径唯一化：`review_status=APPROVED AND schedule_status=APPROVED`。
 *    矩阵里的 pending（首选这一格但还在审）与 waiting（首选这一格但还没排上）**都不占位**，
 *    所以这里直接等于各格 seated 之和 —— v2 那种「seated − pending − promoted」的减法
 *    在协议版会把占位数算少（因为 seated 里本来就不含它们），别再写回去。
 */
const approvedCount = computed(() => seatedTotal.value);

/** 每格正式位 0 = 不限（songQueueService.weekCapacity 的口径）；摘要条 / 提醒行 / 矩阵头都按这个显示，
 *  否则会照字面把「不限」显示成 0，看起来像没有容量（2026-09-21 真机验收抓到）。 */
const capUnlimited = computed(() => !Number(cap.value.capacity));
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

/* 协议版状态桶（8 个）。顺序 = 管理员每天扫一眼的关注度顺序：
   待审 → 待排期（唯一要催的桶）→ 候补 → 已排期 → 历史态。 */
const statusChips = computed(() => [
  { label: '全部', v: '', n: counts.all },
  { label: '待审核', v: 0, n: counts.pending },
  { label: '已通过·待排期', v: 6, n: counts.approveWait },
  { label: '候补中', v: 3, n: counts.queued },
  { label: '已排期', v: 1, n: counts.approved },
  { label: '已播放', v: 5, n: counts.played },
  { label: '已驳回', v: 2, n: counts.rejected },
  { label: '已取消', v: 7, n: counts.cancelled },
]);

/**
 * 状态胶囊的文案覆盖 —— 只为**文稿**存在。
 *
 * ⚠️ 文稿没有「排期」这个概念，但后端派生的 status 也是 6（APPROVED_WAIT，
 *    因为 review=APPROVED 且 schedule 永远是 UNASSIGNED），照默认文案会显示
 *    「已通过 · 待排期」—— 对文稿是错的，所以这里覆盖成「已通过」。
 */
function statusLabel(row) {
  if (Number(row.type) !== 2) return '';
  const st = Number(row.status);
  if (st === ST.SCHEDULED || st === ST.APPROVE_WAIT) return '已通过';
  if (st === ST.PLAYED) return '已播出';
  if (st === ST.CANCELLED) return '已取消';
  return '';
}

/**
 * 标题行的小徽章（只有点歌有）。
 * 协议版的变化：待审不再占位 → 去掉「占位中」；补位待审没了 → 去掉「补位」。
 * 现在留在这个位置的是「审核员必须一眼看到的差异信息」：排队第几位、需不需要催调度、有没有被调剂过。
 */
function rowBadge(row) {
  if (Number(row.type) !== 1) return null;
  const st = Number(row.status);
  if (st === ST.QUEUED) return { kind: 'queue', text: `第 ${row.queuePos || '?'} 位` };
  if (st === ST.APPROVE_WAIT) return { kind: 'acc', text: '待调度' };
  if (st === ST.SCHEDULED && row.wantBroadcastTime && row.scheduledSlot
      && row.wantBroadcastTime !== row.scheduledSlot) {
    return { kind: 'acc', text: '已调剂' };
  }
  if (st === ST.REJECTED && row.autoRejected) return { kind: 'mid', text: '系统' };
  return null;
}
function badgeClass(kind) {
  if (kind === 'queue') return 'pos-chip';
  if (kind === 'acc') return 'ano-acc';
  if (kind === 'warn') return 'ano-warn';
  return 'ano-mid';
}

/**
 * 副行（协议版）：写清「这条现在卡在哪、接下来会怎样」。
 * ⚠️ 模板里用 v-html 渲染（要画删除线/强调色），所以所有来源文本先过 esc()。
 * ⚠️ 「是否接受调剂」必须出现在每一行 —— 这是协议版新增的关键信息，
 *    不接受调剂的人只在首选时段空出来时才排得上，审核员看不到就会误判。
 */
function rowNote(row) {
  if (Number(row.type) === 2) return esc(row.articleContent || '—');

  const st = Number(row.status);
  const want = row.wantBroadcastTime || '';
  const cell = cellOf(want);
  const occ = cell
    ? ` · 该格已占 ${cell.scheduled ?? cell.seated ?? 0}/${cell.capacity || '不限'}`
    : '';
  const resched = Number(row.allowReschedule) === 0
    ? ' · <b class="is-red">不接受调剂</b>'
    : ' · 接受调剂';

  if (st === ST.PENDING) {
    return `首选 ${esc(want || '—')} · 不占位，等审核${resched}`;
  }
  if (st === ST.APPROVE_WAIT) {
    return `首选 ${esc(want || '—')} · 审核已过、还没落座，执行排期时落座${occ}${resched}`;
  }
  if (st === ST.QUEUED) {
    const ahead = row.queueAhead != null ? row.queueAhead : Math.max((Number(row.queuePos) || 1) - 1, 0);
    return `首选 ${esc(want || '—')}（已满）· 第 ${row.queuePos || '?'} 位，前面还有 <b>${ahead}</b> 人${resched}`;
  }
  if (st === ST.SCHEDULED) {
    const moved = want && row.scheduledSlot && want !== row.scheduledSlot;
    return moved
      ? `排到 <b class="acc">${esc(row.scheduledSlot)}</b> <span class="arrow">←</span> 首选 <span class="strike">${esc(want)}</span>（系统调剂）${occ}`
      : `排到 <b class="acc">${esc(row.scheduledSlot || want || '—')}</b>${occ}`;
  }
  if (st === ST.PLAYED) {
    return `已播出 ${esc(row.scheduledSlot || want || '—')}${row.playedAt ? ` · ${fmt(row.playedAt)} 标记` : ''}`;
  }
  if (st === ST.REJECTED) {
    return row.autoRejected
      ? `系统未排上：${esc(row.rejectReason || '排期已锁定，没有可用位置')}`
      : `驳回：${esc(row.rejectReason || '—')}`;
  }
  if (st === ST.CANCELLED) {
    return '学生已撤销 / 放弃候补（行保留，只改状态）';
  }
  if (st === ST.PROMOTED) {
    return `首选 <span class="strike">${esc(want || '—')}</span> <span class="arrow">→</span> 实际 <b class="acc">${esc(row.scheduledSlot || '—')}</b>（v2 遗留状态）`;
  }
  const slot = row.scheduledSlot || want;
  return `${esc(slot || '未选时段')}${occ}`;
}
/** 副行用 innerHTML 渲染（要画删除线/强调色），所有来源文本先转义 */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 各桶计数：并发打 8 个 pageSize=1 的请求取 total。
 * 为什么不在前端一次拉全量自己数：列表可能上千条，全量拉回来只为数数不划算；
 * 8 个 total 请求每个都走索引 count，比拉全量轻得多。
 */
async function fetchCounts() {
  try {
    const one = (params) => http.get('/admin/submit/list', { params: { page: 1, pageSize: 1, ...params } });
    const [a, p, w, q, y, pl, r, c] = await Promise.all([
      one({}), one({ status: 0 }), one({ status: 6 }), one({ status: 3 }),
      one({ status: 1 }), one({ status: 5 }), one({ status: 2 }), one({ status: 7 }),
    ]);
    counts.all = a.total;
    counts.pending = p.total;
    counts.approveWait = w.total;
    counts.queued = q.total;
    counts.approved = y.total;
    counts.played = pl.total;
    counts.rejected = r.total;
    counts.cancelled = c.total;
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
    subtitle: [
      `共 ${counts.all} 条`,
      `待审 ${counts.pending} 条`,
      `待排期 ${counts.approveWait} 条`,
      `候补 ${counts.queued} 条`,
      `已排期 ${counts.approved} 条`,
    ].join(' · '),
  });
}

/* ── 单条 / 批量操作 ── */
const acting = ref(false);
async function approve(row) {
  try {
    await http.put(`/admin/submit/${row.id}/approve`);
    // ⚠️ 协议版：审核通过**不会当场排期**，只是拿到候选资格。
    //    toast 必须把这一步讲明白，否则管理员点完看到状态变成「已通过·待排期」会以为没生效。
    ElMessage.success(
      Number(row.status) === ST.QUEUED
        ? '已记录审核，这条仍在候补队列里等空位'
        : '已通过，等系统排期落座（可在「已通过·待排期」桶里看到）'
    );
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
    '撤销后这条回到「待审」，之前审过/排过的痕迹都清掉。若是已排期的点歌，位子立刻释放并自动重跑该周的调剂，候补里最合适的会被提上来。',
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
  const head = ['ID', '类型', '内容', '歌手/标题', '祝福语/正文', '首选时段', '实际排到时', '接受调剂', '候补位次', '投稿人', '学号', '提交时间', '状态', '驳回原因'];
  const state = {
    0: '待审核', 1: '已排期/已通过', 2: '已驳回', 3: '候补中',
    4: '已补位·待审（v2 遗留）', 5: '已播放', 6: '已通过·待排期', 7: '已取消',
  };
  const esc2 = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const lines = [head.map(esc2).join(',')];
  data.list.forEach((r) => {
    lines.push([
      r.id, r.type === 1 ? '点歌' : '文稿',
      r.type === 1 ? r.songName : r.articleTitle,
      r.type === 1 ? r.singer : '',
      r.type === 1 ? (r.wishContent || '') : (r.articleContent || ''),
      r.wantBroadcastTime || '', r.scheduledSlot || '',
      r.type === 1 ? (Number(r.allowReschedule) === 0 ? '不接受' : '接受') : '',
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
/* 协议版去掉了两个 v2 理由：「时段已排满」（排满是转候补，不是驳回）、
   「已过播出时段」（窗口外根本提交不进来，服务端 40907 先拦了）。 */
const rejectPresets = ['内容不适合播出', '重复投稿', '信息不完整', '歌词内容不适宜', '该曲一周内已点过'];

const consoleCard = computed(() => consoleDetail.value?.card || null);

/** 排期卡的分支 → 一句人话（cardFor 的四种 status） */
const CARD_LEAD = {
  waiting: '这条还没排到期，正在全局候补队列里排队',
  pending_schedule: '审核已过，等系统统一排期（还没落座）',
  scheduled: '系统已经给它排好了时段',
  failed: '这条没有排上',
};
const cardLead = computed(() => CARD_LEAD[consoleCard.value?.status] || '这条的排期状态');

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

/**
 * 处理台里「需要人工动手」的状态：待审(0)、候补中(3)、v2 遗留的补位待审(4)。
 * ⚠️ 6「已通过 · 待排期」**不进处理台** —— 它审核已经过了，要的是「指派时段」而不是审核动作；
 *    列表行上单独给了那个按钮。
 */
const TODO_STATUS = [ST.PENDING, ST.QUEUED, ST.PROMOTED];
const isTodo = (r) => TODO_STATUS.includes(Number(r.status));

/** 处理台里的条目集合 = 当前筛选下需要人工动手的条目（没有则退回当前页） */
const consoleRows = computed(() => {
  const todo = rows.value.filter(isTodo);
  return todo.length ? todo : rows.value;
});

function openConsole(row) {
  const list = rows.value.filter(isTodo);
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
    ElMessage.success(wasQueued
      ? '已记录审核，这条仍在候补队列里等空位'
      : '已通过，等系统排期落座');
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
    // ⚠️ 协议版：驳回**自动释放位子**（占位口径 = 已审且已排期），不需要另跑 release；
    //    服务端驳回后还会顺带重跑该周调剂，把候补里最合适的提上来。
    const wasSeated = Number(consoleRow.value.status) === ST.SCHEDULED;
    await http.put(`/admin/submit/${consoleRow.value.id}/reject`, { reason: rejectReason.value });
    ElMessage.success(wasSeated ? '已驳回，位子已释放并重跑了该周调剂' : '已驳回');
    await refreshAll();
    await afterActioned();
  } finally { acting.value = false; }
}

/** 处理完一条后的去向：还有需要动手的就取下一条，否则收工 */
async function afterActioned() {
  const left = rows.value.filter(isTodo);
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

/* ══════════ 锁定提醒（协议版：死线是排期锁定时刻，不是窗口结束） ══════════ */
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
/* 格边框语义（协议版一格可以同时有三类人）：
   强调色 = 有人首选这一格但还在候补 · 琥珀 = 还有人没审 · 虚线 = 这格还空着 */
.sched-cell.haswait { border-color: var(--accent); }
.sched-cell.haspend { border-color: var(--amber-fg); }
.sched-cell.free { background: var(--parchment); border-style: dashed; }
.sc-time { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.sc-count { font-size: var(--fs-md); color: var(--ink-2); }
.sc-count b { font-size: var(--fs-xl); color: var(--ink); }
.sc-count i { font-style: normal; color: var(--soft); margin: 0 1px; }
/* 三行标签流式排 —— v2 是绝对定位的单一角标，装不下「已满 + 候补 n + 待审 n」同时出现 */
.sc-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 1px; }
.sc-tag {
  font-size: var(--fs-2xs); font-weight: 600; line-height: 1;
  padding: 3px 6px; border-radius: var(--r-pill); white-space: nowrap;
}
.sc-tag.wait { background: var(--acc-bg); color: var(--accent); }
.sc-tag.pend { background: var(--amber-bg); color: var(--amber-fg); }
.sc-tag.fulltag { background: var(--tile); color: #fff; }
.sc-tag.freetag { background: #ebebee; color: var(--muted); }
.legend {
  display: flex; flex-wrap: wrap; gap: 16px;
  margin-top: 14px; font-size: var(--fs-xs); color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}
.legend span { display: inline-flex; align-items: center; gap: 6px; }
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

/* ══════════ 协议版：深色 tile 里的强调文字与动作组 ══════════ */
.tile-strong { color: #fff; font-weight: 600; }
/* ⚠️ flex-wrap 必须有：弹窗里的 sched-tile 被 4 个指标列挤窄，动作行放不下时
   尾部提示会被 flex-shrink 压成 ~60px 宽 → 折成 3 行（实测 h=48 而非 16）。
   允许换行 + flex:none 后，提示会整条掉到第二行，保持单行。 */
.tile-actions { display: flex; align-items: center; gap: 8px; row-gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.tile-act-hint { flex: none; font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.42); letter-spacing: var(--ls-wide-sm); }
/* 深色底上的按钮：element-plus 默认白底深字，在深色卡里会糊掉，整组覆盖。
   强调色仍只有一个（--accent / --accent-dark），不用渐变、不用彩色投影。 */
.tile-btn { border-radius: var(--r-pill) !important; height: 30px; padding: 0 14px; font-size: var(--fs-sm) !important; }
.tile-btn--primary {
  background: var(--accent-dark) !important; border-color: var(--accent-dark) !important; color: #fff !important;
}
.tile-btn--primary:hover { background: #4facff !important; border-color: #4facff !important; }
.tile-btn--ghost {
  background: transparent !important; border-color: rgba(255, 255, 255, 0.32) !important;
  color: #fff !important; font-weight: 500;
}
.tile-btn--ghost:hover { border-color: rgba(255, 255, 255, 0.6) !important; background: rgba(255, 255, 255, 0.08) !important; }
.tile-btn.is-disabled, .tile-btn.is-disabled:hover {
  background: rgba(255, 255, 255, 0.1) !important; border-color: transparent !important;
  color: rgba(255, 255, 255, 0.4) !important;
}
.tile-sep { width: 1px; height: 20px; background: rgba(255, 255, 255, 0.24); margin: 0 2px; }

/* 普通管理员看到的只读提示（深色卡里的虚线块，与 v8 的只读态一致） */
.tile-readonly {
  display: flex; align-items: center; gap: 8px; margin-top: 18px; align-self: flex-start;
  font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.55);
  border: 1px dashed rgba(255, 255, 255, 0.24); border-radius: 10px; padding: 8px 12px;
}

/* ══════════ 模拟排期面板（预览 §04） ══════════ */
.preview-dialog .pp-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.preview-dialog .pp-title { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); }
.preview-dialog .pp-modes { display: flex; align-items: center; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
.pp-wrap { min-height: 120px; }
.pp-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 18px; }
.pp-block { padding: 14px 0; border-bottom: 1px solid var(--divider); }
.pp-bt { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pp-bt .n { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.pp-bt .c { margin-left: auto; font-size: var(--fs-xs); color: var(--muted-2); font-family: var(--mono); }
.pp-item { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); padding: 5px 0; }
.pp-item .nm { min-width: 84px; font-weight: 500; color: var(--ink); }
.pp-item .fl { color: var(--muted); font-size: var(--fs-xs); }
.pp-item .ar { color: var(--soft); }
.pp-item .to { color: var(--ink-2); font-size: var(--fs-xs); }
.pp-item .cost {
  margin-left: auto; font-size: var(--fs-2xs); color: var(--muted-2);
  background: var(--parchment); border-radius: 5px; padding: 2px 6px;
}
.pp-empty, .pp-note { font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.7; padding: 4px 0; }
.pp-empty .tag { margin-right: 6px; }
.pp-slots { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 0; }
.pp-slot {
  font-size: var(--fs-2xs); font-family: var(--mono); color: var(--muted-2);
  background: var(--parchment); border-radius: 6px; padding: 3px 7px;
}
.pp-slot.full { color: var(--accent); background: var(--acc-bg); }
.pp-foot {
  margin-top: 4px; padding: 10px 12px; background: var(--parchment);
  border-radius: 10px; font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.8;
}

/* ══════════ 周状态机（排期矩阵顶部 · 展示用） ══════════ */
.wkbar {
  display: flex; align-items: center; gap: 22px; flex-wrap: wrap;
  background: #fff; border: 1px solid var(--hairline);
  border-radius: var(--r-card); padding: 14px 18px; margin-bottom: 12px;
}
.wkflow { display: flex; align-items: center; flex-wrap: wrap; gap: 0; }
.wkstep {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: var(--r-pill);
  background: var(--parchment); font-size: var(--fs-sm); color: var(--muted);
  letter-spacing: var(--ls-wide-sm); white-space: nowrap;
}
.wkstep.on { background: var(--ink); color: #fff; font-weight: 600; }
.wkstep.done { background: var(--acc-bg); color: var(--accent); }
.wkstep i { font-style: normal; font-size: var(--fs-2xs); opacity: 0.7; letter-spacing: 0; }
.wkarrow { width: 16px; flex: none; height: 1px; background: var(--hairline); margin: 0 5px; }
.wkcd { margin-left: auto; text-align: right; }
.wkcd-v { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); line-height: 1.3; }

/* ══════════ 小胶囊补一间：琥珀（不接受调剂 / 系统未排上） ══════════ */
.ano-warn { background: var(--amber-bg); color: var(--amber-fg); }
/* 行内强调：红＝要留意（不接受调剂），琥珀＝提醒（越权指派） */
.is-red { color: var(--red-fg); font-weight: 600; }
.is-amber { color: var(--amber-fg); font-weight: 600; }

/* 锁定后的提醒条换成正向色，别再拿强调色催 */
.slot-remind.is-done { color: var(--muted-2); }
.slot-remind.is-done b { color: var(--ink-2); }

/* ══════════ 人工指派弹窗 ══════════ */
:deep(.assign-dialog) {
  border-radius: var(--r-tile) !important;
  overflow: hidden;
  box-shadow: 0 30px 80px -30px rgba(0, 0, 0, 0.45) !important;
}
:deep(.assign-dialog .el-dialog__header) { margin: 0; padding: 16px 22px; border-bottom: 1px solid var(--divider); }
:deep(.assign-dialog .el-dialog__body) { padding: 0; }
:deep(.assign-dialog .el-dialog__footer) { padding: 12px 22px; border-top: 1px solid var(--divider); }

.as-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 22px; background: var(--parchment);
  border-bottom: 1px solid var(--hairline);
}
.as-title { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.as-body { display: grid; grid-template-columns: minmax(0, 1fr) 330px; }
@media (max-width: 900px) { .as-body { grid-template-columns: 1fr; } }
.as-main { padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.as-side {
  border-left: 1px solid var(--hairline); background: var(--parchment);
  padding: 18px 20px; display: flex; flex-direction: column; gap: 10px;
  max-height: 60vh; overflow-y: auto;
}
.as-sub-title { font-size: 14px; font-weight: 600; color: var(--ink); }

.slot-list { display: flex; flex-direction: column; gap: 8px; }
.slotbtn {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  width: 100%; text-align: left; cursor: pointer;
  border: 1px solid var(--hairline); border-radius: 10px; background: #fff;
  padding: 10px 13px; font-family: inherit; font-size: var(--fs-md); color: var(--ink-2);
  transition: border-color 0.15s var(--ease), background 0.15s var(--ease);
}
.slotbtn:hover:not(:disabled) { border-color: var(--soft); }
.slotbtn-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 当前首选：强调浅底 —— 一眼看出它现在在哪一格 */
.slotbtn.cur { border-color: var(--accent); background: var(--acc-bg); color: var(--accent); font-weight: 600; }
/* 要指派过去的那一格：深色实心，和「当前首选」区分开 */
.slotbtn.selected { border-color: var(--ink); background: var(--ink); color: #fff; font-weight: 600; }
.slotbtn.selected .micro { color: rgba(255, 255, 255, 0.66); }
.slotbtn:disabled { opacity: 0.45; cursor: not-allowed; }

.as-note {
  background: var(--parchment); border-radius: 10px; padding: 10px 12px;
  line-height: 1.7; letter-spacing: var(--ls-wide-sm);
}
.as-note code { font-family: var(--mono); font-size: 11px; background: #fff; border-radius: 4px; padding: 1px 4px; }
.as-logs { display: flex; flex-direction: column; }
.as-log { padding: 10px 0; border-bottom: 1px solid var(--hairline); }
.as-log:last-child { border-bottom: none; }
.as-log-v { font-size: var(--fs-sm); font-weight: 600; color: var(--ink); margin: 3px 0 2px; }
.as-log .micro { line-height: 1.6; }
.as-empty { padding: 12px 0; }
.as-side-acts { margin-top: auto; padding-top: 10px; }
.as-side-acts :deep(.el-button) { margin-left: 0; border-radius: var(--r-pill) !important; height: 32px; }
.as-foot { display: flex; align-items: center; gap: 12px; }
.as-foot :deep(.el-button) { border-radius: var(--r-pill) !important; height: 34px; padding: 0 18px; }
</style>
