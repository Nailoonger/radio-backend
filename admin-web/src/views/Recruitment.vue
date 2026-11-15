<template>
  <div class="recruitment-page">
    <el-alert v-if="!recruitmentAvailable" :title="recruitmentUnavailableMessage" type="warning" :closable="false" show-icon />
    <template v-else>
      <div class="section-toolbar">
        <div class="segment">
          <button type="button" :class="{ on: !batchQuery.archived }" @click="changeArchive(false)">当前批次</button>
          <button type="button" :class="{ on: batchQuery.archived }" @click="changeArchive(true)">历史归档</button>
        </div>
        <div class="actions">
          <span v-if="batchQuery.archived" class="micro">历史批次只读，可查名单与结果</span>
          <el-button :loading="batchLoading" @click="refresh">刷新</el-button>
          <el-button v-if="auth.isSuperAdmin" type="primary" @click="openConfig()">新建招新批次</el-button>
        </div>
      </div>

      <!-- 多批次时才有这一排：只有一个批次时不占位置（原先是常驻表格，一行数据撑满整屏） -->
      <div v-if="batches.length > 1" class="batch-switch">
        <button
          v-for="item in batches"
          :key="item.id"
          type="button"
          class="batch-chip"
          :class="{ on: item.id === selectedBatch?.id }"
          @click="selectBatch(item)"
        >
          <span class="batch-chip-title">{{ item.title }}</span>
          <span class="batch-chip-state">{{ batchState(item) }}</span>
        </button>
        <el-pagination
          v-if="batchTotal > batchQuery.pageSize"
          v-model:current-page="batchQuery.page"
          :page-size="batchQuery.pageSize"
          :total="batchTotal"
          layout="prev, pager, next"
          small
          class="batch-pager"
          @current-change="loadBatches"
        />
      </div>

      <template v-if="selectedBatch">
        <!-- ══════════ 批次带：状态 / 标题 / 关键事实 / 四个数 ══════════ -->
        <section class="batch-band" v-loading="batchLoading">
          <div class="batch-main">
            <div class="batch-title-row">
              <span class="tag" :class="batchTag(selectedBatch)">{{ batchState(selectedBatch) }}</span>
              <h2 class="batch-title">{{ selectedBatch.title }}</h2>
            </div>
            <div class="batch-meta">
              <span>报名 <b>{{ formatTime(selectedBatch.opensAt) }}</b> 至 <b>{{ formatTime(selectedBatch.closesAt) }}</b></span><i></i>
              <span>面向 <b>{{ gradeScopeText }}</b></span><i></i>
              <span>自定义问题 <b>{{ selectedBatch.questions?.length || 0 }}</b> 道</span><i></i>
              <span>无需学生账号</span>
            </div>
            <p class="batch-note">{{ batchNote }}</p>
          </div>
          <div class="kpis">
            <div class="kpi"><b>{{ batchStats.total }}</b><span>报名总数</span></div>
            <div class="kpi" :class="{ alert: (selectedBatch.unresolvedCount || 0) > 0 }"><b>{{ selectedBatch.unresolvedCount ?? 0 }}</b><span>待决定</span></div>
            <button type="button" class="kpi kpi-btn" :class="{ mute: !selectedBatch.interviewOrderCount }" :disabled="!selectedBatch.publishedAt" @click="openOrder">
              <b>{{ selectedBatch.interviewOrderCount || 0 }}</b><span>已排面试顺序</span>
            </button>
            <button type="button" class="kpi kpi-btn" :class="{ mute: !batchStats.accepted }" @click="filterByStatus('accepted')">
              <b>{{ batchStats.accepted }}</b><span>已拟录取</span>
            </button>
          </div>
        </section>

        <div class="batch-bar">
          <span class="micro">{{ batchHint }}</span>
          <div class="actions">
            <el-button v-if="selectedBatch.publishedAt" @click="openPlan">面试安排{{ selectedBatch.interview ? '（已发布）' : '' }}</el-button>
            <el-button v-if="selectedBatch.publishedAt" @click="openOrder">面试顺序{{ selectedBatch.orderGeneratedAt ? `（${selectedBatch.interviewOrderCount || 0} 人）` : '' }}</el-button>
            <template v-if="auth.isSuperAdmin">
              <el-button @click="openConfig(selectedBatch)">{{ selectedBatch.archivedAt ? '查看批次' : selectedBatch.publishedAt ? '查看 / 编辑批次' : '配置批次' }}</el-button>
              <el-button v-if="!selectedBatch.publishedAt" type="primary" :loading="batchActing" @click="batchAction('publish')">发布报名</el-button>
              <el-button v-if="selectedBatch.publishedAt && !selectedBatch.closedAt && !selectedBatch.resultPublishedAt && !selectedBatch.archivedAt" :loading="batchActing" @click="batchAction('close')">截止报名</el-button>
              <el-button v-if="canGenerateOrder(selectedBatch)" :loading="orderGenerating" @click="generateOrder">{{ selectedBatch.orderGeneratedAt ? '重新生成面试顺序' : '生成随机面试顺序' }}</el-button>
              <el-button v-if="selectedBatch.publishedAt && !selectedBatch.resultPublishedAt" type="primary" :loading="batchActing" :disabled="!isClosed(selectedBatch) || selectedBatch.unresolvedCount !== 0" @click="batchAction('results')">统一发布录取结果</el-button>
              <el-button v-if="selectedBatch.resultPublishedAt && !selectedBatch.archivedAt" :loading="batchActing" @click="batchAction('archive')">归档批次</el-button>
              <el-button type="danger" plain :loading="batchActing" @click="removeBatch(selectedBatch)">删除批次</el-button>
            </template>
          </div>
        </div>

        <!-- ══════════ 主区：名单卡撑满 + 右栏流程 ══════════ -->
        <div class="workspace">
          <section class="card" v-loading="applicationLoading">
            <div class="list-head">
              <div class="list-title">
                <h3>报名名单</h3>
                <span class="micro">{{ applicationTotalText }}</span>
              </div>
              <div class="filters">
                <el-select v-model="applicationQuery.grade" placeholder="全部年级" clearable class="grade-filter" @change="filterApplications">
                  <el-option v-for="item in gradeOptions" :key="item" :label="item" :value="item" />
                </el-select>
                <el-select v-model="applicationQuery.status" placeholder="全部状态" clearable class="status-filter" @change="filterApplications">
                  <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </div>
            </div>

            <div ref="listBody" class="table-wrap">
              <el-table v-if="applications.length" :data="applications" row-key="id" :height="tableHeight">
                <el-table-column label="报名者" min-width="150">
                  <template #default="{ row }">
                    <div class="who">
                      <span class="who-av">{{ (row.name || '?').charAt(0) }}</span>
                      <div class="who-main">
                        <div class="who-name">{{ row.name }}</div>
                        <div class="who-sub">{{ row.grade }} · {{ row.className }}<span v-if="row.legacyStudentNo"> · 历史学号 {{ row.legacyStudentNo }}</span></div>
                      </div>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="QQ 号" width="110"><template #default="{ row }"><span class="num">{{ row.qqNumber || '未填写' }}</span></template></el-table-column>
                <el-table-column label="面试序号" width="86"><template #default="{ row }"><span class="seq">{{ row.interviewSequence ? `#${String(row.interviewSequence).padStart(2, '0')}` : '—' }}</span></template></el-table-column>
                <el-table-column label="面试安排（北京时间）" min-width="190">
                  <template #default="{ row }">
                    <div v-if="row.interview" class="iv">{{ formatTime(row.interview.at) }}<span v-if="row.interviewCustom" class="solo">单独配置</span><span class="micro">{{ row.interview.location }}</span></div>
                    <span v-else class="micro">未安排</span>
                  </template>
                </el-table-column>
                <el-table-column label="审核状态" width="134">
                  <template #default="{ row }"><span class="tag" :class="applicationTag(row)">{{ applicationState(row) }}</span></template>
                </el-table-column>
                <el-table-column label="提交时间" width="144"><template #default="{ row }"><span class="num">{{ formatTime(row.createdAt) }}</span></template></el-table-column>
                <el-table-column label="操作" width="122" align="right">
                  <template #default="{ row }"><button class="pill pill-acc" @click.stop="openApplication(row)">查看 / 审核</button></template>
                </el-table-column>
              </el-table>
              <EmptyState
                v-else
                :title="emptyTitle"
                :description="emptyDescription"
              />
            </div>

            <div class="list-foot">
              <span class="micro">{{ applications.length ? `本页 ${applications.length} 条` : '暂无记录' }}</span>
              <el-pagination
                v-if="applicationTotal"
                v-model:current-page="applicationQuery.page"
                v-model:page-size="applicationQuery.pageSize"
                :page-sizes="[20, 50, 100]"
                :total="applicationTotal"
                layout="total, sizes, prev, pager, next"
                small
                @current-change="loadApplications"
                @size-change="filterApplications"
              />
            </div>
          </section>

          <aside class="rail">
            <div class="rail-card">
              <div class="rail-head"><h3>招新流程</h3><span class="micro">{{ flowHint }}</span></div>
              <div class="steps">
                <div v-for="(step, index) in flowSteps" :key="index" class="step" :class="step.cls">
                  <span class="step-mark">
                    <svg v-if="step.cls === 'done'" viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1.6 5.2l2.2 2.2L8.4 2.8" /></svg>
                    <svg v-else-if="step.cls === 'now'" viewBox="0 0 6 6" width="6" height="6"><circle cx="3" cy="3" r="2.4" fill="currentColor" /></svg>
                  </span>
                  <div>
                    <div class="step-title">{{ step.label }}</div>
                    <div class="step-sub">{{ step.sub }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="rail-card">
              <div class="rail-head"><h3>批次信息</h3></div>
              <dl>
                <div class="info-row"><dt>报名时间</dt><dd>{{ formatTime(selectedBatch.opensAt) }}<br />至 {{ formatTime(selectedBatch.closesAt) }}</dd></div>
                <div class="info-row"><dt>报名范围</dt><dd>{{ gradeScopeText }}</dd></div>
                <div class="info-row"><dt>面试安排</dt><dd>{{ selectedBatch.interview ? '已发布' : '未安排' }}</dd></div>
                <div class="info-row"><dt>面试顺序</dt><dd>{{ selectedBatch.orderGeneratedAt ? `${selectedBatch.interviewOrderCount || 0} 人` : '未生成' }}</dd></div>
                <div class="info-row"><dt>结果查询</dt><dd>报名者凭查询码查看</dd></div>
              </dl>
            </div>
          </aside>
        </div>
      </template>

      <section v-else class="card empty-card" v-loading="batchLoading">
        <EmptyState
          variant="content"
          :title="batchQuery.archived ? '暂无历史批次' : '暂无招新批次'"
          :description="auth.isSuperAdmin ? '新建批次，配置报名问题后发布。' : '超级管理员发布招新批次后，可在这里查看和审核报名。'"
        />
      </section>
    </template>

    <!-- ══════════ 批次配置（处理台样式：题头 + 同底色两栏） ══════════ -->
    <el-dialog v-model="configVisible" width="min(1080px, 96vw)" top="6vh" class="console-dialog recruitment-console" :show-close="false" :close-on-click-modal="false">
      <template #header>
        <div class="console-heading">
          <div class="console-heading-main">
            <span class="console-kind">招新</span>
            <strong>{{ config.id ? '批次配置' : '新建招新批次' }}</strong>
          </div>
          <el-button text :disabled="configSaving" @click="configVisible = false">关闭</el-button>
        </div>
        <div class="micro console-subtitle">{{ config.id ? config.title || '未命名批次' : '填写批次信息、固定信息必填规则与自定义问题' }}</div>
      </template>
      <div class="console-columns config-body">
        <section class="console-column">
          <div class="desk-card">
            <div class="desk-head">
              <h3>批次信息</h3>
              <span class="tag" :class="config.publishedAt ? (configStarted ? 'tag-mute' : 'tag-wait') : 'tag-mute'">{{ configLockText }}</span>
            </div>
            <p v-if="config.publishedAt" class="micro desk-note">{{ config.archivedAt ? '历史批次已归档，配置只读。' : config.closedAt ? '报名已手动截止：题目、名称和报名时间已锁定，可修改介绍。' : configStarted ? '批次已开始：题目、名称、必填规则和报名时间已锁定，可修改介绍。' : '批次已发布：题目与名称已锁定，报名开始前可调整时间与必填规则。' }}</p>
            <el-form label-position="top" :disabled="!!config.archivedAt">
              <el-form-item label="批次名称（最多 100 字）" required><el-input v-model="config.title" :disabled="!!config.publishedAt" placeholder="例如：2026 年秋季广播站招新" /></el-form-item>
              <el-form-item label="招新介绍（最多 10000 字）" required><el-input v-model="config.intro" type="textarea" :rows="5" placeholder="填写招新说明、报名要求和联系渠道。" /></el-form-item>
              <div class="two-columns">
                <el-form-item label="报名开始时间（北京时间）" required><el-date-picker v-model="config.opensAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" :disabled="configStarted" placeholder="选择开始时间" /></el-form-item>
                <el-form-item label="报名截止时间（北京时间）" required><el-date-picker v-model="config.closesAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" :disabled="configStarted" placeholder="选择截止时间" /></el-form-item>
              </div>
            </el-form>
          </div>

          <div class="desk-card">
            <div class="desk-head">
              <h3>固定信息</h3>
              <span class="micro">开关控制是否必填</span>
            </div>
            <div class="fixed-list">
              <div v-for="field in FIXED_FIELDS" :key="field.key" class="fixed-row">
                <div class="fixed-name">
                  <strong>{{ field.label }}</strong>
                  <span class="micro">{{ field.hint }}</span>
                </div>
                <div class="fixed-switch">
                  <el-switch v-model="config.fixedFields[field.key].required" active-text="必填" :disabled="!canEditFixed" />
                </div>
              </div>
            </div>
            <div v-for="field in OPTION_FIELDS" :key="field.key" class="option-block">
              <div class="option-block-head">
                <strong>{{ field.label }}可选值</strong>
                <el-button size="small" :disabled="!canEditFixed || config.fixedFields[field.key].options.length >= 50" @click="config.fixedFields[field.key].options.push('')">添加选项</el-button>
              </div>
              <div class="option-grid">
                <div v-for="(option, optionIndex) in config.fixedFields[field.key].options" :key="`${field.key}-${optionIndex}`" class="option-cell">
                  <span class="micro">{{ optionIndex + 1 }}</span>
                  <el-input v-model="config.fixedFields[field.key].options[optionIndex]" :disabled="!canEditFixed" :placeholder="`${field.label}选项`">
                    <template #suffix>
                      <button type="button" class="opt-del" title="移除这一项" :disabled="!canEditFixed || config.fixedFields[field.key].options.length <= 1" @click.stop="config.fixedFields[field.key].options.splice(optionIndex, 1)">×</button>
                    </template>
                  </el-input>
                </div>
              </div>
              <p class="micro">报名表里{{ field.label }}是「从选项里挑」，不再让报名者手填；每项最多 40 字，至少要留 1 个选项。</p>
            </div>
          </div>
        </section>

        <section class="console-column">
          <div class="desk-card desk-card-fill">
            <div class="desk-head">
              <h3>自定义问题 <span class="micro">{{ config.questions.length }} / 20</span></h3>
              <el-button v-if="!config.publishedAt" type="primary" plain :disabled="config.questions.length >= 20" @click="addQuestion">添加问题</el-button>
            </div>
            <div v-if="!config.questions.length" class="question-empty">暂未添加自定义问题，报名表将只包含固定信息。</div>
            <div v-for="(question, index) in config.questions" :key="question.id" class="question-editor">
              <div class="question-top">
                <strong>问题 {{ index + 1 }}</strong>
                <div class="question-tools">
                  <el-switch v-model="question.required" active-text="必填" :disabled="!!config.publishedAt" />
                  <template v-if="!config.publishedAt">
                    <button class="pill pill-lg" :disabled="index === 0" @click="moveQuestion(index, -1)">上移</button>
                    <button class="pill pill-lg" :disabled="index === config.questions.length - 1" @click="moveQuestion(index, 1)">下移</button>
                    <button class="pill pill-lg pill-danger" @click="config.questions.splice(index, 1)">删除</button>
                  </template>
                </div>
              </div>
              <el-form label-position="top" :disabled="!!config.publishedAt">
                <el-form-item label="题目（最多 200 字）" required><el-input v-model="question.title" placeholder="填写问题" /></el-form-item>
                <div class="question-settings"><span class="micro">题型</span><el-select v-model="question.type" class="type-select" @change="changeQuestionType(question)"><el-option v-for="item in questionTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></div>
                <div v-if="isChoice(question)" class="option-editor">
                  <div v-for="(option, optionIndex) in question.options" :key="option.id" class="option-row"><span class="micro">{{ optionIndex + 1 }}</span><el-input v-model="option.label" placeholder="选项内容（最多 100 字）" /><el-button v-if="!config.publishedAt" :disabled="question.options.length <= 2" @click="question.options.splice(optionIndex, 1)">移除</el-button></div>
                  <el-button v-if="!config.publishedAt" :disabled="question.options.length >= 20" @click="question.options.push(newOption())">添加选项</el-button>
                  <p class="micro">至少 2 个选项，最多 20 个；选项内容不能重复。</p>
                </div>
              </el-form>
            </div>
          </div>
        </section>
      </div>
      <template #footer><el-button @click="configVisible = false">{{ config.archivedAt ? '关闭' : '取消' }}</el-button><el-button v-if="!config.archivedAt" type="primary" :loading="configSaving" @click="saveConfig">{{ config.publishedAt ? '保存允许修改的配置' : '保存草稿' }}</el-button></template>
    </el-dialog>

    <!-- ══════════ 面试安排（批次级统一安排 + 单人单独配置） ══════════ -->
    <el-dialog v-model="planVisible" width="min(1100px, 96vw)" top="6vh" class="console-dialog recruitment-console" :show-close="false" :close-on-click-modal="false" @closed="clearPlan">
      <template #header>
        <div class="console-heading">
          <div class="console-heading-main">
            <span class="console-kind">招新</span>
            <strong>面试安排</strong>
            <span class="micro">{{ planBatch?.title }}</span>
          </div>
          <el-button text :disabled="planSaving" @click="planVisible = false">关闭</el-button>
        </div>
        <div class="micro console-subtitle">批次统一安排一次即覆盖全批次；个别同学可用「单独配置」覆盖。保存后报名者可立即凭查询码查看，所有时间均为北京时间。</div>
      </template>
      <div class="console-columns plan-body">
        <section class="console-column">
          <div class="desk-card">
            <div class="desk-head">
              <h3>批次统一安排</h3>
              <span class="tag" :class="planBatch?.interview ? 'tag-pass' : 'tag-mute'">{{ planBatch?.interview ? '已发布' : '未安排' }}</span>
            </div>
            <el-form label-position="top" :disabled="!canPlan || planSaving">
              <el-form-item label="面试时间（北京时间）" required><el-date-picker v-model="planForm.at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" placeholder="选择面试时间" /></el-form-item>
              <el-form-item label="面试地点（最多 200 字）" required><el-input v-model="planForm.location" placeholder="例如：教学楼 301 广播室" /></el-form-item>
              <el-form-item label="面试说明（报名者可见，最多 2000 字）"><el-input v-model="planForm.note" type="textarea" :rows="3" placeholder="填写到场要求或需准备的内容。" /></el-form-item>
            </el-form>
            <div class="actions">
              <el-button v-if="canPlan" type="primary" :loading="planSaving" @click="savePlan">{{ planBatch?.interview ? '更新统一安排' : '发布统一安排' }}</el-button>
              <el-button v-if="canPlan && planBatch?.interview" :disabled="planSaving" @click="clearPlanConfirm">清除统一安排</el-button>
            </div>
            <p v-if="!canPlan" class="micro desk-note">报名截止后、结果发布前才能安排面试。</p>
          </div>
        </section>
        <section class="console-column">
          <div class="desk-card desk-card-fill">
            <div class="desk-head">
              <h3>报名者面试时间 <span class="micro">共 {{ planTotal }} 人</span></h3>
              <el-button size="small" :loading="planLoading" @click="loadPlan">刷新</el-button>
            </div>
            <div class="panel" v-loading="planLoading">
              <el-table v-if="planRoster.length" :data="planRoster" row-key="id" max-height="44vh">
                <el-table-column prop="name" label="姓名" min-width="90" />
                <el-table-column label="年级班级" min-width="130"><template #default="{ row }">{{ row.grade }} · {{ row.className }}</template></el-table-column>
                <el-table-column label="面试时间（北京时间）" min-width="215">
                  <template #default="{ row }">
                    <template v-if="row.interview">
                      <div>{{ formatTime(row.interview.at) }}<span v-if="row.interviewCustom" class="solo">单独配置</span></div>
                      <div class="micro">{{ row.interview.location }}</div>
                    </template>
                    <span v-else class="micro">未安排</span>
                  </template>
                </el-table-column>
                <el-table-column label="状态" width="120">
                  <template #default="{ row }"><span class="tag" :class="applicationTag(row)">{{ applicationState(row) }}</span></template>
                </el-table-column>
                <el-table-column label="操作" width="140" align="right">
                  <template #default="{ row }">
                    <button class="pill" :disabled="!canEditSolo(row)" @click.stop="openSolo(row)">{{ row.interviewCustom ? '改单独配置' : '单独配置' }}</button>
                  </template>
                </el-table-column>
              </el-table>
              <EmptyState v-else :title="planBatch?.publishedAt ? '暂无报名' : '批次尚未发布'" description="报名截止后即可统一安排面试时间。" />
              <el-pagination v-if="planTotal" v-model:current-page="planQuery.page" v-model:page-size="planQuery.pageSize" :page-sizes="[20, 50, 100]" :total="planTotal" layout="total, sizes, prev, pager, next" class="pager" @current-change="loadPlan" @size-change="filterPlan" />
            </div>
          </div>
        </section>
      </div>
      <template #footer><el-button @click="planVisible = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="soloVisible" append-to-body width="min(520px, 94vw)" title="单独配置面试时间" :close-on-click-modal="false">
      <p class="micro">只覆盖 {{ soloTarget?.name }} 本人的面试时间，批次统一安排保持不变。</p>
      <el-form label-position="top" :disabled="soloSaving">
        <el-form-item label="面试时间（北京时间）" required><el-date-picker v-model="soloForm.at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" placeholder="选择面试时间" /></el-form-item>
        <el-form-item label="面试地点（最多 200 字）" required><el-input v-model="soloForm.location" placeholder="例如：教学楼 301 广播室" /></el-form-item>
        <el-form-item label="面试说明（报名者可见，最多 2000 字）"><el-input v-model="soloForm.note" type="textarea" :rows="3" placeholder="填写到场要求或需准备的内容。" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="soloVisible = false">取消</el-button>
        <el-button v-if="soloTarget?.interviewCustom" :disabled="soloSaving" @click="clearSolo">恢复统一安排</el-button>
        <el-button type="primary" :loading="soloSaving" @click="saveSolo">保存单独配置</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 审核处理台（面试安排已移出到批次级弹窗） ══════════ -->
    <el-dialog v-model="detailVisible" width="min(1010px, 96vw)" top="7vh" class="console-dialog recruitment-console" :show-close="false" :close-on-click-modal="false" :before-close="beforeDetailClose" @closed="clearDetail">
      <template #header>
        <div class="console-heading"><div class="console-heading-main"><span class="console-kind">招新</span><strong>审核处理台</strong><span v-if="detailIndex >= 0" class="micro">本页第 {{ detailIndex + 1 }} / {{ detailRows.length }} 条</span></div><el-button text :disabled="detailSaving" @click="closeDetail">关闭</el-button></div>
        <div v-if="detail" class="micro console-subtitle">{{ detail.batch?.title }} · {{ formatTime(detail.createdAt) }} 提交</div>
      </template>
      <div v-loading="detailLoading" class="detail-body">
        <div v-if="detail" class="console-columns">
          <div class="console-column">
            <section class="desk-card">
              <div class="person-card">
                <div class="person-row">
                  <span class="person-avatar">{{ (detail.name || '?').charAt(0) }}</span>
                  <div class="person-main">
                    <div class="person-name">{{ detail.name }}</div>
                    <div class="person-sub">{{ detail.grade }} · {{ detail.className }}</div>
                  </div>
                  <span class="tag" :class="applicationTag(detail)">{{ applicationState(detail) }}</span>
                </div>
                <div class="person-stats">
                  <div><span>QQ 号</span><strong>{{ detail.qqNumber || '未填写' }}</strong></div>
                  <div><span>面试序号</span><strong>{{ detail.interviewSequence || '尚未生成' }}</strong></div>
                  <div>
                    <span>面试时间</span>
                    <strong>{{ detail.interview ? formatTime(detail.interview.at) : '未安排' }}</strong>
                    <span v-if="detail.interviewCustom" class="tag tag-reject person-solo">单独配置</span>
                  </div>
                </div>
              </div>
              <p v-if="detail.legacyStudentNo" class="legacy-note">历史报名学号（留档）：{{ detail.legacyStudentNo }}。</p>
              <el-alert v-if="!canReview" :title="reviewLockReason" type="info" :closable="false" class="form-alert" />
              <el-alert v-else title="内部决定先保存，超管统一发布后报名者才可查看结果。" type="info" :closable="false" class="form-alert" />
            </section>
            <section class="desk-card">
              <div class="desk-head"><h3>报名回答</h3></div>
              <div v-for="(question, index) in detail.batch?.questions || []" :key="question.id" class="answer"><div class="answer-title">{{ index + 1 }}. {{ question.title }} <span class="micro">{{ question.required ? '必填' : '选填' }}</span></div><div class="answer-content">{{ answerText(question, detail.answers?.[question.id]) }}</div></div>
              <p v-if="!detail.batch?.questions?.length" class="micro">本批次未设置自定义问题。</p>
            </section>
          </div>
          <div class="console-column">
            <section class="desk-card">
              <div class="desk-head"><h3>审核与结果</h3></div>
              <p class="micro desk-note">面试时间在批次级的「面试安排」里统一设置，本页不再单独安排。</p>
              <el-form label-position="top" :disabled="!canReview || detailSaving">
                <el-form-item label="内部备注（仅管理员可见，最多 2000 字）"><el-input v-model="reviewForm.internalNote" type="textarea" :rows="6" placeholder="审核记录、面试评价等。" /></el-form-item>
                <el-form-item label="审核决定"><el-select v-model="reviewForm.decision" :clearable="!detail.decision" placeholder="暂不决定，仅保存备注"><el-option v-if="detail.progress === 'interview' || detail.decision === 'accepted'" label="拟录取" value="accepted" /><el-option label="拟不录取" value="rejected" /></el-select><p class="micro">{{ detail.progress === 'interview' ? '可拟定录取或不录取，统一发布前可以修正决定。' : '可先拟定不录取；录取须先在「面试安排」里设置面试时间。' }}</p></el-form-item>
                <el-form-item label="结果说明（统一发布后报名者可见，最多 2000 字）"><el-input v-model="reviewForm.publicNote" type="textarea" :rows="4" placeholder="填写录取后的要求，或未录取的对外说明。" /></el-form-item>
              </el-form>
              <div v-if="canReview" class="actions"><el-button type="primary" :loading="detailSaving" @click="saveReview">保存审核</el-button><el-button v-if="detail.decision" :disabled="detailSaving" @click="retractDecision">撤销拟定结果</el-button></div>
            </section>
          </div>
        </div>
        <EmptyState v-else-if="!detailLoading" title="未能加载报名详情" description="关闭后重试，或刷新报名名单。" />
      </div>
      <template #footer><div class="console-footer"><span class="micro">{{ detailDirty ? '有未保存的修改' : '报名资料与内部审核分列展示' }}</span><div class="actions"><el-button :disabled="detailSaving || detailLoading || detailIndex <= 0" @click="navigateDetail(-1)">上一条</el-button><el-button :disabled="detailSaving || detailLoading || detailIndex < 0 || detailIndex >= detailRows.length - 1" @click="navigateDetail(1)">下一条</el-button></div></div></template>
    </el-dialog>

    <el-dialog v-model="orderVisible" title="面试顺序名单" width="min(1010px, 96vw)" top="7vh" class="order-dialog" :close-on-click-modal="false" @closed="clearOrder">
      <div class="order-heading"><div><h3>{{ orderBatch?.title }}</h3><p class="micro">{{ orderGeneratedAt ? `${formatTime(orderGeneratedAt)} 生成（北京时间） · 共 ${orderTotal} 人` : '尚未生成面试顺序' }}</p></div><div class="actions"><el-button :loading="orderLoading" @click="loadOrder">刷新名单</el-button><el-button v-if="orderGeneratedAt" type="primary" :loading="orderExporting" @click="downloadOrder">导出完整名单（XLSX）</el-button></div></div>
      <p class="micro order-note">系统随机生成并保存面试顺序，查看和导出使用同一份顺序。生成时排除已撤回、拟不录取的报名。</p>
      <p class="micro order-note">面试时间跟随批次统一安排；单人「单独配置」的会标红提示。</p>
      <div v-loading="orderLoading" class="panel order-panel"><el-table v-if="orderItems.length" :data="orderItems" row-key="id" max-height="55vh"><el-table-column prop="interviewSequence" label="面试序号" width="100" /><el-table-column prop="name" label="姓名" min-width="90" /><el-table-column label="QQ 号" min-width="120"><template #default="{ row }">{{ row.qqNumber || '未填写' }}</template></el-table-column><el-table-column prop="grade" label="年级" min-width="100" /><el-table-column prop="className" label="班级" min-width="100" /><el-table-column label="面试时间 / 地点" min-width="215"><template #default="{ row }"><template v-if="row.interview"><div>{{ formatTime(row.interview.at) }}<span v-if="row.interviewCustom" class="solo">单独配置</span></div><span class="micro">{{ row.interview.location }}</span></template><span v-else class="micro">未安排</span></template></el-table-column><el-table-column label="当前状态" min-width="125"><template #default="{ row }"><span class="tag" :class="applicationTag(row)">{{ applicationState(row) }}</span></template></el-table-column></el-table><EmptyState v-else :title="orderGeneratedAt ? '面试名单为空' : '尚未生成面试顺序'" :description="auth.isSuperAdmin ? '报名截止后，可生成有效报名的随机面试顺序。' : '请等待超级管理员在报名截止后生成顺序。'" /></div>
      <el-pagination v-if="orderTotal" v-model:current-page="orderQuery.page" v-model:page-size="orderQuery.pageSize" :page-sizes="[20, 50, 100]" :total="orderTotal" layout="total, sizes, prev, pager, next" class="pager" @current-change="loadOrder" @size-change="filterOrder" />
      <template #footer><el-button @click="orderVisible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '@/components/EmptyState.vue';
import { useAuthStore } from '@/stores/auth';
import { clearPageHeader, setPageHeader } from '@/utils/pageHeader';
import {
  recruitmentAvailable, recruitmentUnavailableMessage, listBatches, getBatch, createBatch,
  updateBatch, publishBatch, publishResults, archiveBatch, listApplications, getApplication,
  reviewApplication, arrangeInterview, arrangeBatchInterview, deleteBatch, closeBatch,
  generateInterviewOrder, getInterviewOrder, exportInterviewOrder,
} from '@/api/recruitment';

const auth = useAuthStore();
const batches = ref([]);
const batchTotal = ref(0);
const batchLoading = ref(false);
const batchActing = ref(false);
const batchQuery = reactive({ page: 1, pageSize: 10, archived: false });
const selectedBatch = ref(null);
const applications = ref([]);
const applicationTotal = ref(0);
const applicationLoading = ref(false);
const applicationQuery = reactive({ page: 1, pageSize: 20, grade: '', status: '' });
// 批次级统计：报名总数与「已拟录取」都不走全量拉取，用 pageSize=1 的计数查询拿 total。
const batchStats = reactive({ total: 0, accepted: 0 });
let statsRequest = 0;
let batchRequest = 0;
let selectionRequest = 0;
let applicationRequest = 0;

const listBody = ref(null);
const tableHeight = ref(420);
let tableObserver = null;
function measureTable() {
  const height = listBody.value?.clientHeight || 0;
  if (height > 0 && Math.abs(height - tableHeight.value) > 1) tableHeight.value = height;
}
watch(listBody, (el, previous) => {
  if (!tableObserver) tableObserver = new ResizeObserver(measureTable);
  if (previous) tableObserver.unobserve(previous);
  if (el) { tableObserver.observe(el); measureTable(); } else { tableHeight.value = 420; }
});

const statusOptions = [
  { value: 'submitted', label: '已提交' }, { value: 'interview', label: '待面试' },
  { value: 'accepted', label: '已录取（含未发布）' }, { value: 'rejected', label: '未录取（含未发布）' },
  { value: 'withdrawn', label: '已撤回' },
];
const questionTypes = [
  { value: 'text', label: '单行文本' }, { value: 'textarea', label: '多行文本' },
  { value: 'single', label: '单选' }, { value: 'multiple', label: '多选' },
];

// ---- 固定信息：四项必填开关 + 年级/班级的选项清单（年级只有高一、初一；班级 1～15 班）----
const FIXED_FIELDS = [
  { key: 'name', label: '姓名', hint: '报名者手填，最多 40 字' },
  { key: 'qqNumber', label: 'QQ 号', hint: '5～12 位数字，可改成选填' },
  { key: 'grade', label: '年级', hint: '只从下面选项里挑' },
  { key: 'className', label: '班级', hint: '只从下面选项里挑' },
];
const OPTION_FIELDS = [
  { key: 'grade', label: '年级' },
  { key: 'className', label: '班级' },
];
const DEFAULT_GRADE_OPTIONS = ['高一', '初一'];
const DEFAULT_CLASS_OPTIONS = Array.from({ length: 15 }, (_, index) => `${index + 1}班`);
function defaultFixedFields() {
  return {
    name: { required: true, options: [] },
    qqNumber: { required: true, options: [] },
    grade: { required: true, options: [...DEFAULT_GRADE_OPTIONS] },
    className: { required: true, options: [...DEFAULT_CLASS_OPTIONS] },
  };
}
// 历史批次没有 fixedFields，一律回落到默认值，行为与云端 fixedOf() 一致。
function normalizeFixedFields(source) {
  const base = defaultFixedFields();
  const out = {};
  FIXED_FIELDS.forEach(({ key }) => {
    const item = source && source[key];
    out[key] = {
      required: item && typeof item.required === 'boolean' ? item.required : base[key].required,
      options: item && Array.isArray(item.options) ? item.options.map((option) => String(option)) : base[key].options,
    };
  });
  return out;
}
const gradeOptions = computed(() => normalizeFixedFields(selectedBatch.value?.fixedFields).grade.options);
const gradeScopeText = computed(() => {
  const options = gradeOptions.value;
  return options.length ? `限${options.join('、')}学生报名` : '年级由报名者自行填写';
});

// 日期输入始终表示北京时间，避免管理员浏览器的时区改变报名窗口。
const beijingFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timestamp = (value) => value ? new Date(value).getTime() : NaN;
function dateInput(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? beijingFormatter.format(new Date(time)) : '';
}
const formatTime = (value) => dateInput(value).slice(0, 16) || '—';
const fromDateInput = (value) => value ? new Date(`${value.replace(' ', 'T')}+08:00`).getTime() : NaN;
const textLength = (value) => [...String(value || '')].length;
const isClosed = (batch) => !!batch?.publishedAt && (!!batch.closedAt || batch.windowState === 'closed' || timestamp(batch.closesAt) <= Date.now());
const canGenerateOrder = (batch) => auth.isSuperAdmin && isClosed(batch) && !batch.resultPublishedAt && !batch.archivedAt;
function batchState(batch) {
  if (!batch) return '';
  if (batch.archivedAt) return '已归档';
  if (batch.resultPublishedAt) return '结果已发布';
  if (!batch.publishedAt) return '草稿';
  if (isClosed(batch)) return '报名已截止';
  if (timestamp(batch.opensAt) > Date.now()) return '尚未开放';
  return '报名中';
}
function batchTag(batch) { return batch.resultPublishedAt ? 'tag-pass' : batch.publishedAt && !isClosed(batch) ? 'tag-wait' : 'tag-mute'; }
function applicationState(application, batchOverride) {
  const status = application.status || application.decision || application.progress;
  if (status === 'withdrawn') return '已撤回';
  if (status === 'accepted' || status === 'rejected') {
    const published = (batchOverride || application.batch || selectedBatch.value)?.resultPublishedAt;
    return status === 'accepted' ? (published ? '已录取' : '拟录取·未发布') : (published ? '未录取' : '拟不录取·未发布');
  }
  return status === 'interview' ? '待面试' : '已提交';
}
function applicationTag(application) {
  const status = application.status || application.decision || application.progress;
  return status === 'withdrawn' ? 'tag-mute' : status === 'accepted' ? 'tag-pass' : status === 'rejected' ? 'tag-reject' : 'tag-wait';
}

// ---- 批次带与右栏的派生文案：只说批次自身的字段，不编业务事实 ----
const isFiltered = computed(() => !!(applicationQuery.grade || applicationQuery.status));
const applicationTotalText = computed(() => isFiltered.value
  ? `筛选后 ${applicationTotal.value} / ${batchStats.total} 份`
  : `共 ${batchStats.total} 份`);
const emptyTitle = computed(() => {
  if (isFiltered.value) return '暂无符合条件的报名';
  return selectedBatch.value?.publishedAt ? '报名名单还是空的' : '批次尚未发布';
});
const emptyDescription = computed(() => {
  if (isFiltered.value) return '调整年级或状态筛选条件。';
  return selectedBatch.value?.publishedAt
    ? '报名窗口内，学生可从「我的」页面的「加入我们」报名。'
    : '发布后，学生可从「我的」页面的「加入我们」报名。';
});
// 批次带下面那一行说明：把原来三条重复的文案收成一条，按状态各说各的
const batchNote = computed(() => {
  const batch = selectedBatch.value;
  if (!batch) return '';
  if (batch.archivedAt) return `批次已于 ${formatTime(batch.archivedAt)} 归档，题目、时间与审核决定只读。`;
  if (batch.resultPublishedAt) return `结果已于 ${formatTime(batch.resultPublishedAt)} 统一发布，审核与面试安排已锁定。`;
  if (!batch.publishedAt) return '批次还是草稿：配置题目与报名时间后发布，学生即可在报名窗口内公开报名。';
  if (batch.closedAt) return `已于 ${formatTime(batch.closedAt)} 手动截止，报名资料已保留；统一发布结果前，报名者看不到内部录取决定。`;
  if (isClosed(batch)) return `报名已于 ${formatTime(batch.closesAt)} 截止，可安排面试、审核报名并拟定录取结果；统一发布结果前，报名者看不到内部录取决定。`;
  return `报名进行中，${formatTime(batch.closesAt)} 截止后即可安排面试与审核。`;
});
const batchHint = computed(() => {
  const batch = selectedBatch.value;
  if (!batch) return '';
  if (batch.archivedAt) return '已归档批次不可再改题目、时间与审核结果，只能查看名单与导出。';
  if (batch.resultPublishedAt) return '结果已统一发布，审核与面试安排已锁定。';
  if (!batch.publishedAt) return '发布报名后，学生才能在报名窗口内提交报名。';
  if (!isClosed(batch)) return '报名进行中；截止后即可安排面试、审核并拟定录取结果。';
  const unresolved = batch.unresolvedCount ?? 0;
  return unresolved
    ? `还有 ${unresolved} 份报名待决定；全部有决定后才能统一发布结果。`
    : '全部报名已有决定，可以统一发布录取结果。';
});
// 右栏五步：全部由批次字段推出来，不给后端加接口
const flowSteps = computed(() => {
  const batch = selectedBatch.value;
  if (!batch) return [];
  const published = !!batch.publishedAt;
  const closed = isClosed(batch);
  const results = !!batch.resultPublishedAt;
  const archived = !!batch.archivedAt;
  const unresolved = batch.unresolvedCount ?? 0;
  const decided = closed && unresolved === 0;
  const steps = [
    { label: '发布报名', sub: published ? `${formatTime(batch.publishedAt)} 发布` : '草稿，尚未发布', done: published, now: !published },
    { label: '报名截止', sub: published ? (closed ? `${formatTime(batch.closedAt || batch.closesAt)} 截止` : `报名窗口至 ${formatTime(batch.closesAt)}`) : '发布后才开始计时', done: closed, now: published && !closed },
    { label: '审核与面试', sub: closed ? (unresolved ? `还有 ${unresolved} 份待决定` : '全部报名已决定') : '报名截止后开始审核', done: decided, now: closed && !decided },
    { label: '统一发布结果', sub: results ? `${formatTime(batch.resultPublishedAt)} 已发布` : decided ? '可以发布了' : '待所有报名都有决定', done: results, now: !results && decided },
    { label: '归档批次', sub: archived ? `${formatTime(batch.archivedAt)} 已归档` : '结果发布后可归档', done: archived, now: !archived && results },
  ];
  return steps.map((step) => ({ ...step, cls: step.done ? 'done' : step.now ? 'now' : '' }));
});
const flowHint = computed(() => {
  const steps = flowSteps.value;
  if (!steps.length) return '';
  if (steps.every((step) => step.done)) return '已完成';
  return `第 ${steps.findIndex((step) => !step.done) + 1} / ${steps.length} 步`;
});

async function loadBatches() {
  if (!recruitmentAvailable) return;
  const request = ++batchRequest;
  batchLoading.value = true;
  try {
    const data = await listBatches({ ...batchQuery });
    if (request !== batchRequest) return;
    batches.value = data.items || [];
    batchTotal.value = data.total || 0;
    setPageHeader({ title: '招新管理', subtitle: '公开报名、面试安排与统一录取' });
    const existing = batches.value.find((item) => item.id === selectedBatch.value?.id);
    if (existing) selectedBatch.value = existing;
    else if (selectedBatch.value && !existing) { selectedBatch.value = null; applications.value = []; applicationTotal.value = 0; }
    if (!selectedBatch.value && batches.value.length) await selectBatch(batches.value[0]);
  } catch { /* 请求层已提示。 */ }
  finally { if (request === batchRequest) batchLoading.value = false; }
}
function changeArchive(archived) {
  if (batchQuery.archived === archived || batchActing.value || orderGenerating.value) return;
  batchQuery.archived = archived;
  batchQuery.page = 1;
  selectionRequest++;
  applicationRequest++;
  selectedBatch.value = null;
  applications.value = [];
  applicationTotal.value = 0;
  batchStats.total = 0;
  batchStats.accepted = 0;
  statsRequest++;
  loadBatches();
}
async function selectBatch(row) {
  if (batchActing.value || orderGenerating.value) return;
  const request = ++selectionRequest;
  selectedBatch.value = row;
  applicationQuery.page = 1;
  applicationQuery.grade = '';
  applicationQuery.status = '';
  applications.value = [];
  applicationTotal.value = 0;
  batchStats.total = 0;
  batchStats.accepted = 0;
  statsRequest++;
  try {
    const batch = await getBatch(row.id);
    if (request !== selectionRequest) return;
    selectedBatch.value = batch;
    await loadApplications();
  } catch { /* 请求层已提示。 */ }
}
async function refreshSelectedBatch() {
  const id = selectedBatch.value?.id;
  if (!id) return;
  const batch = await getBatch(id);
  if (selectedBatch.value?.id !== id) return;
  selectedBatch.value = batch;
  const index = batches.value.findIndex((item) => item.id === id);
  if (index >= 0) batches.value[index] = batch;
}
async function loadApplications() {
  const id = selectedBatch.value?.id;
  if (!id) return;
  const request = ++applicationRequest;
  applicationLoading.value = true;
  try {
    const data = await listApplications({ batchId: id, ...applicationQuery, grade: applicationQuery.grade || undefined, status: applicationQuery.status || undefined });
    if (request !== applicationRequest || selectedBatch.value?.id !== id) return;
    applications.value = data.items || [];
    applicationTotal.value = data.total || 0;
    // 未筛选时这一页的 total 就是全批次报名数；翻页/筛选不必再算
    if (!isFiltered.value) batchStats.total = applicationTotal.value;
    if (applicationQuery.page === 1) loadAcceptedCount(id);
    await refreshSelectedBatch();
  } catch { /* 请求层已提示。 */ }
  finally { if (request === applicationRequest) applicationLoading.value = false; }
}
function filterApplications() { applicationQuery.page = 1; loadApplications(); }
// 「已拟录取」点一下就筛名单，再点一次撤销
function filterByStatus(status) {
  applicationQuery.status = applicationQuery.status === status ? '' : status;
  filterApplications();
}
async function loadAcceptedCount(id) {
  const request = ++statsRequest;
  try {
    const data = await listApplications({ batchId: id, page: 1, pageSize: 1, status: 'accepted' });
    if (request !== statsRequest || selectedBatch.value?.id !== id) return;
    batchStats.accepted = data.total || 0;
  } catch { /* 统计失败不打断主流程 */ }
}
async function refresh() { await loadBatches(); if (selectedBatch.value) await loadApplications(); }

// ---- 批次配置 ----
const configVisible = ref(false);
const configSaving = ref(false);
const config = reactive({ id: null, version: 0, title: '', intro: '', opensAt: '', closesAt: '', originalOpensAt: null, questions: [], fixedFields: defaultFixedFields(), publishedAt: null, archivedAt: null, closedAt: null });
const configStarted = computed(() => !!config.publishedAt && (!!config.closedAt || timestamp(config.originalOpensAt) <= Date.now()));
// 必填规则与选项清单在「报名开始」之后锁定：改了会和已提交的报名对不上。
const canEditFixed = computed(() => !config.archivedAt && !configStarted.value);
const configLockText = computed(() => (config.archivedAt ? '只读' : !config.publishedAt ? '草稿' : configStarted.value ? '已锁定' : '报名前可改'));
const newId = () => crypto.randomUUID().replaceAll('-', '');
const newOption = () => ({ id: newId(), label: '' });
const isChoice = (question) => question.type === 'single' || question.type === 'multiple';
function openConfig(batch) {
  Object.assign(config, {
    id: batch?.id || null, version: batch?.version || 0, title: batch?.title || '', intro: batch?.intro || '',
    opensAt: dateInput(batch?.opensAt), closesAt: dateInput(batch?.closesAt), originalOpensAt: batch?.opensAt || null,
    questions: JSON.parse(JSON.stringify(batch?.questions || [])), fixedFields: normalizeFixedFields(batch?.fixedFields),
    publishedAt: batch?.publishedAt || null, archivedAt: batch?.archivedAt || null, closedAt: batch?.closedAt || null,
  });
  configVisible.value = true;
}
function addQuestion() { if (config.questions.length < 20) config.questions.push({ id: newId(), type: 'text', title: '', required: true, options: [] }); }
function moveQuestion(index, direction) { const [question] = config.questions.splice(index, 1); config.questions.splice(index + direction, 0, question); }
function changeQuestionType(question) {
  if (isChoice(question)) { if (question.options.length < 2) question.options = [newOption(), newOption()]; }
  else question.options = [];
}
// 只把年级/班级的选项发给云端（姓名、QQ 号没有选项）。
function fixedFieldsPayload() {
  const source = normalizeFixedFields(config.fixedFields);
  const out = {};
  FIXED_FIELDS.forEach(({ key }) => {
    out[key] = { required: source[key].required, options: source[key].options.map((option) => option.trim()) };
  });
  return out;
}
function validateConfig() {
  if (!config.title.trim() || !config.intro.trim()) return '请填写批次名称和招新介绍。';
  if (textLength(config.title.trim()) > 100 || textLength(config.intro.trim()) > 10000) return '批次名称或介绍超出长度上限。';
  const opensAt = fromDateInput(config.opensAt), closesAt = fromDateInput(config.closesAt);
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt)) return '请选择完整的报名时间。';
  if (opensAt >= closesAt) return '报名开始时间必须早于截止时间。';
  for (const { key, label } of OPTION_FIELDS) {
    if (!canEditFixed.value) break;
    const options = config.fixedFields[key].options.map((option) => String(option).trim());
    if (!options.length) return `「${label}」至少要留 1 个选项。`;
    if (options.length > 50) return `「${label}」最多 50 个选项。`;
    if (options.some((option) => !option || textLength(option) > 40)) return `「${label}」的选项不能为空，每项最多 40 字。`;
    if (new Set(options).size !== options.length) return `「${label}」的选项不能重复。`;
  }
  for (const [index, question] of config.questions.entries()) {
    if (!question.title.trim() || textLength(question.title.trim()) > 200) return `请填写问题 ${index + 1} 的题目，最多 200 字。`;
    if (isChoice(question)) {
      const options = question.options.map((option) => option.label.trim());
      if (options.length < 2 || options.length > 20 || options.some((label) => !label || textLength(label) > 100)) return `问题 ${index + 1} 需要 2～20 个非空选项，每项最多 100 字。`;
      if (new Set(options).size !== options.length) return `问题 ${index + 1} 的选项不能重复。`;
    }
  }
  return '';
}
async function saveConfig() {
  if (configSaving.value || config.archivedAt) return;
  const warning = validateConfig();
  if (warning) return ElMessage.warning(warning);
  configSaving.value = true;
  try {
    let body;
    if (config.publishedAt) {
      body = { version: config.version, intro: config.intro.trim() };
      if (!configStarted.value) {
        Object.assign(body, { opensAt: fromDateInput(config.opensAt), closesAt: fromDateInput(config.closesAt), fixedFields: fixedFieldsPayload() });
      }
    } else {
      body = { title: config.title.trim(), intro: config.intro.trim(), opensAt: fromDateInput(config.opensAt), closesAt: fromDateInput(config.closesAt), questions: config.questions.map((question) => ({ ...question, title: question.title.trim(), options: question.options.map((option) => ({ ...option, label: option.label.trim() })) })), fixedFields: fixedFieldsPayload() };
      if (config.id) body.version = config.version;
    }
    const saved = config.id ? await updateBatch(config.id, body) : await createBatch(body);
    configVisible.value = false;
    selectedBatch.value = saved;
    batchQuery.archived = !!saved.archivedAt;
    batchQuery.page = 1;
    ElMessage.success(saved.publishedAt ? '批次配置已保存。' : '草稿已保存，发布后学生即可报名。');
    await refresh();
  } catch (error) {
    if (error.code === 40910 && config.id) {
      const latest = await getBatch(config.id).catch(() => null);
      if (latest) openConfig(latest);
      ElMessage.warning('批次已被更新，已重新加载，请核对后再保存。');
    }
  } finally { configSaving.value = false; }
}

