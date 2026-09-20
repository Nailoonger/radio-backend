<template>
  <div class="stu-page">
    <!-- ══════════ 模块内子导航 ══════════ -->
    <div class="subtabs">
      <button
        v-for="t in tabs" :key="t.k"
        class="subtab" :class="{ on: tab === t.k }"
        @click="switchTab(t.k)"
      >{{ t.label }}</button>
    </div>

    <!-- ══════════════════ 1. 账号列表 ══════════════════ -->
    <template v-if="tab === 'list'">
      <!-- v8：深色条只说两件运维事实 -->
      <div class="dark-strip">
        <div class="ds-item">
          <span class="ds-dot"></span>
          <b>登录已强制</b>：学生只能用学号账号登录{{ switchState.accountLoginRequired ? '，微信登录已关闭' : '' }}
        </div>
        <div class="ds-sep"></div>
        <div class="ds-item">
          <b>初始密码</b>：user + 学号（如 user20240101），首次登录必须改密
        </div>
        <div class="ds-right micro">共 {{ listTotal }} 个账号</div>
      </div>

      <el-card>
        <div class="toolbar">
          <el-input v-model="listQuery.keyword" placeholder="搜索姓名 / 账号" clearable style="width: 220px;" @keyup.enter="searchStudents">
            <template #prefix><IconSearch :size="15" /></template>
          </el-input>
          <el-select v-model="listQuery.grade" placeholder="年级" clearable style="width: 110px;">
            <el-option v-for="g in gradeOptions" :key="g" :label="g + ' 级'" :value="g" />
          </el-select>
          <el-select v-model="listQuery.classNo" placeholder="班级" clearable style="width: 110px;">
            <el-option v-for="c in classOptions" :key="c" :label="c + ' 班'" :value="c" />
          </el-select>
          <el-select v-model="listQuery.state" placeholder="状态" clearable style="width: 120px;">
            <el-option label="已激活" value="activated" />
            <el-option label="未激活" value="inactive" />
            <el-option label="已停用" value="disabled" />
          </el-select>
          <el-button type="primary" @click="searchStudents">查询</el-button>
          <div class="tb-right">
            <el-button @click="exportStudents">导出 xlsx</el-button>
            <el-button @click="resetPasswordBatchVisible = true">批量重置密码</el-button>
          </div>
        </div>

        <el-table
          ref="listTableRef"
          :data="listRows" v-loading="listLoading" stripe
          @selection-change="(r) => (selected = r)"
        >
          <!-- v8：勾选后可批量重置密码 / 批量停用（没有批量删除，见权限边界表） -->
          <el-table-column type="selection" width="46" />
          <el-table-column label="账号" prop="username" width="132">
            <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
          </el-table-column>
          <el-table-column label="姓名" width="110">
            <template #default="{ row }">{{ row.name || row.remark || '—' }}</template>
          </el-table-column>
          <el-table-column label="班级" width="120">
            <template #default="{ row }">{{ row.className || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="106" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small" effect="light">
                {{ row.status === 1 ? '启用' : '停用' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="激活" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="row.pwdChangedAt ? 'success' : 'info'" size="small" effect="light">
                {{ row.pwdChangedAt ? '已激活' : '未激活' }}
              </el-tag>
            </template>
          </el-table-column>
          <!-- 这一列不锁死宽度：弹性吸收剩余宽度，让表格撑满卡片、右缘与批量条对齐 -->
          <el-table-column label="最近登录" min-width="150">
            <template #default="{ row }"><span class="c-time">{{ row.lastLoginAt ? fmt(row.lastLoginAt) : '—' }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="228" align="right">
            <template #default="{ row }">
              <div class="op-cell">
                <el-button size="small" @click="openRename(row)">改名</el-button>
                <el-button size="small" @click="resetPassword(row)">重置密码</el-button>
                <el-button size="small" :type="row.status === 1 ? 'danger' : 'primary'" plain @click="toggleStatus(row)">
                  {{ row.status === 1 ? '停用' : '启用' }}
                </el-button>
              </div>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState variant="content" title="还没有学生账号" description="用「批量导入」上传名册，或先下载模板看看格式" />
          </template>
        </el-table>

        <el-pagination
          v-model:current-page="listQuery.page"
          v-model:page-size="listQuery.pageSize"
          :total="listTotal"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          class="pager"
          @current-change="fetchStudents"
          @size-change="fetchStudents"
        />
      </el-card>

      <!-- ══════════ 批量操作条（v8：勾选后浮出，三动作） ══════════ -->
      <div class="batchbar" v-if="selected.length">
        <span class="cnt">已选 <b class="num">{{ selected.length }}</b> 条</span>
        <span class="micro bb-hint">删除有投稿记录的账号会改为「停用」，不会硬删</span>
        <el-button size="small" class="bb-quiet" :loading="batchBusy" @click="batchResetPwd">
          批量重置为初始密码
        </el-button>
        <el-button size="small" class="bb-quiet" :loading="batchBusy" @click="batchDisable">
          批量停用
        </el-button>
        <!-- 不可逆批量属于超管边界（权限边界表），整块学生账号模块本身也是超管专用 -->
        <template v-if="auth.isSuperAdmin">
          <el-button size="small" class="bb-danger" :loading="batchBusy" @click="batchRemove">
            批量删除
          </el-button>
        </template>
        <el-button size="small" class="bb-plain" @click="clearSelection">取消选择</el-button>
      </div>
    </template>

    <!-- ══════════════════ 2. 批量导入（v8 屏「批量导入 · 预览」） ══════════════════ -->
    <template v-else-if="tab === 'import'">
      <!-- 标题区：v8 data-title/data-sub -->
      <div class="im-head">
        <div>
          <div class="im-title">{{ importPreview ? '批量导入 · 预览' : '批量导入' }}</div>
          <div class="im-sub micro" v-if="importPreview">{{ importPreview.filename }} · 已解析 {{ importRows.length }} 行 · 表头识别：第 {{ (importPreview.headerRowIndex ?? 0) + 1 }} 行{{ importPreview.mode === 'compact' ? ' · 紧凑格式' : '' }}</div>
        </div>
        <el-button v-if="importPreview" size="small" @click="resetImport">重新选择</el-button>
      </div>

      <!-- 步骤条：① 上传表格 › ② 预览与确认 › ③ 完成 -->
      <el-card class="step-card">
        <div class="stepper">
          <span class="st-it"><span class="st-no" :class="{ on: stepNo >= 1, done: stepNo > 1 }">{{ stepNo > 1 ? '✓' : '1' }}</span><span :class="stepNo === 1 ? 'strong' : 'micro'">上传表格</span></span>
          <span class="micro">›</span>
          <span class="st-it"><span class="st-no" :class="{ on: stepNo >= 2, done: stepNo > 2 }">{{ stepNo > 2 ? '✓' : '2' }}</span><span :class="stepNo === 2 ? 'strong' : 'micro'">预览与确认</span></span>
          <span class="micro">›</span>
          <span class="st-it"><span class="st-no" :class="{ on: stepNo >= 3 }">3</span><span :class="stepNo === 3 ? 'strong' : 'micro'">完成</span></span>
          <span class="micro st-note">只解析不落库，确认后才写入</span>
        </div>
      </el-card>

      <!-- ① 上传 -->
      <el-card v-if="!importPreview">
        <div class="import-intro">
          <div class="ii-left">
            <div class="sec-title">上传学生名册</div>
            <ul class="ii-list">
              <li>支持 <b>.xlsx / .xls / .csv</b>；表头需含 年级 / 班级 / 序号 / 姓名（也兼容紧凑格式）</li>
              <li>账号规则：<span class="mono">年级(4) + 班级(2) + 序号(2)</span>，如 <span class="mono">20240101</span></li>
              <li>初始密码：<span class="mono">user + 学号</span>，学生首次登录必须改密</li>
              <li>名册姓名即学生的显示名（全站不收集头像）</li>
            </ul>
          </div>
          <div class="ii-right">
            <el-button @click="downloadTemplate">下载模板</el-button>
          </div>
        </div>

        <div class="drop-zone" @click="fileInput?.click()" @dragover.prevent @drop.prevent="onDrop">
          <IconUpload :size="26" />
          <div class="dz-title">点击选择文件，或把名册拖到这里</div>
          <div class="micro">解析后先给你预览，确认无误再写入 —— 不会直接动库</div>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onPick" />
      </el-card>

      <!-- ② 预览与确认 -->
      <template v-else>
        <!-- 统计条：四类结论各一个标签，看统计条就知道能不能导 -->
        <el-card class="sum-card">
          <div class="sum-bar">
            <span class="sum-it"><el-tag size="small" effect="light" type="success">新建</el-tag><b class="num">{{ importPreview.summary.new || 0 }}</b></span>
            <span class="sum-it"><el-tag size="small" effect="light" type="warning">覆盖</el-tag><b class="num">{{ importPreview.summary.update || 0 }}</b><span class="micro">未激活，可安全覆盖</span></span>
            <span class="sum-it"><el-tag size="small" effect="light" type="info">受保护</el-tag><b class="num">{{ importPreview.summary.active || 0 }}</b><span class="micro">已激活，默认跳过</span></span>
            <span class="sum-it"><el-tag size="small" effect="light" type="danger">异常</el-tag><b class="num">{{ importPreview.summary.invalid || 0 }}</b><span class="micro">带原文行号，不写库</span></span>
          </div>
        </el-card>

        <el-card>
          <el-table :data="importRows" max-height="480" :row-class-name="importRowClass">
            <el-table-column label="行号" width="84" align="center">
              <template #default="{ row }"><span class="mono im-rowno">第 {{ row.rowNo }} 行</span></template>
            </el-table-column>
            <el-table-column label="表格原内容" min-width="210">
              <template #default="{ row }"><span class="mono im-raw">{{ rawText(row) }}</span></template>
            </el-table-column>
            <el-table-column label="识别结果" width="140">
              <template #default="{ row }"><span class="mono" :class="{ strong: row.username }">{{ row.username || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="结论" width="104" align="center">
              <template #default="{ row }">
                <el-tag size="small" effect="light" :type="CONCL[row.state]?.type || 'info'">{{ CONCL[row.state]?.text || row.state }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="300">
              <template #default="{ row }">
                <span class="micro explain-cell" :class="{ 'im-err': row.state === 'invalid' }" v-html="explain(row)"></span>
              </template>
            </el-table-column>
            <template #empty>
              <EmptyState variant="content" title="没有解析到数据行" description="表头下面全是空行？回表格补上再传" />
            </template>
          </el-table>
        </el-card>

        <!-- 底部：左开关 / 右警示 + 按钮组 -->
        <div class="im-cols">
          <el-card class="im-switches">
            <div class="sw-row">
              <el-switch v-model="impForce" @change="repreview" />
              <div class="sw-txt">
                <div class="sw-name">强制覆盖已激活</div>
                <div class="micro">默认关。打开后覆盖备注与三元组，<b>仍然不碰密码</b></div>
              </div>
            </div>
            <div class="sw-row">
              <el-switch v-model="impStrict" />
              <div class="sw-txt">
                <div class="sw-name">严格模式</div>
                <div class="micro">有异常行就整批不导入（当前：<b>{{ importPreview.summary.invalid || 0 }} 行异常{{ importPreview.summary.invalid ? '，整批会被拦下' : '' }}</b>）</div>
              </div>
            </div>
          </el-card>
          <div class="im-right">
            <div class="im-warnline">
              <IconInfo :size="15" />
              <span>导出文件<b>含初始密码明文</b>，只用于分发给本人；已改过密码的行会留空。</span>
            </div>
            <div class="im-btns">
              <el-button @click="resetImport">取消</el-button>
              <el-button v-if="importPreview.summary.invalid" link type="primary" :disabled="importing" @click="confirmImport(false)">忽略异常行继续</el-button>
              <el-button type="primary" :loading="importing" @click="confirmImport(true)">确认导入 {{ importableCount }} 行</el-button>
            </div>
          </div>
        </div>
      </template>

      <!-- ③ 导入完成回执（必须出现初始密码提示） -->
      <div class="dark-card" v-if="importResult">
        <div class="dc-head">
          <div>
            <div class="dc-eyebrow">导入完成 · 批次 #{{ importResult.batchId }}</div>
            <div class="dc-title">新建 {{ importResult.created }} · 更新 {{ importResult.updated }} · 跳过 {{ importResult.skipped }}</div>
          </div>
          <el-button size="small" @click="exportStudents">导出含初始密码 xlsx</el-button>
        </div>
        <div class="dc-note">
          初始密码 = <b>user + 学号</b>（如 user20240101）。密码只在导出文件里能看到，
          本页与列表都不显示；学生首次登录会被强制改密。
        </div>
        <div class="dc-note">本次批次可在「导入批次」里撤销（只删本次新建、且没有投稿记录的账号）。</div>
      </div>
    </template>

    <!-- ══════════════════ 3. 导入批次 ══════════════════ -->
    <template v-else-if="tab === 'batches'">
      <el-card>
        <el-table :data="batchRows" v-loading="batchLoading" stripe>
          <el-table-column label="批次" width="90">
            <template #default="{ row }"><span class="mono">#{{ row.id }}</span></template>
          </el-table-column>
          <el-table-column label="时间" width="160">
            <template #default="{ row }"><span class="c-time">{{ fmt(row.createTime) }}</span></template>
          </el-table-column>
          <el-table-column label="文件" prop="filename" min-width="180" show-overflow-tooltip />
          <el-table-column label="操作人" prop="operatorName" width="110" />
          <el-table-column label="新建" prop="created" width="80" align="right" />
          <el-table-column label="更新" prop="updated" width="80" align="right" />
          <el-table-column label="跳过" prop="skipped" width="80" align="right" />
          <el-table-column label="状态" width="110" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="light" :type="row.rolledBackAt ? 'info' : 'success'">
                {{ row.rolledBackAt ? '已撤销' : '生效中' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" align="right">
            <template #default="{ row }">
              <el-button size="small" :disabled="!!row.rolledBackAt" @click="rollbackBatch(row)">撤销</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState variant="content" title="还没有导入批次" description="去「批量导入」上传一份名册，这里会记录每次导入" />
          </template>
        </el-table>
      </el-card>

      <div class="note-card">
        <b>撤销的边界</b>：只删除<b>本次新建</b>且<b>没有投稿记录</b>的账号；
        已经有投稿记录的账号会被改成停用（否则审核列表里就查不到人）；
        已被学生改过密码的账号不会被撤销 —— 那说明人已经在用了。
      </div>
    </template>

    <!-- ══════════════════ 4. 清理完成回执 ══════════════════ -->
    <template v-else-if="tab === 'receipt' && receipt">
      <div class="back-row">
        <a class="back-link" @click="switchTab('grades')">‹ 返回按年级总览</a>
      </div>

      <div class="dark-card receipt">
        <div class="dc-head">
          <div>
            <div class="dc-eyebrow">{{ fmt(receipt.createTime) }} 执行 · 操作人 {{ receipt.operatorName || '—' }}</div>
            <div class="dc-title">{{ receipt.gradeName || receipt.grade + ' 级' }}{{ receipt.mode === 'disable' ? ' 已停用' : ' 已清理' }}</div>
            <div class="dc-sub">
              删除 {{ receipt.deleted }} 个 · 停用 {{ receipt.disabled }} 个 · 涉及 {{ receipt.classCount || 0 }} 个班级 · {{ receipt.costText }}
            </div>
          </div>
          <div class="dc-actions">
            <el-button size="small" @click="exportReceipt">导出清理回执</el-button>
            <el-button size="small" v-if="(receipt.disabledAccounts || []).length" @click="disabledVisible = true">
              查看停用的 {{ (receipt.disabledAccounts || []).length }} 个
            </el-button>
          </div>
        </div>
      </div>

      <div class="pill-stats">
        <div class="pill-stat"><span class="ps-num num">{{ gradeList.length }}</span><span class="ps-label">年级数</span></div>
        <div class="pill-stat"><span class="ps-num num">{{ overall.total }}</span><span class="ps-label">账号总数</span></div>
        <div class="pill-stat"><span class="ps-num num">{{ overall.activated }}</span><span class="ps-label">已激活</span></div>
        <div class="pill-stat"><span class="ps-num num">{{ receipt.disabled }}</span><span class="ps-label">残留在库（停用）</span></div>
      </div>

      <el-card>
        <template #header>
          <div class="card-head-line">
            <span>执行明细</span>
            <span class="micro">完整记录见系统日志</span>
          </div>
        </template>
        <div class="detail-rows">
          <div class="dr"><span class="dr-k">真正删除</span><span class="dr-v"><b class="num">{{ receipt.deleted }}</b> 账号与登录记录一并清除，无法恢复</span></div>
          <div class="dr"><span class="dr-k">改为停用</span><span class="dr-v"><b class="num">{{ receipt.disabled }}</b>
            <span class="dr-list">{{ (receipt.disabledAccounts || []).map((a) => a.username).join(' / ') || '无' }}</span></span></div>
          <div class="dr"><span class="dr-k">登录态作废</span><span class="dr-v"><b class="num">{{ receipt.total }}</b> 立即生效，不等 30 秒缓存</span></div>
          <div class="dr"><span class="dr-k">不受影响</span><span class="dr-v"><b class="num">{{ receipt.untouched }}</b> 其余届未被触碰</span></div>
        </div>
      </el-card>

      <div class="grade-section">
        <div class="sec-title">按年级</div>
        <div class="micro">{{ receipt.gradeName || receipt.grade + ' 级' }}已从列表移除；被停用的 {{ receipt.disabled }} 个账号仍可用「搜索账号」查到</div>
      </div>
      <div class="grade-grid">
        <div class="grade-card" v-for="g in gradeList" :key="g.grade" :class="{ cleaned: g.total === 0 }">
          <div class="gc-head">
            <span class="gc-name">{{ g.name }}</span>
            <span class="gc-tag">{{ g.total === 0 ? '已清理' : '在校' }}</span>
          </div>
          <div v-if="g.total" class="gc-nums">
            <div><span class="num">{{ g.total }}</span><em>账号</em></div>
            <div><span class="num">{{ g.classCount }}</span><em>班级</em></div>
            <div><span class="num">{{ g.activated }}</span><em>已激活</em></div>
          </div>
          <div v-else class="gc-empty">被停用的账号仍可用「搜索账号」查到</div>
          <div class="gc-bar" v-if="g.total"><i :style="{ width: pct(g) }" /></div>
          <div class="gc-foot" v-if="g.total">
            <a class="gc-link" @click="openGrade(g.grade)">查看账号</a>
            <span class="micro">{{ Number(g.grade) + 4 }} 年毕业</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ══════════════════ 5. 年级详情 ══════════════════ -->
    <template v-else-if="gradeInfo">
      <div class="back-row">
        <a class="back-link" @click="gradeInfo = null">‹ 返回按年级总览</a>
        <div class="grade-pills">
          <button
            v-for="g in gradeList" :key="g.grade"
            class="gp" :class="{ on: gradeInfo.grade === g.grade }"
            @click="openGrade(g.grade)"
          >{{ g.name }} <em class="num">{{ g.total }}</em></button>
        </div>
      </div>

      <div class="pill-stats">
        <div class="pill-stat"><span class="ps-num num">{{ gradeInfo.total }}</span><span class="ps-label">账号</span></div>
        <div class="pill-stat"><span class="ps-num num">{{ gradeInfo.classCount }}</span><span class="ps-label">班级</span></div>
        <div class="pill-stat"><span class="ps-num num">{{ gradeInfo.activated }}</span><span class="ps-label">已激活</span></div>
        <div class="pill-stat"><span class="ps-num num">{{ gradeInfo.withSubmit }}</span><span class="ps-label">有投稿记录</span></div>
      </div>

      <el-card>
        <template #header><span>班级明细</span></template>
        <el-table :data="gradeInfo.classes" stripe>
          <el-table-column label="班级" prop="className" min-width="150" />
          <el-table-column label="账号" prop="total" width="90" align="right" />
          <el-table-column label="已激活" prop="activated" width="100" align="right" />
          <el-table-column label="有投稿记录" prop="withSubmit" width="120" align="right" />
        </el-table>
      </el-card>

      <!-- v8：毕业清理刻意不放工具栏，放最下面一条独立危险区 -->
      <div class="danger-zone">
        <div class="dz-left">
          <div class="dz-title">毕业清理</div>
          <div class="dz-sub">
            只清理<b>已经毕业的那一届</b>。默认规则：没有投稿记录的账号直接删除，
            有投稿记录的改为停用（审核列表里还能查到人）；删除后无法恢复。
          </div>
        </div>
        <div class="dz-right">
          <el-button @click="exportGradeList">导出本届 xlsx</el-button>
          <el-button class="dz-danger" @click="openCleanup">毕业清理</el-button>
        </div>
      </div>
    </template>

    <!-- ══════════════════ 6. 按年级总览（v8 屏 8：说明条 + KPI + 年级卡片组） ══════════════════ -->
    <template v-else>
      <!-- 顶部说明条：只说两件运维事实 -->
      <div class="tile-strip">
        <div class="grow">
          <div class="t">账号按届归档，毕业即清理</div>
          <div class="m">
            账号 = 入学年级 + 班级 + 序号 · 库里 {{ gradeList.length }} 届
            <template v-if="lastImportAt">· 最近一次导入 {{ fmt(lastImportAt) }}</template>
          </div>
        </div>
        <div class="metrics">
          <span class="chip">DELETE /student/grade/:grade</span>
          <el-button size="small" class="strip-btn" @click="rulesVisible = true">查看清理规则</el-button>
        </div>
      </div>

      <!-- 整体统计：第一格深色 -->
      <div class="kpis">
        <div class="kpi kpi-dark">
          <div class="k">年级数</div>
          <div class="v num">{{ gradeList.length }}</div>
          <div class="d">覆盖 {{ totalClassCount }} 个班级</div>
        </div>
        <div class="kpi">
          <div class="k">账号总数</div>
          <div class="v num">{{ overall.total }}</div>
          <div class="d">{{ gradeNamesText }}</div>
        </div>
        <div class="kpi">
          <div class="k">已激活</div>
          <div class="v num">{{ overall.activated }}</div>
          <div class="d">占 {{ activatedPct }}% · 首登即算激活</div>
        </div>
        <div class="kpi">
          <div class="k">未激活</div>
          <div class="v num">{{ Math.max(overall.total - overall.activated, 0) }}</div>
          <div class="d">初始密码 = user + 学号</div>
        </div>
      </div>

      <!-- 年级卡片组：该清理的那一届＝深色卡，其余白卡描边 -->
      <div class="sec">
        <div class="sec-head">
          <div>
            <div class="sec-title">按年级</div>
            <div class="sub">点年级卡进详情；「毕业清理」在卡片右下角，是危险操作，会先弹试算</div>
          </div>
          <el-button size="small" @click="loadGrades">
            <IconRefresh :size="15" class="btn-icon" />刷新
          </el-button>
        </div>

        <div class="cols">
          <template v-for="(g, i) in gradeList" :key="g.grade">
            <!-- 可毕业届：深色卡 -->
            <div class="tile g-tile" v-if="isCleanable(g)">
              <div class="tile-status">
                <span class="dot-live"></span>
                本届可毕业清理
              </div>
              <div>
                <div class="tile-title num">{{ g.grade }} 级</div>
                <div class="tile-meta">{{ g.total }} 个账号 · {{ g.classCount }} 个班级</div>
              </div>
              <div class="bar ok"><i :style="{ width: pct(g) }"></i></div>
              <div class="tile-meta tight">
                已激活 <b class="num">{{ g.activated }}</b> / {{ g.total }}
                <span class="sep-dot">·</span> 有投稿记录 <b class="num">{{ cleanableWithSubmit }}</b>
              </div>
              <div class="tile-actions">
                <el-button size="small" @click="openGrade(g.grade)">查看账号</el-button>
                <button class="btn-danger-ghost" @click="startCleanup(g.grade)">毕业清理</button>
              </div>
            </div>

            <!-- 在校届：白卡 -->
            <div class="gcard" v-else>
              <div class="gcard-h">
                <span class="nm num">{{ g.grade }} 级</span>
                <span class="gcard-tag" :class="{ empty: g.total === 0 }">
                  {{ g.total === 0 ? '已清理' : '在校' }}
                </span>
              </div>
              <div class="gcard-kv">
                <div><div class="k">账号</div><div class="v num">{{ g.total }}</div></div>
                <div><div class="k">班级</div><div class="v num">{{ g.classCount }}</div></div>
                <div><div class="k">已激活</div><div class="v num">{{ g.activated }}</div></div>
              </div>
              <div class="bar ok"><i :style="{ width: pct(g) }"></i></div>
              <div class="gcard-foot">
                <a class="link" @click="openGrade(g.grade)">查看账号</a>
                <a v-if="g.total === 0" class="link sub-link" @click="loadReceipt(g.grade)">查看清理回执</a>
                <span class="micro ml-auto">{{ Number(g.grade) + 4 }} 年毕业</span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="note-card" v-if="lastReceipt">
        <b>最近一次清理</b>：{{ fmt(lastReceipt.createTime) }} · {{ lastReceipt.gradeName }} ·
        删除 {{ lastReceipt.deleted }} / 停用 {{ lastReceipt.disabled }} · 操作人 {{ lastReceipt.operatorName }}
        <a class="link" @click="showReceipt(lastReceipt)">查看回执 ›</a>
      </div>
    </template>

    <!-- 清理规则（说明条右侧入口） -->
    <el-dialog v-model="rulesVisible" title="毕业清理规则" width="560px">
      <div class="rule-list">
        <div class="rule-row"><span class="rule-k">safe（默认）</span><span class="rule-v">没有投稿记录的账号真正删除；有投稿记录的改为「停用」，投稿、留言、回执都还在</span></div>
        <div class="rule-row"><span class="rule-k">disable（只停用）</span><span class="rule-v">整届都不删，只把登录关掉；适合「先看看效果」再决定</span></div>
        <div class="rule-row"><span class="rule-k">purge（全删）</span><span class="rule-v">整届连同记录一起删除，必须在弹窗里手打年级名才能执行，不可撤销</span></div>
        <div class="rule-row"><span class="rule-k">登录态</span><span class="rule-v">执行后逐个作废，立即生效，不等 30 秒缓存</span></div>
      </div>
      <template #footer>
        <el-button type="primary" @click="rulesVisible = false">知道了</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 毕业清理 · 确认 ══════════ -->
    <el-dialog v-model="cleanVisible" width="640px" top="8vh" class="clean-dialog">
      <template #header>
        <div class="cd-head">
          <div>
            <div class="cd-title">毕业清理 · {{ gradeInfo?.name }}</div>
            <div class="cd-sub">试算已完成 · 这一步之后不可撤销</div>
          </div>
          <span class="cd-tag">不可撤销</span>
        </div>
      </template>
      <div class="cd-body" v-if="gradeInfo">
        <div class="cd-stats">
          <div class="cd-stat cd-stat--danger">
            <span class="cs-num num">{{ gradeInfo.canDelete }}</span>
            <span class="cs-label">将删除</span>
            <span class="cs-note">没有投稿记录</span>
          </div>
          <div class="cd-stat">
            <span class="cs-num num">{{ gradeInfo.withSubmit }}</span>
            <span class="cs-label">将停用</span>
            <span class="cs-note">有投稿记录，保留记录</span>
          </div>
          <div class="cd-stat">
            <span class="cs-num num">{{ gradeInfo.classCount }}</span>
            <span class="cs-label">涉及班级</span>
            <span class="cs-note">整届 {{ gradeInfo.total }} 个账号</span>
          </div>
        </div>

        <div class="cd-rows">
          <div class="dr"><span class="dr-k">删除</span><span class="dr-v">{{ gradeInfo.canDelete }} 个账号从库里彻底移除：账号、密码、登录次数、最近登录时间一起没。这 {{ gradeInfo.canDelete }} 人再也登不进来。</span></div>
          <div class="dr"><span class="dr-k">停用</span><span class="dr-v">{{ gradeInfo.withSubmit }} 个账号改为「停用」。他们的投稿记录还在账号上，审核列表里能看到，不会变成一串指向空账号的记录。</span></div>
          <div class="dr"><span class="dr-k">登录态</span><span class="dr-v">执行后这 {{ gradeInfo.total }} 个账号的登录态立即失效，学生手里的 token 下一次请求就被踢，不用等 30 秒缓存。</span></div>
          <div class="dr"><span class="dr-k">建议</span><span class="dr-v">先点「导出本届 xlsx」留一份名单再清理。已改密的学生导不出密码（哈希不可逆），这是正常的。</span></div>
        </div>

        <div class="cd-warn">
          ⚠️ 如果只是想让他们登不进来、档案还没整理完，用右下角的「只停用，不删除」—— 那个动作以后还能撤回。
        </div>

        <div class="cd-more">
          <a class="gc-link" @click="purgeVisible = true">还是要把这 {{ gradeInfo.withSubmit }} 个有投稿记录的账号也一起删掉？走 purge 危险确认 ›</a>
        </div>
      </div>
      <template #footer>
        <div class="cd-foot">
          <span class="micro">年级「{{ gradeInfo?.grade }}」· 由 {{ auth.admin?.nickname || auth.admin?.username }} 执行 · 会写入操作日志</span>
          <div class="cd-foot-right">
            <el-button @click="cleanVisible = false">取消</el-button>
            <el-button :loading="cleaning" @click="doCleanup('disable')">只停用，不删除</el-button>
            <el-button class="cd-danger" :loading="cleaning" @click="doCleanup('safe')">
              删除 {{ gradeInfo?.canDelete }} 个账号
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- ══════════ purge 危险确认（手打年级名） ══════════ -->
    <el-dialog v-model="purgeVisible" width="560px" top="10vh" class="purge-dialog">
      <template #header>
        <div class="cd-head">
          <div>
            <div class="cd-title">连投稿记录一起删 · {{ gradeInfo?.name }}</div>
            <div class="cd-sub">purge 模式 · {{ gradeInfo?.total }} 个账号全部移除</div>
          </div>
          <span class="cd-tag">危险操作</span>
        </div>
      </template>
      <div class="cd-body">
        <div class="cd-warn cd-warn--hard">
          ⚠️ 这一版会把投稿记录的 {{ gradeInfo?.withSubmit }} 个账号也一起删掉。后台审核列表里对应的投稿还在，
          但作者会显示成「已注销账号」—— 投稿内容不去，归属没了。
        </div>
        <div class="cd-rows">
          <div class="dr"><span class="dr-k">删除</span><span class="dr-v">{{ gradeInfo?.total }} 个</span></div>
          <div class="dr"><span class="dr-k">保留</span><span class="dr-v">0 个</span></div>
          <div class="dr"><span class="dr-k">投稿记录</span><span class="dr-v">保留内容，作者显示「已注销账号」</span></div>
        </div>
        <div class="purge-input">
          <div class="pi-label">请输入年级「{{ gradeInfo?.grade }}」以确认</div>
          <el-input v-model="purgeConfirm" :placeholder="String(gradeInfo?.grade || '')" />
          <div class="micro">输入不一致时「确认删除」按钮保持不可点</div>
        </div>
      </div>
      <template #footer>
        <div class="cd-foot">
          <span class="micro">由 {{ auth.admin?.nickname || auth.admin?.username }} 执行 · 会写入操作日志</span>
          <div class="cd-foot-right">
            <el-button @click="purgeVisible = false">取消</el-button>
            <el-button
              class="cd-danger"
              :disabled="purgeConfirm.trim() !== String(gradeInfo?.grade)"
              :loading="cleaning"
              @click="doCleanup('purge')"
            >确认删除 {{ gradeInfo?.total }} 个账号</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- ══════════ 停用账号清单 ══════════ -->
    <el-dialog v-model="disabledVisible" width="520px" title="被停用的账号" top="12vh">
      <el-table :data="(receipt?.disabledAccounts || [])" max-height="380">
        <el-table-column label="账号" prop="username" width="130">
          <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
        </el-table-column>
        <el-table-column label="姓名" prop="name" width="110" />
        <el-table-column label="班级" prop="className" min-width="140" />
      </el-table>
      <template #footer>
        <el-button @click="disabledVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 改名 / 批量重置密码 ══════════ -->
    <el-dialog v-model="renameVisible" width="420px" title="修改姓名">
      <div class="micro" style="margin:-4px 0 10px">
        账号 <span class="mono">{{ renameRow?.username || '—' }}</span> ·
        {{ renameRow?.className || '未分班' }} —— 保存后学生端「我的」页也会同步显示新名字。
      </div>
      <el-input v-model="renameValue" placeholder="学生姓名" maxlength="64" @keyup.enter="submitRename" />
      <template #footer>
        <el-button @click="renameVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRename">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resetPasswordBatchVisible" width="460px" title="批量重置密码">
      <div class="micro" style="margin-bottom:10px;line-height:1.7">
        把当前筛选范围（{{ listQuery.grade ? listQuery.grade + ' 级' : '全部年级' }}{{ listQuery.classNo ? ' · ' + listQuery.classNo + ' 班' : '' }}）
        的密码打回初始密码 <b>user + 学号</b>；已改过密码的账号也会被重置。
      </div>
      <el-input v-model="resetScopeConfirm" placeholder="输入 RESET 以确认" />
      <template #footer>
        <el-button @click="resetPasswordBatchVisible = false">取消</el-button>
        <el-button type="danger" :disabled="resetScopeConfirm !== 'RESET'" :loading="resetting" @click="submitResetBatch">
          确认重置
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { useAuthStore } from '@/stores/auth';
import { setPageHeader, clearPageHeader, setRefreshHandler, clearRefreshHandler } from '@/utils/pageHeader';
import { IconSearch, IconUpload, IconRefresh, IconInfo } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';

const auth = useAuthStore();
const fmt = (t) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '—');
const pct = (g) => (g.total ? `${Math.round((g.activated / g.total) * 100)}%` : '0%');

const tabs = [
  { k: 'list', label: '账号列表' },
  { k: 'import', label: '批量导入' },
  { k: 'batches', label: '导入批次' },
  { k: 'grades', label: '按年级' },
];
const tab = ref('grades');

/* ── 深色条里的运维事实 ── */
const switchState = reactive({ accountLoginRequired: true });
async function loadSwitchState() {
  try {
    const d = await http.get('/admin/switch/list');
    const arr = Array.isArray(d) ? d : (d?.list || []);
    const item = arr.find((x) => x.key === 'account_login_required');
    if (item) switchState.accountLoginRequired = !!item.value;
  } catch { /* 静默 */ }
}

/* ── 按年级 ── */
const gradeList = ref([]);
const overall = reactive({ total: 0, activated: 0, disabled: 0 });
const gradeInfo = ref(null);
const receipt = ref(null);
const lastReceipt = ref(null);

/** 建议清理的那一届 = 还在校的最早一届 */
const cleanableGrade = computed(() => {
  const withAccounts = gradeList.value.filter((g) => g.total > 0);
  if (!withAccounts.length) return '';
  return withAccounts.reduce((min, g) => (String(g.grade) < String(min.grade) ? g : min), withAccounts[0]).grade;
});
const isCleanable = (g) => String(g.grade) === String(cleanableGrade.value);

/* ── v8 按年级屏：说明条 / KPI 用的派生数据 ── */
const rulesVisible = ref(false);
const cleanableWithSubmit = ref(0);      // 可毕业届里「有投稿记录」的人数（决定删 or 停用）
const lastImportAt = computed(() => {
  const ts = gradeList.value.map((g) => g.lastImportAt).filter(Boolean);
  return ts.length ? ts.sort().slice(-1)[0] : null;
});
const totalClassCount = computed(() => gradeList.value.reduce((s, g) => s + (g.classCount || 0), 0));
const gradeNamesText = computed(() => {
  const names = gradeList.value.map((g) => String(g.grade)).sort();
  if (!names.length) return '暂无年级';
  return `${names[0]} ~ ${names[names.length - 1]} 共 ${names.length} 届`;
});
const activatedPct = computed(() => {
  const t = overall.total || 0;
  if (!t) return 0;
  return Math.round(((overall.activated || 0) / t) * 100);
});

async function loadGrades() {
  const d = await http.get('/admin/student/grades');
  gradeList.value = d.list || [];
  Object.assign(overall, {
    total: d.overall?.total ?? gradeList.value.reduce((s, g) => s + g.total, 0),
    activated: d.overall?.activated ?? gradeList.value.reduce((s, g) => s + g.activated, 0),
    disabled: d.overall?.disabled ?? gradeList.value.reduce((s, g) => s + g.disabled, 0),
  });
  try { lastReceipt.value = await http.get('/admin/student/cleanup/last'); } catch { /* 静默 */ }
  // 深色卡上的「有投稿记录」：只有这一届需要，单独取一次明细
  cleanableWithSubmit.value = 0;
  if (cleanableGrade.value) {
    try {
      const info = await http.get(`/admin/student/grade/${cleanableGrade.value}`);
      cleanableWithSubmit.value = info.withSubmit ?? 0;
    } catch { /* 静默 */ }
  }

  // 顶栏副标题（v8 Topbar）：年级数 / 账号数 / 哪一届可以清理
  setPageHeader({
    title: '学生账号 · 按年级',
    subtitle: `${gradeList.value.length} 个年级 · 共 ${overall.total} 个账号`
      + (cleanableGrade.value ? ` · ${cleanableGrade.value} 级可以毕业清理` : ''),
  });
}

/** 深色卡上的「毕业清理」：先取明细（试算），再开弹窗 */
async function startCleanup(grade) {
  await openGrade(grade);
  openCleanup();
}

async function openGrade(grade) {
  gradeInfo.value = await http.get(`/admin/student/grade/${grade}`);
  tab.value = 'grades';
}

async function loadReceipt(grade) {
  const d = await http.get('/admin/student/cleanup/last', { params: { grade } });
  if (!d) return ElMessage.info('这一届还没有清理回执');
  await showReceipt(d);
}

async function showReceipt(d) {
  if (!gradeList.value.length) await loadGrades();
  receipt.value = d;
  tab.value = 'receipt';
}

/* ── 清理 ── */
const cleanVisible = ref(false);
const purgeVisible = ref(false);
const purgeConfirm = ref('');
const disabledVisible = ref(false);
const cleaning = ref(false);

function openCleanup() {
  purgeConfirm.value = '';
  cleanVisible.value = true;
}

async function doCleanup(mode) {
  if (!gradeInfo.value) return;
  cleaning.value = true;
  try {
    const payload = mode === 'purge' ? { mode, confirm: purgeConfirm.value.trim() } : { mode };
    const d = await http.delete(`/admin/student/grade/${gradeInfo.value.grade}`, { data: payload });
    cleanVisible.value = false;
    purgeVisible.value = false;
    gradeInfo.value = null;
    await loadGrades();
    if (d?.receipt) {
      receipt.value = d.receipt;
      tab.value = 'receipt';
    }
    ElMessage.success(
      mode === 'disable'
        ? `已停用 ${d.disabled} 个账号`
        : `已删除 ${d.deleted} 个账号${d.disabled ? `，停用 ${d.disabled} 个` : ''}`
    );
  } finally {
    cleaning.value = false;
  }
}

/** 导出清理回执 CSV（前端生成） */
function exportReceipt() {
  const r = receipt.value;
  if (!r) return;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['清理回执', r.gradeName || r.grade],
    ['执行时间', fmt(r.createTime)],
    ['操作人', r.operatorName || ''],
    ['模式', r.mode],
    ['负责总数', r.total],
    ['真正删除', r.deleted],
    ['改为停用', r.disabled],
    ['涉及班级', r.classCount || 0],
    ['不受影响', r.untouched || 0],
    ['耗时', r.costText || ''],
    [],
    ['停用账号', '姓名', '班级'],
    ...(r.disabledAccounts || []).map((a) => [a.username, a.name, a.className]),
  ];
  const csv = '\uFEFF' + rows.map((line) => line.map(esc).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `清理回执_${r.gradeName || r.grade}_${dayjs(r.createTime).format('YYYYMMDD-HHmm')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success('已导出清理回执');
}

/* ── 账号列表 ── */
const listRows = ref([]);
const listTotal = ref(0);
const listLoading = ref(false);
const listTableRef = ref(null);

/* ── 批量选择（v8：勾选后底部浮出批量条；权限边界里没有批量删除） ── */
const selected = ref([]);
const batchBusy = ref(false);
function clearSelection() {
  selected.value = [];
  listTableRef.value?.clearSelection?.();
}

async function batchResetPwd() {
  const n = selected.value.length;
  await ElMessageBox.confirm(
    `把选中的 ${n} 个账号重置为各自的初始密码（user + 学号）？重置后他们当前的登录态会立即失效。`,
    '批量重置为初始密码',
    { type: 'warning', confirmButtonText: '重置' },
  );
  batchBusy.value = true;
  try {
    const d = await http.post('/admin/student/reset-password/batch', { ids: selected.value.map((r) => r.id) });
    ElMessage.success(`已重置 ${d?.affected ?? n} 个账号为初始密码`);
    clearSelection();
    await fetchStudents();
  } finally { batchBusy.value = false; }
}

/** 批量删除（超管 · 不可逆）：有投稿记录的会转为「停用」，不会硬删 */
async function batchRemove() {
  const n = selected.value.length;
  await ElMessageBox.confirm(
    `删除选中的 ${n} 个账号？没有投稿记录的会真删（不可恢复），有投稿记录的会自动改为「停用」，`
      + '相关的投稿记录仍留在审核列表里。',
    '批量删除',
    { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' },
  );
  batchBusy.value = true;
  try {
    const d = await http.post('/admin/student/delete/batch', { ids: selected.value.map((r) => r.id) });
    ElMessage.success(`已处理 ${d.total} 个：删除 ${d.deleted} 个、转为停用 ${d.disabled} 个`
      + (d.failed?.length ? `，${d.failed.length} 个失败` : ''));
    clearSelection();
    await Promise.all([fetchStudents(), loadGrades()]);
  } finally { batchBusy.value = false; }
}

async function batchDisable() {  const n = selected.value.length;
  await ElMessageBox.confirm(
    `停用选中的 ${n} 个账号？他们立刻登不进来，但账号与历史投稿都还在（可再启用）。`,
    '批量停用',
    { type: 'warning', confirmButtonText: '停用' },
  );
  batchBusy.value = true;
  try {
    const ids = selected.value.map((r) => r.id);
    const rs = await Promise.allSettled(ids.map((id) => http.put(`/admin/student/${id}/status`, { status: 0 })));
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    if (ok === ids.length) ElMessage.success(`已停用 ${ok} 个账号`);
    else ElMessage.warning(`已停用 ${ok} 个，${ids.length - ok} 个失败，请重试`);
    clearSelection();
    await fetchStudents();
  } finally { batchBusy.value = false; }
}
const listQuery = reactive({ page: 1, pageSize: 10, keyword: '', grade: '', classNo: '', state: '' });
const gradeOptions = computed(() => gradeList.value.filter((g) => g.total > 0).map((g) => g.grade));
const classOptions = computed(() => {
  const set = new Set();
  (gradeInfo.value?.classes || []).forEach((c) => c.classNo && set.add(c.classNo));
  return [...set].sort();
});

async function fetchStudents() {
  listLoading.value = true;
  try {
    // 后端支持的是 status(0/1) 与 activated(0/1)，前端这个下拉合成了一步
    const { state, ...rest } = listQuery;
    const params = { ...rest };
    if (state === 'activated') params.activated = 1;
    else if (state === 'inactive') params.activated = 0;
    else if (state === 'disabled') params.status = 0;
    Object.keys(params).forEach((k) => { if (params[k] === '' || params[k] == null) delete params[k]; });
    const d = await http.get('/admin/student/list', { params });
    listRows.value = d.list || [];
    listTotal.value = d.total || 0;
  } finally { listLoading.value = false; }
}
function searchStudents() { listQuery.page = 1; fetchStudents(); }

async function exportStudents() {
  const params = { ...listQuery };
  delete params.page; delete params.pageSize;
  Object.keys(params).forEach((k) => { if (params[k] === '') delete params[k]; });
  const blob = await http.get('/admin/student/export', { params, responseType: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `学生账号_${dayjs().format('YYYYMMDD-HHmm')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('已导出（含初始密码列）');
}

/** 年级详情里的「导出本届 xlsx」 */
function exportGradeList() {
  listQuery.grade = gradeInfo.value?.grade || '';
  listQuery.classNo = '';
  exportStudents();
}

const renameVisible = ref(false);
const renameValue = ref('');
const renameRow = ref(null);
function openRename(row) {
  renameRow.value = row;
  renameValue.value = row.name || row.remark || '';
  renameVisible.value = true;
}
async function submitRename() {
  const name = String(renameValue.value || '').trim();
  if (!name) return ElMessage.warning('姓名不能为空');
  if (name === String(renameRow.value?.name || '').trim()) {
    renameVisible.value = false;
    return ElMessage.info('姓名没有变化');
  }
  try {
    // ⚠️ 字段名必须是 name：后端 updateStudent 读的是 payload.name，
    // 并会把它同时写进 remark（管理端列表）和 nickname（投稿/留言/小程序）。
    // 以前这里发的是 { remark, nickname }，后端认不出来 → 接口回 200 但一个字没改。
    await http.put(`/admin/student/${renameRow.value.id}`, { name });
    ElMessage.success('姓名已更新，学生端同步生效');
    renameVisible.value = false;
    fetchStudents();
  } catch (e) {
    // http 拦截器对业务错误不会弹提示（只 reject），这里必须自己说人话
    ElMessage.error(e?.message || '保存失败');
  }
}
async function resetPassword(row) {
  const d = await http.put(`/admin/student/${row.id}/reset-password`);
  await ElMessageBox.alert(`新密码：${d.initPassword}（= user + 学号）；学生下次登录必须改密。`, '已重置', { confirmButtonText: '知道了' });
  fetchStudents();
}
async function toggleStatus(row) {
  const next = row.status === 1 ? 0 : 1;
  await ElMessageBox.confirm(
    next === 0 ? '停用后该学生立即无法登录（旧 token 下一次请求失效）。' : '启用后该学生可以正常登录。',
    next === 0 ? '停用账号' : '启用账号',
    { type: 'warning' }
  );
  await http.put(`/admin/student/${row.id}/status`, { status: next });
  ElMessage.success(next === 0 ? '已停用' : '已启用');
  fetchStudents();
}

const resetPasswordBatchVisible = ref(false);
const resetScopeConfirm = ref('');
const resetting = ref(false);
async function submitResetBatch() {
  resetting.value = true;
  try {
    const d = await http.put('/admin/student/reset-password', {
      grade: listQuery.grade || undefined,
      classNo: listQuery.classNo || undefined,
    });
    const n = d?.count ?? d?.usernames?.length ?? 0;
    ElMessage.success(`已重置 ${n} 个账号的密码`);
    resetPasswordBatchVisible.value = false;
    resetScopeConfirm.value = '';
    fetchStudents();
  } finally { resetting.value = false; }
}

/* ── 批量导入 ── */
const fileInput = ref(null);
const importPreview = ref(null);
const importResult = ref(null);
const importing = ref(false);
const impForce = ref(false);
const impStrict = ref(true);
const lastFile = ref(null);   // 「强制覆盖已激活」切换后要拿同一个文件重新 preview
const importRows = computed(() => importPreview.value?.rows || []);

/* 可写入行数 = 新建 + 覆盖（summary 字段任何一项缺失都兜底为 0，杜绝「确认导入 NaN 个账号」） */
const importableCountOf = (s) => (Number(s?.new) || 0) + (Number(s?.update) || 0);
const importableCount = computed(() => importableCountOf(importPreview.value?.summary));

/* 步骤条：③ 完成在拿到回执时点亮 */
const stepNo = computed(() => (importResult.value ? 3 : importPreview.value ? 2 : 1));

/* v8 四类结论（后端 state：new / update / active / invalid —— 注意是 new 不是 create） */
const CONCL = {
  new:     { text: '新建',   type: 'success' },
  update:  { text: '覆盖',   type: 'warning' },
  active:  { text: '受保护', type: 'info' },
  invalid: { text: '异常',   type: 'danger' },
};

/* 表格原内容：原始单元格拼接（v8「2024级 · 1班 · 1号」一列） */
const rawText = (row) => (Array.isArray(row.raw) ? row.raw.filter((x) => x !== '' && x != null).join(' · ') : (row.raw || '—'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* 说明列：按 v8 文案；invalid 用后端给的具体原因 */
function explain(row) {
  if (row.state === 'invalid') return esc(row.error || '解析失败');
  if (row.state === 'new') {
    return row.name ? `将创建账号，初始密码 <b>user${row.username}</b>` : '将创建账号';
  }
  if (row.state === 'update') return '账号已存在且未激活 → 覆盖备注，<b>不动密码</b>';
  if (row.state === 'active') return '该账号<b>已激活</b>（改过密码/有投稿），默认跳过；要覆盖需打开下面的开关';
  return row.error || '—';
}

const importRowClass = ({ row }) => (row.state === 'invalid' ? 'row-invalid' : '');

function resetImport() {
  importPreview.value = null;
  importResult.value = null;
  lastFile.value = null;
  if (fileInput.value) fileInput.value.value = '';
}

async function onPick(e) {
  const file = e.target.files?.[0];
  if (file) { lastFile.value = file; await doPreview(file); }
}
async function onDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) { lastFile.value = file; await doPreview(file); }
}

/* 「强制覆盖已激活」开关会影响 new/update/active 的判定 —— 切换后用同一文件重新 preview */
async function repreview() {
  if (!lastFile.value) return;
  await doPreview(lastFile.value);
}

async function doPreview(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const d = await http.post(`/admin/student/import/preview?force=${impForce.value ? 1 : 0}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    importPreview.value = d;
    importResult.value = null;
    ElMessage.success(`解析完成：可导入 ${importableCountOf(d.summary)} 行，异常 ${d.summary?.invalid || 0} 行`);
  } catch { /* 拦截器已提示 */ }
}

async function confirmImport(strict = true) {
  if (!importPreview.value) return;
  importing.value = true;
  try {
    const d = await http.post('/admin/student/import/commit', {
      rows: importPreview.value.rawRows,
      filename: importPreview.value.filename,
      force: impForce.value,
      strict,
    });
    importResult.value = d;
    importPreview.value = null;
    ElMessage.success('导入完成');
    await Promise.all([loadGrades(), fetchBatches()]);
  } finally { importing.value = false; }
}

async function downloadTemplate() {
  const blob = await http.get('/admin/student/template', { responseType: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '学生名册模板.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

/* ── 批次 ── */
const batchRows = ref([]);
const batchLoading = ref(false);
async function fetchBatches() {
  batchLoading.value = true;
  try {
    const d = await http.get('/admin/student/batches');
    batchRows.value = d.list || [];
  } finally { batchLoading.value = false; }
}
async function rollbackBatch(row) {
  await ElMessageBox.confirm('撤销只删除本次新建且没有投稿记录的账号；有投稿记录的会改为停用。', '撤销批次', { type: 'warning' });
  const d = await http.post(`/admin/student/batch/${row.id}/rollback`);
  ElMessage.success(`已撤销：删除 ${d?.deleted ?? 0} 个，停用 ${d?.disabled ?? 0} 个`);
  fetchBatches();
  loadGrades();
}

function switchTab(k) {
  tab.value = k;
  if (k === 'list') fetchStudents();
  if (k === 'batches') fetchBatches();
  if (k === 'grades') { gradeInfo.value = null; loadGrades(); }
}

async function refreshPage() {
  await Promise.all([loadGrades(), loadSwitchState()]);
  await fetchStudents();
}

onMounted(async () => {
  setRefreshHandler(refreshPage);
  await refreshPage();
});
onBeforeUnmount(() => {
  clearRefreshHandler(refreshPage);
  clearPageHeader();
});
</script>

<style scoped>
.stu-page { display: flex; flex-direction: column; gap: 16px; }

/* ── 模块内子导航 ── */
.subtabs {
  display: inline-flex; gap: 4px; padding: 4px; align-self: flex-start;
  background: var(--parchment); border-radius: var(--r-pill);
}
.subtab {
  border: none; background: transparent; cursor: pointer;
  height: 30px; padding: 0 16px; border-radius: var(--r-pill);
  font-size: var(--fs-md); font-family: inherit; color: var(--muted);
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.subtab:hover { color: var(--ink); }
.subtab.on { background: var(--canvas); color: var(--ink); font-weight: 600; }

/* ── 深色运维条 ── */
.dark-strip {
  background: var(--tile); color: #fff;
  border-radius: 14px; padding: 13px 18px;
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  font-size: var(--fs-sm);
}
.ds-item { display: inline-flex; align-items: center; gap: 8px; color: rgba(255, 255, 255, 0.86); }
.ds-item b { color: #fff; }
.ds-sep { width: 1px; height: 14px; background: rgba(255, 255, 255, 0.18); }
.ds-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--live); box-shadow: 0 0 0 3px rgba(255, 69, 58, 0.22); }
.ds-right { margin-left: auto; color: rgba(255, 255, 255, 0.55) !important; }

/* ── 工具栏 ── */
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.tb-right { margin-left: auto; display: flex; gap: 8px; }
.pager { margin-top: 16px; justify-content: flex-end; }
.op-cell { display: inline-flex; gap: 6px; justify-content: flex-end; }
.op-cell :deep(.el-button) { margin-left: 0; }
.mono { font-family: var(--mono); font-size: var(--fs-sm); color: var(--ink-2); }
.c-time { font-variant-numeric: tabular-nums; font-size: var(--fs-sm); color: var(--ink-2); }

/* ── 统计胶囊卡 ── */
.pill-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.pill-stat {
  background: var(--parchment); border-radius: 14px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 2px;
}
.ps-num { font-size: var(--fs-num); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.ps-label { font-size: var(--fs-sm); color: var(--muted); }

/* ── 年级区 ── */
.grade-section { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.grade-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.grade-card {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  padding: 16px 18px;
  display: flex; flex-direction: column; gap: 12px;
}
/* v8：该清理的那一届用深色卡（整屏唯一一张） */
.grade-card.tile { background: var(--tile); border-color: var(--tile); color: #fff; }
.grade-card.cleaned { background: var(--parchment); border-color: transparent; }
.gc-head { display: flex; align-items: center; justify-content: space-between; }
.gc-name { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.grade-card.tile .gc-name { color: #fff; }
.gc-tag {
  font-size: var(--fs-xs); padding: 2px 9px; border-radius: var(--r-pill);
  background: var(--divider); color: var(--muted-2);
}
.grade-card.tile .gc-tag { background: rgba(255, 255, 255, 0.16); color: #fff; }
.gc-nums { display: flex; gap: 26px; }
.gc-nums div { display: flex; align-items: baseline; gap: 5px; }
.gc-nums span { font-size: var(--fs-2xl); font-weight: 600; color: var(--ink); }
.grade-card.tile .gc-nums span { color: #fff; }
.gc-nums em { font-style: normal; font-size: var(--fs-xs); color: var(--muted); }
.grade-card.tile .gc-nums em { color: rgba(255, 255, 255, 0.62); }
.gc-empty { font-size: var(--fs-sm); color: var(--muted); }
.gc-bar { height: 5px; border-radius: 3px; background: var(--divider); overflow: hidden; }
.gc-bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.grade-card.tile .gc-bar { background: rgba(255, 255, 255, 0.18); }
.grade-card.tile .gc-bar i { background: var(--accent-dark); }
.gc-foot { display: flex; align-items: center; justify-content: space-between; }
.gc-link { font-size: var(--fs-sm); color: var(--accent); cursor: pointer; font-weight: 600; }
.grade-card.tile .gc-link { color: var(--accent-dark); }
.gc-link:hover { text-decoration: underline; }

.back-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.back-link { font-size: var(--fs-md); font-weight: 600; color: var(--accent); cursor: pointer; }
.back-link:hover { text-decoration: underline; }
.grade-pills { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.gp {
  border: 1px solid var(--hairline); background: var(--canvas); cursor: pointer;
  height: 30px; padding: 0 14px; border-radius: var(--r-pill);
  font-size: var(--fs-sm); font-family: inherit; color: var(--ink-2);
}
.gp:hover { border-color: var(--soft); }
.gp.on { background: var(--ink); border-color: var(--ink); color: #fff; font-weight: 600; }
.gp em { font-style: normal; opacity: 0.7; margin-left: 4px; }

/* ── 危险区（毕业清理） ── */
.danger-zone {
  display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;
  background: var(--canvas); border: 1px solid #f0c4c0; border-radius: var(--r-card);
  padding: 18px 20px;
}
.dz-title { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); }
.dz-sub { margin-top: 6px; font-size: var(--fs-sm); color: var(--muted); max-width: 620px; line-height: 1.6; }
.dz-sub b { color: var(--ink-2); }
.dz-right { display: flex; gap: 10px; }
.dz-danger { background: var(--red-fg) !important; border-color: var(--red-fg) !important; color: #fff !important; }
.dz-danger:hover { background: #9a1d14 !important; border-color: #9a1d14 !important; }

/* ── 深色回执卡 ── */
.dark-card {
  background: var(--tile); color: #fff;
  border-radius: var(--r-card); padding: 20px 22px;
  display: flex; flex-direction: column; gap: 10px;
}
.dc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dc-eyebrow { font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.62); letter-spacing: var(--ls-wide-sm); }
.dc-title { font-size: var(--fs-3xl); font-weight: 600; letter-spacing: var(--ls-tight); margin-top: 6px; }
.dc-sub { margin-top: 8px; font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.78); }
.dc-actions { display: flex; gap: 8px; }
.dc-note { font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.78); line-height: 1.6; }
.dc-note b { color: #fff; }

.card-head-line { display: flex; align-items: baseline; justify-content: space-between; }

.detail-rows { display: flex; flex-direction: column; }
.dr { display: flex; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--divider); }
.dr:last-child { border-bottom: none; }
.dr-k { width: 84px; flex-shrink: 0; font-size: var(--fs-sm); color: var(--muted); }
.dr-v { flex: 1; min-width: 0; font-size: var(--fs-md); color: var(--ink-2); line-height: 1.7; }
.dr-v b { color: var(--ink); font-size: var(--fs-xl); }
.dr-list { margin-left: 10px; color: var(--muted); font-size: var(--fs-sm); }

.note-card {
  background: var(--parchment); border-radius: 14px; padding: 14px 18px;
  font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.7;
}
.note-card b { color: var(--ink); }

/* ── 导入（v8 屏「批量导入 · 预览」） ── */
.import-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.ii-list { margin: 10px 0 0; padding-left: 18px; font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.9; }
.ii-list b { color: var(--ink); }
.drop-zone {
  margin-top: 18px; padding: 36px 20px;
  border: 1px dashed var(--soft); border-radius: var(--r-card);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  color: var(--muted); cursor: pointer;
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}
.drop-zone:hover { border-color: var(--accent); background: var(--parchment); }
.dz-title { font-size: var(--fs-md); color: var(--ink-2); font-weight: 600; }

/* 标题区（v8 data-title / data-sub） */
.im-head { display: flex; align-items: flex-end; justify-content: space-between; padding: 0 4px; }
.im-title { font-size: var(--fs-2xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.im-sub { margin-top: 4px; }

/* 步骤条：① 上传 › ② 预览与确认 › ③ 完成 */
.step-card :deep(.el-card__body) { padding: 14px 20px !important; }
.stepper { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; }
.st-it { display: inline-flex; align-items: center; gap: 8px; }
.st-no {
  width: 23px; height: 23px; border-radius: var(--r-pill);
  display: inline-flex; align-items: center; justify-content: center;
  background: #ebebee; color: var(--muted);
  font-size: var(--fs-xs); font-weight: 600; line-height: 1;
}
.st-no.on { background: var(--ink); color: #fff; }
.st-note { margin-left: auto; }

/* 统计条：四类结论各一个标签，看统计条就知道能不能导 */
.sum-card :deep(.el-card__body) { padding: 16px 20px !important; }
.sum-bar { display: flex; align-items: center; gap: 26px; flex-wrap: wrap; }
.sum-it { display: inline-flex; align-items: center; gap: 8px; }
.sum-it b { font-size: var(--fs-xl); color: var(--ink); }

/* 异常行红底（v8：background #fffafa） */
:deep(.row-invalid > td) { background: #fffafa !important; }
.im-err { color: var(--red-fg); }
.im-rowno { font-size: var(--fs-sm); color: var(--muted); }
.im-raw { font-size: var(--fs-sm); color: var(--muted); }
.explain-cell :deep(b), .explain-cell b { color: var(--ink); }

/* 底部：左开关 / 右警示 + 按钮组 */
.im-cols { display: flex; gap: 16px; align-items: stretch; }
.im-switches { flex: 1.3; }
.im-switches :deep(.el-card__body) { padding: 16px 20px !important; display: flex; flex-direction: column; gap: 16px; }
.sw-row { display: flex; align-items: flex-start; gap: 13px; }
.sw-txt { flex: 1; }
.sw-name { font-size: var(--fs-md); font-weight: 600; color: var(--ink); margin-bottom: 3px; }
.im-right { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.im-warnline {
  background: var(--red-bg); color: var(--red-fg);
  border-radius: 12px; padding: 12px 14px;
  display: flex; align-items: flex-start; gap: 8px;
  font-size: var(--fs-sm); line-height: 1.6;
}
.im-warnline b { color: var(--red-fg); }
.im-btns { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: auto; }

/* ── 弹窗 ── */
.cd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.cd-title { font-size: var(--fs-2xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.cd-sub { margin-top: 5px; font-size: var(--fs-sm); color: var(--muted); }
.cd-tag { font-size: var(--fs-xs); padding: 3px 10px; border-radius: var(--r-pill); background: var(--red-bg); color: var(--red-fg); font-weight: 600; white-space: nowrap; }
.cd-body { display: flex; flex-direction: column; gap: 16px; }
.cd-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.cd-stat {
  background: var(--parchment); border-radius: 14px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 2px;
}
.cd-stat--danger { background: var(--red-bg); }
.cs-num { font-size: var(--fs-3xl); font-weight: 600; color: var(--ink); }
.cd-stat--danger .cs-num { color: var(--red-fg); }
.cs-label { font-size: var(--fs-sm); color: var(--ink-2); font-weight: 600; }
.cs-note { font-size: var(--fs-xs); color: var(--muted); }
.cd-rows { display: flex; flex-direction: column; }
.cd-warn {
  background: var(--red-bg); color: var(--red-fg);
  border-radius: 12px; padding: 12px 14px; font-size: var(--fs-sm); line-height: 1.6;
}
.cd-more { text-align: right; }
.cd-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.cd-foot-right { display: flex; gap: 8px; }
.cd-danger { background: var(--red-fg) !important; border-color: var(--red-fg) !important; color: #fff !important; }
.cd-danger:hover:not(.is-disabled):not([disabled]) { background: #9a1d14 !important; border-color: #9a1d14 !important; }
.cd-danger.is-disabled, .cd-danger[disabled] { background: #e3a9a4 !important; border-color: #e3a9a4 !important; color: #fff !important; }

.purge-input { display: flex; flex-direction: column; gap: 8px; }
.pi-label { font-size: var(--fs-sm); color: var(--muted); }
/* ══════════════════════════════════════════════════════════
   v8 按年级屏（照 preview/admin-ui-v8 的参考实现落地）
   深色说明条 + KPI 行 + 年级卡片组
   ══════════════════════════════════════════════════════════ */
.grow { flex: 1; min-width: 0; }

.tile-strip {
  display: flex;
  align-items: center;
  gap: 26px;
  background: var(--tile);
  border-radius: var(--r-tile);
  padding: 18px 24px;
  color: #fff;
}
.tile-strip .t {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: -0.3px;
  line-height: var(--lh-xl);
}
.tile-strip .m {
  font-size: var(--fs-sm);
  color: #ccc;
  letter-spacing: var(--ls-wide);
  margin-top: 3px;
}
.metrics { margin-left: auto; display: flex; gap: 26px; align-items: center; }
.chip {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 13px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: 500;
  color: #ccc;
  background: var(--tile-2);
  letter-spacing: 0.5px;
}
/* 深色条上的白按钮：v8 配方 .btn-white = 纯白底 + 强调蓝字（不能被全局 el-button 规则压成灰底） */
.tile-strip .strip-btn.el-button,
.tile-strip .strip-btn.el-button:hover {
  background: #fff !important;
  background-image: none !important;
  border: none !important;
  color: var(--accent) !important;
  font-weight: 600;
  box-shadow: none !important;
  height: 30px; padding: 0 14px; border-radius: var(--r-pill); font-size: var(--fs-md);
}
.tile-strip .strip-btn.el-button:hover { background: rgba(255, 255, 255, 0.9) !important; }

/* KPI 行：第一格深色 */
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.kpi {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  padding: 16px 18px;
}
.kpi .k { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.kpi .v {
  font-size: var(--fs-3xl);
  font-weight: 600;
  color: var(--ink);
  letter-spacing: var(--ls-tight);
  line-height: var(--lh-3xl);
  margin-top: 4px;
}
.kpi .d { font-size: var(--fs-sm); color: var(--muted); margin-top: 3px; }
.kpi-dark { background: var(--tile); border-color: var(--tile); }
.kpi-dark .k { color: rgba(255, 255, 255, 0.62); }
.kpi-dark .v { color: #fff; }
.kpi-dark .d { color: rgba(255, 255, 255, 0.72); }

.sec { display: flex; flex-direction: column; gap: 13px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title { font-size: var(--fs-xl); font-weight: 600; letter-spacing: var(--ls-tight-sm); line-height: var(--lh-xl); }
.sec-head .sub { font-size: var(--fs-sm); color: var(--muted); }

.cols { display: flex; gap: 18px; align-items: flex-start; }
.cols > * { min-width: 0; flex: 1; }

/* 深色年级卡（本届可毕业清理） */
.g-tile { display: flex; flex-direction: column; gap: 12px; }
.tile-status {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-xs); font-weight: 500; color: #ccc;
  letter-spacing: var(--ls-wide-sm);
}
.dot-live { width: 7px; height: 7px; border-radius: 50%; background: var(--live); flex: none; }
.tile-title {
  font-size: var(--fs-3xl); font-weight: 600; color: #fff;
  letter-spacing: var(--ls-tight); line-height: var(--lh-3xl);
}
.tile-meta { font-size: var(--fs-sm); color: #ccc; letter-spacing: var(--ls-wide); }
.tile-meta.tight { margin-top: -4px; }
.tile-meta b { color: #fff; font-weight: 600; }
.sep-dot { margin: 0 6px; color: rgba(255, 255, 255, 0.4); }
.tile-actions { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
/* 深色卡上两个按钮必须同规格（el-button small 默认只有 24px，会和 ghost 按钮差一截） */
.tile-actions :deep(.el-button) {
  height: 32px;
  padding: 0 14px;
  border-radius: 10px;
  font-size: var(--fs-md);
  line-height: 1;
  background: #fff !important;
  border: none !important;
  color: var(--ink) !important;
  box-shadow: none !important;
}
.tile-actions :deep(.el-button:hover) { background: rgba(255, 255, 255, 0.88) !important; }
.btn-danger-ghost {
  height: 32px; padding: 0 14px; border-radius: 10px; cursor: pointer;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.35);
  color: #fff; font-size: var(--fs-md); font-family: inherit; line-height: 1;
  display: inline-flex; align-items: center;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease);
}
.btn-danger-ghost:hover { background: rgba(255, 69, 58, 0.18); border-color: rgba(255, 69, 58, 0.6); }

/* 进度条：白卡上绿，深色卡上绿 */
.bar { height: 6px; border-radius: var(--r-pill); background: var(--divider); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: var(--r-pill); background: var(--accent); }
.bar.ok i { background: var(--green-fg); }
.tile .bar { background: rgba(255, 255, 255, 0.18); }
.tile .bar.ok i { background: #4ade80; }

/* 白卡（在校届） */
.gcard {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  padding: 18px 20px;
  display: flex; flex-direction: column; gap: 13px;
}
.gcard-h { display: flex; align-items: center; gap: 10px; }
.gcard-h .nm { font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -0.4px; color: var(--ink); }
.gcard-tag {
  margin-left: auto;
  font-size: var(--fs-xs);
  padding: 2px 10px;
  border-radius: var(--r-pill);
  border: 1px solid var(--hairline);
  color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}
.gcard-tag.empty { color: var(--muted); background: var(--parchment); }
.gcard-kv { display: flex; gap: 20px; }
.gcard-kv .k { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.gcard-kv .v {
  font-size: var(--fs-xl); font-weight: 600; line-height: var(--lh-xl);
  margin-top: 2px; letter-spacing: -0.3px; color: var(--ink);
}
.gcard-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: auto; padding-top: 13px;
  border-top: 1px solid var(--divider);
}
.link { color: var(--accent); cursor: pointer; font-size: var(--fs-md); }
.link:hover { text-decoration: underline; }
.sub-link { color: var(--muted); font-size: var(--fs-sm); }
.ml-auto { margin-left: auto; }

/* 清理规则弹窗 */
.rule-list { display: flex; flex-direction: column; gap: 12px; }
.rule-row { display: flex; gap: 14px; }
.rule-k { width: 128px; flex: none; font-size: var(--fs-sm); color: var(--ink); font-weight: 600; }
.rule-v { flex: 1; font-size: var(--fs-md); color: var(--ink-2); line-height: 1.6; }

/* ══════════ 批量操作条（v8 .batchbar：白胶囊、居中、贴在列表底部） ══════════ */
.batchbar {
  position: sticky; bottom: 0; align-self: center; margin-top: 4px;
  display: flex; align-items: center; gap: 10px;
  background: #fff; color: var(--ink);
  border: 1px solid var(--hairline);
  border-radius: var(--r-pill);
  padding: 8px 9px 8px 22px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.10);
  z-index: 12;
}
.batchbar .cnt { font-size: var(--fs-md); font-weight: 500; color: var(--ink-2); margin-right: 8px; }
.batchbar .cnt b { font-size: var(--fs-xl); font-weight: 600; margin: 0 3px; color: var(--accent); }
.bb-hint { margin-right: auto; }
/* v8 .btn-quiet = 白底描边墨字；.btn-plain = 透明底灰字 */
.batchbar .bb-quiet.el-button {
  background: #fff !important; background-image: none !important;
  border: 1px solid var(--hairline) !important; color: var(--ink-2) !important;
  border-radius: var(--r-pill); height: 30px; padding: 0 14px;
}
.batchbar .bb-quiet.el-button:hover { border-color: #cfcfd4 !important; }
.batchbar .bb-plain.el-button {
  background: transparent !important; background-image: none !important;
  border: none !important; color: var(--muted) !important;
  border-radius: var(--r-pill); height: 30px; padding: 0 10px;
}
.batchbar .bb-plain.el-button:hover { color: var(--ink) !important; background: transparent !important; }
/* v8 .btn-danger-quiet = 白底 + 红系描边与红字（批量条里的不可逆动作；实心红 .btn-danger-fill 只留给弹窗确认键） */
.batchbar .bb-danger.el-button {
  background: #fff !important; background-image: none !important;
  border: 1px solid var(--red-bg) !important; color: var(--red-fg) !important;
  border-radius: var(--r-pill); height: 30px; padding: 0 14px; font-weight: 500;
}
.batchbar .bb-danger.el-button:hover { background: #fff5f4 !important; border-color: var(--red-fg) !important; }

</style>