// ---- 批次动作 / 删除 ----
async function batchAction(action) {
  if (batchActing.value || orderGenerating.value || !selectedBatch.value || !auth.isSuperAdmin) return;
  batchActing.value = true;
  try {
    const batch = await getBatch(selectedBatch.value.id);
    selectedBatch.value = batch;
    const messages = {
      publish: [`发布「${batch.title}」？发布后题目、选项、必填设置和顺序将锁定，学生可在报名窗口内公开报名。`, '发布招新', '发布报名'],
      results: [`统一发布「${batch.title}」的录取结果？所有报名者可立即凭查询码查看自己的结果。发布后不能修改决定和对外说明，也不能撤销发布。`, '发布录取结果', '确认发布'],
      archive: [`归档「${batch.title}」？批次将移至历史列表，报名记录和查询码仍然有效。`, '归档批次', '确认归档'],
      close: [`立即截止「${batch.title}」的报名？截止后无法继续报名、修改或撤回，已提交的报名资料会保留，并可开始审核和面试安排。`, '截止报名', '确认截止'],
    };
    if (action === 'results' && (!isClosed(batch) || batch.unresolvedCount !== 0)) return ElMessage.warning('报名截止且所有未撤回报名都有最终决定后，才能发布结果。');
    const [message, title, confirmButtonText] = messages[action];
    await ElMessageBox.confirm(message, title, { type: 'warning', confirmButtonText, cancelButtonText: '取消' });
    const handlers = { publish: publishBatch, results: publishResults, archive: archiveBatch, close: closeBatch };
    selectedBatch.value = await handlers[action](batch.id, batch.version);
    ElMessage.success(action === 'publish' ? '招新批次已发布。' : action === 'results' ? '录取结果已统一发布。' : action === 'close' ? '报名已截止，已提交的报名资料已保留。' : '批次已归档。');
    if (action === 'archive') { selectedBatch.value = null; applications.value = []; applicationTotal.value = 0; }
    await refresh();
  } catch (error) {
    if (error?.code === 40910) await refresh();
  } finally { batchActing.value = false; }
}
// 删除批次是不可恢复的：一律要求把批次名称原样打一遍（云端也这么校验）。
async function removeBatch(batch) {
  if (batchActing.value || orderGenerating.value || !batch) return;
  // ⚠️ 两边都 trim 后比较：历史批次名可能带首尾空白（界面看不出来），
  //    直接 === 会让用户怎么输都不对，表现就是「输对了还是删不掉」。
  const expected = String(batch.title ?? '').trim();
  let value;
  try {
    const result = await ElMessageBox.prompt(
      `删除「${batch.title}」会连带清除该批次的全部报名、查询码与面试顺序，且无法恢复。请把批次名称原样输入以确认。`,
      '删除招新批次',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        inputPlaceholder: expected,
        // 点遮罩不关闭：这是不可恢复操作，别让一次误点把弹窗关掉、还以为删了
        closeOnClickModal: false,
        inputValidator: (input) => (input || '').trim() === expected || '批次名称不一致',
      },
    );
    value = result.value;
  } catch { return; }
  // 输入校验在弹窗里已做一遍，这里再兜一次：名称不符绝不发删除请求。
  if ((value || '').trim() !== expected) return ElMessage.warning('批次名称不一致，已取消删除。');
  batchActing.value = true;
  try {
    const result = await deleteBatch(batch.id, { confirm: expected });
    if (selectedBatch.value?.id === batch.id) { selectedBatch.value = null; applications.value = []; applicationTotal.value = 0; }
    ElMessage.success(`批次「${batch.title}」已删除，连同 ${result?.deletedApplications || 0} 份报名。`);
    await refresh();
  } catch (error) {
    if (error?.code === 40910) await refresh();
  } finally { batchActing.value = false; }
}

// ---- 面试顺序 ----
const orderVisible = ref(false);
const orderLoading = ref(false);
const orderGenerating = ref(false);
const orderExporting = ref(false);
const orderBatch = ref(null);
const orderItems = ref([]);
const orderTotal = ref(0);
const orderGeneratedAt = ref(null);
const orderQuery = reactive({ page: 1, pageSize: 20 });
let orderRequest = 0;
async function openOrder() {
  if (!selectedBatch.value?.publishedAt) return;
  orderBatch.value = selectedBatch.value;
  orderQuery.page = 1;
  orderItems.value = [];
  orderTotal.value = 0;
  orderGeneratedAt.value = selectedBatch.value.orderGeneratedAt || null;
  orderVisible.value = true;
  await loadOrder();
}
async function loadOrder() {
  const id = orderBatch.value?.id;
  if (!id || !orderVisible.value) return;
  const request = ++orderRequest;
  orderLoading.value = true;
  try {
    const data = await getInterviewOrder(id, { ...orderQuery });
    if (request !== orderRequest || orderBatch.value?.id !== id || !orderVisible.value) return;
    orderBatch.value = data.batch;
    orderItems.value = data.items || [];
    orderTotal.value = data.total || 0;
    orderGeneratedAt.value = data.orderGeneratedAt || null;
    if (selectedBatch.value?.id === id) selectedBatch.value = data.batch;
  } catch { /* 请求层已提示。 */ }
  finally { if (request === orderRequest) orderLoading.value = false; }
}
function filterOrder() { orderQuery.page = 1; loadOrder(); }
function clearOrder() { orderRequest++; orderItems.value = []; orderBatch.value = null; }
async function generateOrder() {
  if (orderGenerating.value || batchActing.value || !canGenerateOrder(selectedBatch.value)) return;
  orderGenerating.value = true;
  const id = selectedBatch.value.id;
  try {
    const batch = await getBatch(id);
    if (!canGenerateOrder(batch)) return ElMessage.warning('报名截止后、结果发布前，才能生成面试顺序。');
    const regenerate = !!batch.orderGeneratedAt;
    await ElMessageBox.confirm(regenerate
      ? `重新生成「${batch.title}」的随机面试顺序？将覆盖已保存的顺序及面试序号，请在确认后使用新的名单。已撤回、拟不录取的报名会排除。`
      : `为「${batch.title}」生成随机面试顺序？系统将保存全部有效报名的顺序，并排除已撤回、拟不录取的报名。`,
    regenerate ? '覆盖面试顺序' : '生成随机面试顺序', { type: 'warning', confirmButtonText: regenerate ? '确认覆盖并重新生成' : '确认生成', cancelButtonText: '取消' });
    const saved = await generateInterviewOrder(id, batch.version, regenerate);
    if (selectedBatch.value?.id === id) selectedBatch.value = saved;
    ElMessage.success('随机面试顺序已生成并保存。');
    await refresh();
    if (selectedBatch.value?.id === id) await openOrder();
  } catch (error) { if (error?.code === 40910) await refresh(); }
  finally { orderGenerating.value = false; }
}
async function downloadOrder() {
  if (orderExporting.value || !orderBatch.value || !orderGeneratedAt.value) return;
  const id = orderBatch.value.id;
  orderExporting.value = true;
  let downloadUrl;
  try {
    const blob = await exportInterviewOrder(id);
    downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = `面试顺序_${dateInput(Date.now()).replace(/\D/g, '')}.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    ElMessage.success('完整面试名单已导出。');
  } catch { /* 请求层已提示。 */ }
  finally {
    if (downloadUrl) setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    orderExporting.value = false;
  }
}

// ---- 面试安排（批次统一 + 单人单独配置）----
const planVisible = ref(false);
const planLoading = ref(false);
const planSaving = ref(false);
const planBatch = ref(null);
const planRoster = ref([]);
const planTotal = ref(0);
const planForm = reactive({ at: '', location: '', note: '' });
const planQuery = reactive({ page: 1, pageSize: 20 });
const soloVisible = ref(false);
const soloSaving = ref(false);
const soloTarget = ref(null);
const soloForm = reactive({ at: '', location: '', note: '' });
let planRequest = 0;
const canPlan = computed(() => !!planBatch.value && isClosed(planBatch.value) && !planBatch.value.resultPublishedAt && !planBatch.value.archivedAt);
const canEditSolo = (row) => canPlan.value && row.status !== 'withdrawn' && !row.decision;
function openPlan() {
  if (!selectedBatch.value?.publishedAt) return;
  planBatch.value = selectedBatch.value;
  planQuery.page = 1;
  planRoster.value = [];
  planTotal.value = 0;
  assignPlanForm(selectedBatch.value.interview);
  planVisible.value = true;
  loadPlan();
}
function assignPlanForm(interview) {
  Object.assign(planForm, { at: dateInput(interview?.at), location: interview?.location || '', note: interview?.note || '' });
}
async function loadPlan() {
  const id = planBatch.value?.id;
  if (!id || !planVisible.value) return;
  const request = ++planRequest;
  planLoading.value = true;
  try {
    const [batch, data] = await Promise.all([getBatch(id), listApplications({ batchId: id, page: planQuery.page, pageSize: planQuery.pageSize })]);
    if (request !== planRequest || planBatch.value?.id !== id || !planVisible.value) return;
    planBatch.value = batch;
    planRoster.value = data.items || [];
    planTotal.value = data.total || 0;
    assignPlanForm(batch.interview);
    if (selectedBatch.value?.id === id) selectedBatch.value = batch;
  } catch { /* 请求层已提示。 */ }
  finally { if (request === planRequest) planLoading.value = false; }
}
function filterPlan() { planQuery.page = 1; loadPlan(); }
function clearPlan() { planRequest++; planRoster.value = []; planBatch.value = null; soloVisible.value = false; }
async function savePlan() {
  if (planSaving.value || !canPlan.value) return;
  const at = fromDateInput(planForm.at);
  if (!Number.isFinite(at) || !planForm.location.trim()) return ElMessage.warning('请填写面试时间和地点。');
  if (textLength(planForm.location.trim()) > 200 || textLength(planForm.note.trim()) > 2000) return ElMessage.warning('面试地点或说明超出长度上限。');
  planSaving.value = true;
  try {
    const saved = await arrangeBatchInterview(planBatch.value.id, { version: planBatch.value.version, at, location: planForm.location.trim(), note: planForm.note.trim() });
    planBatch.value = saved;
    if (selectedBatch.value?.id === saved.id) selectedBatch.value = saved;
    ElMessage.success('批次统一面试安排已发布，报名者可立即查看。');
    await loadPlan();
    await loadApplications();
  } catch (error) {
    if (error?.code === 40910) await loadPlan();
    else if (error?.code === 40912) ElMessage.warning(error.message || '报名截止后才能安排面试。');
  } finally { planSaving.value = false; }
}
async function clearUnifiedPlan() {
  if (planSaving.value || !planBatch.value) return;
  planSaving.value = true;
  try {
    const saved = await arrangeBatchInterview(planBatch.value.id, { version: planBatch.value.version, at: null, location: '', note: '' });
    planBatch.value = saved;
    if (selectedBatch.value?.id === saved.id) selectedBatch.value = saved;
    ElMessage.success('统一安排已清除，未单独配置的报名回到「未安排」。');
    await loadPlan();
    await loadApplications();
  } catch (error) { if (error?.code === 40910) await loadPlan(); }
  finally { planSaving.value = false; }
}
async function clearPlanConfirm() {
  try {
    await ElMessageBox.confirm('清除批次的统一面试安排？已单独配置过的同学保持自己的时间不变。', '清除统一安排', { type: 'warning', confirmButtonText: '确认清除', cancelButtonText: '取消' });
  } catch { return; }
  await clearUnifiedPlan();
}
function openSolo(row) {
  if (!canEditSolo(row)) return;
  soloTarget.value = row;
  Object.assign(soloForm, { at: dateInput(row.interview?.at), location: row.interview?.location || '', note: row.interview?.note || '' });
  soloVisible.value = true;
}
async function saveSolo() {
  if (soloSaving.value || !soloTarget.value) return;
  const at = fromDateInput(soloForm.at);
  if (!Number.isFinite(at) || !soloForm.location.trim()) return ElMessage.warning('请填写面试时间和地点。');
  if (textLength(soloForm.location.trim()) > 200 || textLength(soloForm.note.trim()) > 2000) return ElMessage.warning('面试地点或说明超出长度上限。');
  soloSaving.value = true;
  try {
    await arrangeInterview(soloTarget.value.id, { version: soloTarget.value.version, at, location: soloForm.location.trim(), note: soloForm.note.trim() });
    soloVisible.value = false;
    ElMessage.success('已为本人单独配置面试时间。');
    await loadPlan();
    await loadApplications();
  } catch (error) { if (error?.code === 40910) await loadPlan(); }
  finally { soloSaving.value = false; }
}
async function clearSolo() {
  if (soloSaving.value || !soloTarget.value) return;
  soloSaving.value = true;
  try {
    await arrangeInterview(soloTarget.value.id, { version: soloTarget.value.version, at: null, location: '', note: '' });
    soloVisible.value = false;
    ElMessage.success('已恢复跟随批次统一安排。');
    await loadPlan();
    await loadApplications();
  } catch (error) { if (error?.code === 40910) await loadPlan(); }
  finally { soloSaving.value = false; }
}

// ---- 审核处理台 ----
const detailVisible = ref(false);
const detailLoading = ref(false);
const detailSaving = ref(false);
const detail = ref(null);
const detailRows = ref([]);
const reviewForm = reactive({ decision: '', internalNote: '', publicNote: '' });
let detailRequest = 0;
const canReview = computed(() => detail.value && detail.value.progress !== 'withdrawn' && isClosed(detail.value.batch) && !detail.value.batch?.resultPublishedAt);
const reviewLockReason = computed(() => detail.value?.progress === 'withdrawn' ? '报名已撤回，不参与审核。' : detail.value?.batch?.resultPublishedAt ? '录取结果已发布，审核已锁定。' : '报名尚未截止，目前仅可查看报名。');
const detailIndex = computed(() => detailRows.value.findIndex((row) => row.id === detail.value?.id));
const detailDirty = computed(() => {
  if (!detail.value || !canReview.value) return false;
  const saved = detail.value;
  return reviewForm.decision !== (saved.decision || '') || reviewForm.internalNote !== (saved.internalNote || '') || reviewForm.publicNote !== (saved.publicNote || '');
});
function assignDetail(application) {
  detail.value = application;
  Object.assign(reviewForm, { decision: application.decision || '', internalNote: application.internalNote || '', publicNote: application.publicNote || '' });
}
async function confirmDiscardDetail() {
  if (!detailDirty.value) return true;
  try {
    await ElMessageBox.confirm('有未保存的修改。离开当前报名并放弃这些修改？', '未保存的修改', { type: 'warning', confirmButtonText: '放弃修改并离开', cancelButtonText: '继续编辑' });
    return true;
  } catch { return false; }
}
async function openApplication(row, keepNavigation = false) {
  if (detailSaving.value || detailVisible.value && !(await confirmDiscardDetail())) return;
  if (!keepNavigation) detailRows.value = applications.value.map((item) => ({ id: item.id }));
  const request = ++detailRequest;
  detail.value = null;
  detailVisible.value = true;
  detailLoading.value = true;
  try { const application = await getApplication(row.id); if (request === detailRequest) assignDetail(application); }
  catch { /* 请求层已提示。 */ }
  finally { if (request === detailRequest) detailLoading.value = false; }
}
function clearDetail() { detailRequest++; detail.value = null; detailRows.value = []; }
async function closeDetail() { if (!detailSaving.value && await confirmDiscardDetail()) detailVisible.value = false; }
async function beforeDetailClose(done) { if (!detailSaving.value && await confirmDiscardDetail()) done(); }
async function navigateDetail(direction) {
  if (detailLoading.value || detailSaving.value) return;
  const row = detailRows.value[detailIndex.value + direction];
  if (row) await openApplication(row, true);
}
function answerText(question, answer) {
  if (answer === undefined || answer === null || answer === '' || Array.isArray(answer) && !answer.length) return '未填写';
  if (!isChoice(question)) return String(answer);
  const values = Array.isArray(answer) ? answer : [answer];
  return values.map((id) => question.options.find((option) => option.id === id)?.label || '未知选项').join('、');
}
async function handleDetailConflict(error) {
  if (error.code !== 40910 || !detail.value) return;
  const application = await getApplication(detail.value.id).catch(() => null);
  if (application) assignDetail(application);
  await loadApplications();
  ElMessage.warning('报名已被更新，已重新加载，请核对后再保存。');
}
async function saveReview() {
  if (detailSaving.value || !canReview.value) return;
  if (textLength(reviewForm.internalNote.trim()) > 2000 || textLength(reviewForm.publicNote.trim()) > 2000) return ElMessage.warning('备注或对外说明最多 2000 字。');
  detailSaving.value = true;
  try {
    const body = { version: detail.value.version, internalNote: reviewForm.internalNote.trim(), publicNote: reviewForm.publicNote.trim() };
    if (reviewForm.decision) body.decision = reviewForm.decision;
    const application = await reviewApplication(detail.value.id, body);
    assignDetail(application);
    ElMessage.success('审核已保存；录取决定在统一发布后对报名者可见。');
    await loadApplications();
  } catch (error) {
    if (error?.code === 40912) ElMessage.warning(error.message || '当前报名不可审核。');
    else await handleDetailConflict(error);
  }
  finally { detailSaving.value = false; }
}
async function retractDecision() {
  if (detailSaving.value || !canReview.value || !detail.value.decision) return;
  try {
    await ElMessageBox.confirm(`撤销「${detail.value.name}」的拟定结果？报名将恢复为未决定，可继续审核。`, '撤销拟定结果', { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' });
  } catch { return; }
  detailSaving.value = true;
  try {
    const application = await reviewApplication(detail.value.id, { version: detail.value.version, decision: null });
    assignDetail(application);
    ElMessage.success('拟定结果已撤销，可继续审核。');
    await loadApplications();
  } catch (error) { await handleDetailConflict(error); }
  finally { detailSaving.value = false; }
}

onMounted(() => { setPageHeader({ title: '招新管理', subtitle: '公开报名、面试安排与统一录取' }); loadBatches(); });
onBeforeUnmount(() => {
  batchRequest++; selectionRequest++; applicationRequest++; detailRequest++; orderRequest++; planRequest++; statsRequest++;
  tableObserver?.disconnect();
  tableObserver = null;
  clearPageHeader();
});
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════
   招新管理 · 页面骨架
   纵向三段（工具条 / 批次带 / 主区），主区吃掉剩余高度 ⇒ 一屏内没有死白。
   原先「批次表格 + 深色摘要卡 + 说明行」把同一个批次讲了三遍，短名单会缩成一条细带。
   ══════════════════════════════════════════════════════════ */
.recruitment-page { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; }
.section-toolbar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.section-toolbar, .batch-bar, .desk-head, .question-top { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.actions, .filters, .question-settings, .question-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions :deep(.el-button + .el-button) { margin-left: 0; }

/* 分段切换：羊皮纸轨道 + 白胶囊选中（选中态靠底色，不靠墨黑反白） */
.segment { display: inline-flex; gap: 4px; padding: 4px; background: var(--parchment); border-radius: var(--r-pill); }
.segment button { height: 30px; padding: 0 16px; border: 0; border-radius: var(--r-pill); background: transparent; color: var(--muted); font: inherit; font-size: var(--fs-md); letter-spacing: var(--ls-wide-sm); cursor: pointer; transition: background .18s var(--ease), color .18s var(--ease); }
.segment button:hover { color: var(--ink); }
.segment button.on { background: var(--canvas); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .06); }

/* 多批次切换：只有一个批次时整排不渲染 */
.batch-switch { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.batch-chip { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 13px; border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--canvas); color: var(--ink-2); font: inherit; font-size: var(--fs-md); cursor: pointer; transition: border-color .18s var(--ease), color .18s var(--ease); }
.batch-chip:hover { border-color: var(--soft); }
.batch-chip.on { border-color: var(--ink); color: var(--ink); font-weight: 600; }
.batch-chip-state { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.batch-chip.on .batch-chip-state { color: var(--accent); }
.batch-pager { margin-left: auto; }

/* ══════════ 批次带：状态 / 标题 / 关键事实 + 四个数 ══════════ */
.batch-band { flex: none; display: flex; align-items: flex-start; gap: 28px; flex-wrap: wrap; padding: 20px 22px; background: var(--parchment); border-radius: var(--r-card); }
.batch-main { flex: 1; min-width: 320px; }
.batch-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.batch-title { margin: 0; font-size: 22px; line-height: 1.25; letter-spacing: -.5px; color: var(--ink); }
.batch-meta { display: flex; align-items: center; flex-wrap: wrap; margin-top: 12px; font-size: var(--fs-sm); color: var(--muted-2); }
.batch-meta i { display: inline-block; width: 1px; height: 11px; margin: 0 11px; background: var(--soft); opacity: .7; }
.batch-meta b { font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.batch-note { margin: 11px 0 0; max-width: 780px; font-size: var(--fs-sm); line-height: 1.65; color: var(--muted); }
.batch-note strong { font-weight: 500; color: var(--ink-2); }

/* 四个数：竖线分隔，不再套第四层卡片 */
.kpis { flex: none; display: flex; align-items: stretch; }
.kpi { min-width: 92px; padding: 2px 20px; border: 0; border-left: 1px solid #e3e3e6; background: transparent; text-align: left; font: inherit; }
.kpi:first-child { padding-left: 0; border-left: 0; }
.kpi b { display: block; font-size: 27px; font-weight: 600; line-height: 1.1; letter-spacing: -.8px; color: var(--ink); font-variant-numeric: tabular-nums; }
.kpi span { display: block; margin-top: 5px; font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.kpi.alert b { color: var(--accent); }
.kpi.mute b { color: var(--soft); }
.kpi-btn { cursor: pointer; transition: color .18s var(--ease); }
.kpi-btn:hover b { color: var(--accent); }
.kpi-btn:disabled { cursor: default; }
.kpi-btn:disabled:hover b { color: var(--soft); }

/* ══════════ 操作条 ══════════ */
.batch-bar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.batch-bar > .micro { flex: 1; min-width: 220px; line-height: 1.6; }

/* ══════════ 主区：名单卡撑满 + 右栏 ══════════ */
.workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 332px; gap: 14px; align-items: stretch; }
.card { display: flex; flex-direction: column; min-height: 320px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.empty-card { flex: 1; min-height: 320px; }

.list-head { flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 13px 16px; border-bottom: 1px solid var(--divider); }
.list-title { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
.list-title h3 { margin: 0; font-size: var(--fs-lg); font-weight: 600; letter-spacing: var(--ls-tight-sm); color: var(--ink); }
.list-title .micro { font-variant-numeric: tabular-nums; }
.filters { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.grade-filter { width: 132px; }
.status-filter { width: 172px; }

/* 表格：由外层 flex 给定高度，表头 sticky 由 el-table 自己管（height 走 ResizeObserver 量出来的像素值） */
.table-wrap { flex: 1; min-height: 0; }
/* 最后一行用遮罩淡出，不让半行表格被卡脚硬切（遮罩比叠一层白渐变稳，不受 stacking 影响） */
.table-wrap { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent 100%); mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent 100%); }
.who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.who-av { width: 28px; height: 28px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--parchment); color: var(--muted-2); font-size: var(--fs-sm); }
.who-main { min-width: 0; }
.who-name { font-size: var(--fs-md); font-weight: 500; line-height: 1.3; color: var(--ink); white-space: nowrap; }
.who-sub { margin-top: 2px; font-size: var(--fs-2xs); line-height: 1.35; color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.num { font-variant-numeric: tabular-nums; }
.seq { font-size: var(--fs-sm); color: var(--muted-2); font-variant-numeric: tabular-nums; }
.iv { line-height: 1.35; font-variant-numeric: tabular-nums; }
.iv .micro { display: block; margin-top: 2px; }
/* 「单独配置」四个字标红（浅底表格里） */
.solo { margin-left: 6px; font-size: var(--fs-2xs); color: var(--red-fg); letter-spacing: var(--ls-wide-sm); }

/* 滚动区底部压一条白渐变：不让半行表格被卡脚硬切 */
.list-foot { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--divider); background: #fcfcfd; }

/* ══════════ 右栏：流程 + 批次信息 ══════════ */
.rail { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.rail-card { padding: 16px 18px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); }
.rail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.rail-head h3 { margin: 0; font-size: var(--fs-md); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-wide-sm); }

/* 五步竖排：实心点＝已完成，空心＝待办，强调色外环＝当前 */
.steps { display: flex; flex-direction: column; }
.step { position: relative; display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 10px; padding-bottom: 14px; }
.step:last-child { padding-bottom: 0; }
.step::before { content: ''; position: absolute; left: 7.5px; top: 15px; bottom: 0; width: 1px; background: var(--divider); }
.step:last-child::before { display: none; }
.step-mark { position: relative; z-index: 1; display: grid; place-items: center; width: 16px; height: 16px; margin-top: 1px; flex: none; border-radius: 50%; border: 1px solid var(--soft); background: var(--canvas); }
.step.done .step-mark { background: var(--ink); border-color: var(--ink); color: #fff; }
.step.now .step-mark { background: var(--canvas); border: 1.5px solid var(--accent); color: var(--accent); }
.step-title { font-size: var(--fs-md); line-height: 1.35; color: var(--soft); }
.step.done .step-title, .step.now .step-title { color: var(--ink); font-weight: 500; }
.step.now .step-title { color: var(--accent); }
.step-sub { margin-top: 3px; font-size: var(--fs-xs); line-height: 1.55; color: var(--muted-2); font-variant-numeric: tabular-nums; }
.step.now .step-sub { color: var(--ink-2); }

.rail-card dl { margin: 0; }
.info-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--divider); }
.info-row:first-child { padding-top: 0; }
.info-row:last-child { padding-bottom: 0; border-bottom: 0; }
.info-row dt { flex: none; font-size: var(--fs-sm); color: var(--muted); }
.info-row dd { margin: 0; font-size: var(--fs-sm); line-height: 1.55; color: var(--ink-2); text-align: right; font-variant-numeric: tabular-nums; }

/* ══════════ 表格操作列的胶囊（处理台也复用） ══════════ */
.pill { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 13px; border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--canvas); color: var(--ink-2); font: inherit; font-size: var(--fs-md); line-height: 1; letter-spacing: var(--ls-wide-sm); white-space: nowrap; cursor: pointer; transition: border-color .18s var(--ease), background .18s var(--ease), color .18s var(--ease); }
.pill:hover { border-color: var(--soft); color: var(--ink); }
.pill:disabled { border-color: var(--divider); color: var(--soft); cursor: not-allowed; }
.pill-acc { background: var(--acc-bg); border-color: var(--acc-bg); color: var(--accent); font-weight: 600; }
.pill-acc:hover { background: #d9e8f8; border-color: #d9e8f8; color: var(--accent); }
.pill-danger { background: var(--red-bg); border-color: var(--red-bg); color: var(--red-fg); font-weight: 600; }
.pill-danger:hover { background: #fbd9d9; border-color: #fbd9d9; color: var(--red-fg); }
/* 问题卡那一栏：胶囊文字与「问题 N」同号，避免一大一小 */
.pill-lg { height: 30px; padding: 0 14px; font-size: var(--fs-lg); }
.tag { display: inline-flex; align-items: center; gap: 5px; height: 23px; padding: 0 10px; border-radius: var(--r-pill); font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm); white-space: nowrap; }
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-reject { background: var(--red-bg); color: var(--red-fg); }
.tag-wait { background: var(--amber-bg); color: var(--amber-fg); }
.tag-mute { background: var(--parchment); color: var(--muted-2); }
.panel { border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.strong { font-weight: 600; color: var(--ink); }
.pager { padding: 16px; justify-content: flex-end; flex-wrap: wrap; }
h3 { font-size: var(--fs-lg); margin: 0; color: var(--ink); }
h3 .micro { margin-left: 8px; font-weight: 400; }
.form-alert { margin: 16px 0 0; }
.two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.two-columns :deep(.el-date-editor) { width: 100%; }
.question-empty { padding: 22px; border: 1px dashed var(--hairline); border-radius: 14px; color: var(--muted); }
.question-editor { background: var(--parchment); border-radius: 14px; padding: 18px; margin-bottom: 12px; }
.question-top { margin-bottom: 16px; }
/* 「问题 N」与右侧胶囊同号（15px），原先字号偏小、与胶囊一大一小 */
.question-top > strong { font-size: var(--fs-lg); font-weight: 600; color: var(--ink); }
.question-tools { gap: 10px; }
.question-settings { gap: 12px; margin-bottom: 16px; }
.type-select { width: 150px; }
.option-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.option-row > .micro { width: 15px; flex-shrink: 0; }
.option-editor > .micro { margin-bottom: 0; }
.option-block { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--divider); }
.option-block-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.option-block-head > strong { font-size: var(--fs-md); color: var(--ink-2); }
/* 年级/班级可选值走多列网格：15 个班级由 15 行压到 5 行，左栏不再把弹窗撑长 */
.option-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 12px; margin-bottom: 12px; }
.option-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.option-cell > .micro { width: 14px; flex-shrink: 0; text-align: right; font-variant-numeric: tabular-nums; }
.option-cell :deep(.el-input) { min-width: 0; }
.option-cell :deep(.el-input__wrapper) { padding-right: 26px; }
.option-cell :deep(.el-input__suffix) { pointer-events: auto; }
/* 「移除」收进输入框右缘的小 ×：省下一列宽度留给输入框 */
.opt-del { width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--soft); font: inherit; font-size: var(--fs-lg); line-height: 1; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background .18s var(--ease), color .18s var(--ease); }
.opt-del:hover:not(:disabled) { background: var(--red-bg); color: var(--red-fg); }
.opt-del:disabled { color: var(--divider); cursor: not-allowed; }
/* 固定信息：每行同高，右侧开关列固定宽度 ⇒ 四个「必填」右缘严格对齐 */
.fixed-list { display: flex; flex-direction: column; }
.fixed-row { display: grid; grid-template-columns: minmax(0, 1fr) 96px; align-items: center; gap: 12px; height: 40px; border-bottom: 1px solid var(--divider); }
.fixed-row:last-child { border-bottom: 0; }
.fixed-name { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.fixed-name > strong { font-size: var(--fs-md); color: var(--ink); }
.fixed-name > .micro { line-height: 1.5; }
.fixed-switch { display: flex; align-items: center; justify-content: flex-end; height: 34px; }
:deep(.fixed-switch .el-switch__label) { font-size: var(--fs-sm); color: var(--muted-2); }
.legacy-note { padding: 12px 14px; background: var(--parchment); border-radius: 10px; color: var(--muted-2); font-size: var(--fs-sm); line-height: 1.7; margin: 16px 0 0; }
.order-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.order-heading p { line-height: 1.7; margin-bottom: 0; }
.order-note { line-height: 1.7; margin-bottom: 10px; }
/* ---- 处理台外壳：题头 + 同底色两栏（与投稿处理台同一套语言） ---- */
:deep(.recruitment-console) { border-radius: var(--r-tile); padding: 0; overflow: hidden; box-shadow: 0 30px 80px -30px rgba(0, 0, 0, .45); }
:deep(.recruitment-console .el-dialog__header) { margin: 0; padding: 14px 22px; border-bottom: 1px solid var(--divider); }
:deep(.recruitment-console .el-dialog__body) { padding: 0; background: var(--parchment); }
:deep(.recruitment-console .el-dialog__footer) { padding: 12px 22px; border-top: 1px solid var(--divider); background: var(--canvas); }
.console-heading, .console-heading-main, .console-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.console-heading-main { justify-content: flex-start; }
.console-heading-main > strong { font-size: var(--fs-2xl); }
.console-kind { border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 3px 10px; font-size: var(--fs-xs); color: var(--muted-2); }
.console-subtitle { margin-top: 5px; line-height: 1.7; }
.detail-body { box-sizing: border-box; height: calc(86vh - 150px); min-height: 160px; overflow: hidden; }
/* 审核处理台的两栏不直接挂 .config-body/.plan-body，得自己撑满这个固定高度才滚得起来 */
.detail-body > .console-columns { height: 100%; }
/* ⚠️ 两栏必须同底色（原先左白右灰，被陛下点名）；靠间距分区，不再用左侧白底 + 右分割线 */
/* ⚠️ 这两层必须显式 border-box：Element Plus 的全局重置没覆盖普通 div，默认 content-box 会让
   padding 32px 额外撑高一个身位，正好被外层 overflow:hidden 把两栏底部裁掉。 */
.console-columns { box-sizing: border-box; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.02fr); gap: 16px; padding: 16px 22px; align-items: stretch; }
/* 两栏各自上下滚动：容器不再整块滚，每栏一根自己的滚动条、各滚各的，两栏顶部始终对齐。
   scrollbar-gutter: stable 让两栏都预留滚动条宽度 ⇒ 卡片等宽（否则有滚动条那栏会窄 10px）。 */
.console-column { display: flex; flex-direction: column; gap: 16px; min-width: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.console-column::-webkit-scrollbar { width: 10px; }
.console-column::-webkit-scrollbar-track { background: transparent; }
.console-column::-webkit-scrollbar-thumb { background: var(--soft); border: 3px solid transparent; border-radius: var(--r-pill); background-clip: padding-box; }
.console-column::-webkit-scrollbar-thumb:hover { background: var(--muted); border: 3px solid transparent; border-radius: var(--r-pill); background-clip: padding-box; }
/* 固定一屏高 + overflow hidden：两栏等高，内容多的那栏自己滚 */
.config-body, .plan-body { height: calc(86vh - 150px); overflow: hidden; }
.desk-card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); padding: 18px; }
.desk-card-fill { flex: 1; }
.desk-head { margin-bottom: 14px; }
.desk-head > h3 { display: inline-flex; align-items: center; }
.desk-head > .micro, .desk-note { line-height: 1.7; }
.desk-note { color: var(--muted-2); margin: 0 0 14px; }
.desk-card :deep(.el-form-item:last-child) { margin-bottom: 0; }
.desk-card :deep(.el-form-item .micro) { width: 100%; margin: 8px 0 0; line-height: 1.7; }
/* 卡片内按钮组与上方最后一行控件之间必须有呼吸：上一行把 last form-item 的 margin-bottom 抹平了，
   .actions 自己又没有上边距 ⇒ 按钮上沿正好压住输入框底边框（2026-11-16 陛下退回「黏住上面的框底」）。
   取 18px 与卡片自身 padding 同值，按钮块上下留白对称。 */
.desk-card > .actions { margin-top: 18px; }
/* 同类：锁定期（canPlan=false）按钮组整个不渲染，提示语直接跟在表单后面，同样是 0 间距 */
.desk-card > .el-form + .desk-note { margin-top: 12px; }
/* 深色人物卡：姓名/年级/状态标签全部包在一块深色卡里（原先名字落在卡外） */
.person-card { background: var(--tile); color: #fff; border-radius: 14px; padding: 16px 18px; }
.person-row { display: flex; align-items: center; gap: 13px; }
.person-avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; background: rgba(255, 255, 255, .14); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-lg); font-weight: 600; }
.person-main { min-width: 0; }
.person-name { font-size: var(--fs-lg); font-weight: 600; }
.person-sub { font-size: var(--fs-sm); color: rgba(255, 255, 255, .66); margin-top: 3px; }
.person-row > .tag { margin-left: auto; flex: none; }
.person-stats { margin-top: 14px; padding-top: 13px; border-top: 1px solid rgba(255, 255, 255, .22); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.person-stats > div { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.person-stats span { font-size: var(--fs-xs); color: rgba(255, 255, 255, .6); }
.person-stats strong { font-size: var(--fs-lg); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.person-solo { align-self: flex-start; }
/* 「单独配置」四个字标红（浅底表格里） */
.solo { margin-left: 8px; font-size: var(--fs-xs); color: var(--red-fg); letter-spacing: var(--ls-wide-sm); }
.answer { margin: 0 0 16px; }
.answer:last-child { margin-bottom: 0; }
.answer-title { font-weight: 500; line-height: 1.7; }
.answer-content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin-top: 6px; background: var(--parchment); border-radius: 10px; padding: 12px 14px; }
/* 1520 以下：不再固定一屏高，整页自然滚动，右栏并成两张横排卡 */
@media (max-width: 1520px) {
  .recruitment-page { height: auto; }
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .rail { display: grid; grid-template-columns: 1fr 1fr; align-items: start; }
  .card { min-height: 560px; }
}
/* 1180 以下：四个数换行到批次带底下，右栏收成一列 */
@media (max-width: 1180px) {
  .kpis { width: 100%; padding-top: 14px; border-top: 1px solid #e3e3e6; }
  .rail { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .two-columns { grid-template-columns: 1fr; gap: 0; }
  .option-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grade-filter, .status-filter { flex: 1; min-width: 150px; }
}
@media (max-width: 760px) {
  /* 窄屏单列堆叠：取消固定一屏高与「各自滚动」，回到整页自然滚动 */
  .console-columns { display: block; padding: 16px; }
  .console-column { margin-bottom: 16px; overflow: visible; }
  .config-body, .plan-body, .detail-body { height: auto; min-height: 0; overflow: visible; }
  .console-footer > .micro { width: 100%; }
  .console-footer > .actions { margin-left: auto; }
  :deep(.recruitment-console .el-dialog__header), :deep(.recruitment-console .el-dialog__footer) { padding-left: 18px; padding-right: 18px; }
}
@media (max-width: 560px) {
  .option-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
