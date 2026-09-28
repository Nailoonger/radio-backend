<template>
  <div class="song-settings">
    <!-- v8：子页返回入口 -->
    <div class="back-row">
      <a class="back-link" @click="$router.push('/submit')">‹ 返回投稿 & 点歌审核</a>
      <span class="micro">点歌设置 · 点播与审核 / 排期 / 播出安排 / 学生端文案</span>
    </div>

    <!-- ══════════ 一个播出周期（页首总览：先把两条时间轴串起来） ══════════ -->
    <div class="cycle">
      <div class="cy-side">
        <span class="cy-flag a">点播周</span>
        <div class="cy-big">点播 {{ win.windowText || '—' }} <em>· 星期任选，最长可铺满整周</em></div>
        <div class="cy-sub">
          到点停止收新歌，已提交的继续审核。审核截止 <b>{{ win.reviewText || '—' }}</b>。<br>
          到审核截止：自动排期 → 驳回剩余候补 → 锁定本周。
        </div>
      </div>
      <div class="cy-mid">
        <div class="cy-ln" />
        <div class="cy-tag">到点自动排期<br>按首选时段 + 提交时间</div>
        <div class="cy-ln" />
      </div>
      <div class="cy-side cy-right">
        <span class="cy-flag b">播出周</span>
        <div class="cy-big">{{ sched.rangeText || '下一周 周一 ~ 周五' }} <em>· {{ slotTimes.length || 0 }} 场 / 天</em></div>
        <div class="cy-sub">
          {{ slotLegend || '—' }}<br>
          <template v-if="capUnlimited">每格正式位<b>不限</b> —— 本周不设正式位上限</template>
          <template v-else>
            每格 <b>{{ cap.capacity || 0 }}</b> 首正式位，共 <b>{{ cap.weekCapacity || 0 }}</b> 个正式位
          </template>
        </div>
      </div>
    </div>

    <!-- ══════════════════ 组 ① 点播与审核 ══════════════════ -->
    <div class="grp">
      <div class="grp-head">
        <span class="gt">① 点播与审核</span>
        <span class="gd">决定「什么时候能点」和「一个人能点几首」</span>
      </div>

      <!-- 点歌时间窗口 -->
      <div class="cfg">
        <div class="cfg-head">
          <span class="cfg-t">点歌时间窗口</span>
          <span class="pill" :class="auth.isSuperAdmin ? 'pass' : ''">
            {{ auth.isSuperAdmin ? '仅超管可改' : '只读 · 仅超管可改' }}
          </span>
          <span class="sp" v-if="auth.isSuperAdmin">
            <span class="save-state" :class="winDirty ? 'dirty' : 'ok'">
              {{ winDirty ? '有未保存的改动' : '已保存 ✓' }}
            </span>
          </span>
        </div>

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
                <template v-else-if="win.open">开放中 · 距点播截止 {{ fmtDur(winCd?.ms) }}</template>
                <template v-else>未开放 · 距开放 {{ fmtDur(winCd?.ms) }}</template>
              </div>
            </div>
            <div class="win-meta">
              <div>本周点播 {{ hhmm(win.start) }} → {{ hhmm(win.end) }}</div>
              <div v-if="win.reviewAt">审核截止 {{ hhmm(win.reviewAt) }}</div>
              <div v-else-if="win.opensAt">下次开放 {{ hhmm(win.opensAt) }}</div>
            </div>
          </div>
          <div class="win-note">
            {{ win.note || '点播截止只停止新提交；到审核截止才自动排期、驳回剩余候补并锁定本周' }}
          </div>
        </div>

        <!-- 编辑区 -->
        <div class="win-form">
          <div class="kv">
            <span class="k">启用窗口限制</span>
            <span class="rowc gap13 wrap">
              <el-switch v-model="winForm.enabled" :active-value="1" :inactive-value="0" :disabled="!auth.isSuperAdmin" />
              <span class="micro">关掉 = 学生任何时间都能提交（容量与候补仍照常生效）</span>
            </span>
          </div>
          <div class="kv">
            <span class="k">点播开始</span>
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
            <span class="k">点播结束</span>
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
          <!-- 审核截止（2026-09-25 与点播截止拆开）：null = 跟随「点播结束 + 偏移」，保住升级前的行为 -->
          <div class="kv">
            <span class="k">审核截止</span>
            <span class="rowc gap8 wrap">
              <!-- 宽度按最长档位「跟随点播结束 + 6 小时」定，158px 会截断成「跟随点播结束 + …」 -->
              <el-select v-model="winForm.reviewDay" style="width:200px" :disabled="winDisabled">
                <el-option :label="followLabel" :value="FOLLOW_REVIEW" />
                <el-option v-for="d in win.allowedDays || []" :key="d.day" :label="d.name" :value="d.day" />
              </el-select>
              <el-time-select
                v-model="winForm.reviewTime" start="00:00" step="00:10" end="23:50"
                placeholder="时刻" style="width:120px"
                :disabled="winDisabled || winForm.reviewDay === FOLLOW_REVIEW"
              />
              <span class="pill green" v-if="win.reviewConfigured">已单独配置</span>
              <span class="micro">到点自动排期 + 驳回剩余候补 + 锁定本周</span>
            </span>
          </div>
        </div>

        <div class="tip">
          <IconInfo :size="14" />
          <span>星期任选 <b>周一 → 周日</b>，最长可铺满整周。审核截止不得早于点播结束、不得晚于<b>播出周周一 00:00</b>。<br>
          注意与下面的「播出时段」区分：<b>这里配的是点播周</b>（学生什么时候能投），<b>播出时段配的是播出周</b>（歌播在哪几天）。</span>
        </div>

        <div class="btns">
          <el-button
            type="primary" size="small"
            :loading="winSaving" :disabled="!auth.isSuperAdmin" @click="saveWindow"
          >
            <IconCheck :size="14" class="btn-icon" />保存窗口
          </el-button>
          <span class="micro" v-if="!auth.isSuperAdmin">只有超级管理员能修改点歌时间窗口（后端 40301 把关）</span>
        </div>
      </div>

      <!-- 提交规则 -->
      <div class="cfg">
        <div class="cfg-head">
          <span class="cfg-t">提交规则</span>
          <span class="pill" :class="auth.isSuperAdmin ? 'pass' : ''">
            {{ auth.isSuperAdmin ? '即时生效 · 仅超管可改' : '只读 · 仅超管可改' }}
          </span>
          <span class="sp" v-if="auth.isSuperAdmin">
            <span class="save-state" :class="rulesDirty ? 'dirty' : 'ok'">
              {{ rulesDirty ? '有未保存的改动' : '已保存 ✓' }}
            </span>
          </span>
        </div>
        <div>
          <div class="kv">
            <span class="k">每人每周上限</span>
            <span class="rowc gap8">
              <el-input-number
                v-model="ruleForm.weeklyUserLimit" :min="0" :max="99"
                size="small" :controls="false" style="width:78px"
              />
              <span class="micro">次 · 填 0 = 不限</span>
            </span>
          </div>
          <div class="kv">
            <span class="k">同曲一周去重</span>
            <span class="rowc gap13">
              <el-switch v-model="ruleForm.dupBlock" :active-value="1" :inactive-value="0" />
              <span class="micro">开：同一首歌一周内只能点一次</span>
            </span>
          </div>
          <div class="kv" style="border-bottom:none">
            <span class="k">生效范围</span>
            <span class="micro">只算点歌（文稿不受影响）；候补中的歌也算占用；因窗口截止被系统驳回的不占个人次数</span>
          </div>
        </div>
        <div class="tip">
          <IconInfo :size="14" />
          <span>改完要点下面的「保存规则」才生效，保存后页面会显示服务端真正生效的值。</span>
        </div>
        <div class="btns">
          <el-button
            type="primary" size="small" :loading="ruleSaving"
            :disabled="!auth.isSuperAdmin" @click="saveRules"
          >
            <IconCheck :size="14" class="btn-icon" />保存规则
          </el-button>
          <span class="micro" v-if="!auth.isSuperAdmin">只读 · 提交规则由超级管理员维护（后端 40301 把关）</span>
        </div>
      </div>

      <!-- 学生被拦下时看到什么（口径已按点播版订正） -->
      <div class="cfg">
        <div class="cfg-head">
          <span class="cfg-t">学生被拦下时看到什么</span>
          <span class="pill">只读</span>
          <span class="sp"><span class="micro">点播版实际会出现的拦截</span></span>
        </div>
        <div class="kv">
          <span class="k">未确认注意事项</span>
          <span class="rowc gap8 wrap">
            <span class="micro">「请先阅读并确认点歌注意事项」</span><span class="pill amber">40303</span>
          </span>
        </div>
        <div class="kv">
          <span class="k">不在点播窗口内</span>
          <span class="rowc gap8 wrap">
            <span class="micro">「现在不在点歌时间段（{{ win.windowText || '周六 18:00 → 周日 18:00' }}）」+ 下次开放时刻（小程序据此显示倒计时）</span>
            <span class="pill amber">40907</span>
          </span>
        </div>
        <div class="kv">
          <span class="k">时段不是系统下发的</span>
          <span class="rowc gap8 wrap">
            <span class="micro">「播出时段只能选下周一到周五内的可选时段，请重新选择」</span>
            <span class="pill amber">40001</span>
          </span>
        </div>
        <div class="kv">
          <span class="k">同曲重复 / 次数用完</span>
          <span class="rowc gap8 wrap">
            <span class="micro">「本周已经有人点过《晴天》了，换一首吧」／「本周点歌次数已用完（每周最多 N 次），下周再来吧」</span>
            <span class="pill amber">40903</span>
          </span>
        </div>
        <div class="kv" style="border-bottom:none">
          <span class="k">一分钟内重复提交</span>
          <span class="rowc gap8 wrap">
            <span class="micro">「请勿重复提交」</span><span class="pill amber">40901</span>
          </span>
        </div>
        <div class="tip">
          <IconInfo :size="14" />
          <span>已移除 <b>40906 时段已排满</b>、<b>40904 时段和候补队列都满了</b>、<b>40902 名额已满</b> ——
          点播版提交时不再判容量，这三个码已无任何生产路径抛出。<br>
          容量相关的自动驳回发生在<b>排期阶段</b>（驳回理由「该播出时段已排满，系统自动驳回」），不在提交那一刻。</span>
        </div>
      </div>
    </div>

    <!-- ══════════════════ 组 ② 排期 ══════════════════ -->
    <div class="grp">
      <div class="grp-head">
        <span class="gt">② 排期</span>
        <span class="gd">审核通过后，谁排上正式位、谁进候补</span>
      </div>

      <div class="cfg">
        <div class="cfg-head">
          <span class="cfg-t">排期容量与候补</span>
          <span class="pill" :class="auth.isSuperAdmin ? 'pass' : ''">
            {{ auth.isSuperAdmin ? '仅超管可改' : '只读 · 仅超管可改' }}
          </span>
          <span class="sp" v-if="auth.isSuperAdmin">
            <span class="save-state" :class="capDirty ? 'dirty' : 'ok'">
              {{ capDirty ? '有未保存的改动' : '已保存 ✓' }}
            </span>
          </span>
        </div>

        <!-- 上半：只读统计（数字全部实时统计，不受下面输入框影响） -->
        <div class="stats">
          <div class="stat">
            <div class="sl">下周正式位总数</div>
            <div class="sv num">
              {{ capUnlimited ? '不限' : (cap.weekCapacity ?? 0) }}
              <small>{{ capUnlimited ? `每格不限 × ${gridCount} 格` : `= ${cap.capacity ?? 0} × ${gridCount} 格` }}</small>
            </div>
          </div>
          <div class="stat">
            <div class="sl">已占位</div>
            <div class="sv num">{{ seatedTotal }} <small>/ {{ capUnlimited ? '不限' : (cap.weekCapacity ?? 0) }}</small></div>
            <div v-if="!capUnlimited" class="bar"><i :style="{ width: pctOf(seatedTotal, cap.weekCapacity) }" /></div>
          </div>
          <div class="stat">
            <div class="sl">候补队列</div>
            <div class="sv num">
              {{ queue.total ?? 0 }}
              <small>/ {{ queueUnlimited ? '不限' : (queue.limit ?? 0) }}<template v-if="queue.limitAuto">（自动）</template></small>
            </div>
            <div class="bar"><i :style="{ width: pctOf(queue.total, queue.limit) }" /></div>
          </div>
          <div class="stat">
            <div class="sl">补位待审（最优先处理）</div>
            <div class="sv num">{{ promotedCount }}</div>
          </div>
        </div>

        <div class="div-line" />

        <!-- 下半：编辑 -->
        <div class="two-col" style="max-width:460px">
          <div>
            <div class="field-label" style="margin-bottom:7px">每格正式位</div>
            <el-input-number v-model="capForm.capacity" :min="0" :max="99" controls-position="right" style="width:100%" />
          </div>
          <div>
            <div class="field-label" style="margin-bottom:7px">候补队列上限</div>
            <el-input-number v-model="capForm.queueLimit" :min="0" :max="999" controls-position="right" style="width:100%" />
          </div>
        </div>

        <div class="tip" style="margin-top:var(--s4)">
          <IconInfo :size="14" />
          <span>每格正式位填 <b>0</b> = 不限；候补上限填 <b>0</b> = 自动（= 下周正式位总数）。<br>
          <b>提交不判容量</b>：谁都能投，一律先进待审核。审核通过只拿到候选资格，到审核截止由系统按「首选时段 + 提交时间」统一排；
          首选时段满了进全局候补（先进先出，跨所有时段），锁定时刻还没排上的才被自动驳回（不占学生周次数）。</span>
        </div>

        <div class="btns">
          <!-- 普通管理员：接口已收超管（40301），这里一并置灰，别让人点了才吃 403 -->
          <el-button
            type="primary" :loading="capSaving" :disabled="!auth.isSuperAdmin"
            @click="saveCapacity"
          >
            <IconCheck :size="15" class="btn-icon" />保存
          </el-button>
          <el-button
            :loading="sweeping" plain :disabled="!auth.isSuperAdmin"
            @click="sweepQueue"
          >
            <IconRefresh :size="15" class="btn-icon" />递补 + 定稿检查
          </el-button>
          <span class="micro" v-if="!auth.isSuperAdmin">只读 · 容量与候补由超级管理员维护（后端 40301 把关）</span>
        </div>
      </div>
    </div>

    <!-- ══════════════════ 组 ③ 播出安排 ══════════════════ -->
    <div class="grp">
      <div class="grp-head">
        <span class="gt">③ 播出安排</span>
        <span class="gd">播在哪几天、哪几场 · 学生端能看到什么</span>
      </div>

      <!-- 播出时段 -->
      <div class="cfg">
        <div class="cfg-head">
          <span class="cfg-t">播出时段</span>
          <span class="pill pass">后台发布</span>
          <span class="sp">
            <span class="micro">用户只能从这儿选 · 当前来源：{{ sourceText }}</span>
            <span class="save-state" :class="slotsDirty ? 'dirty' : 'ok'" v-if="auth.isSuperAdmin">
              {{ slotsDirty ? '有未保存的改动' : '已保存 ✓' }}
            </span>
          </span>
        </div>

        <div class="two-col" style="gap:var(--s5)">
          <!-- 左：编辑区 -->
          <div>
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
                <span class="micro slot-label-hint">标签 · 用户看到的是「{{ slotSample }}」</span>
                <a class="link op-delete" :class="{ disabled: slotTimes.length <= 1 }" @click="removeSlot(i)">删除</a>
              </div>
            </div>
            <div class="btns">
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
          </div>

          <!-- 右：用户预览 -->
          <div>
            <div class="rowc" style="justify-content:space-between;margin-bottom:13px">
              <span class="field-label">
                用户会看到{{ slotConfig ? `（${slotConfig.weekStart} ~ ${slotConfig.weekEnd}）` : '' }}
              </span>
              <span class="micro">与用户端同源</span>
            </div>
            <div class="stack gap13">
              <div v-for="day in weekDays" :key="day" class="rowc gap13 slot-day-row">
                <span class="micro slot-day-label">{{ day }}</span>
                <span class="rowc gap8 wrap">
                  <span v-for="slot in slotTimes" :key="slot.time" class="chip-pick on">
                    {{ slot.label }} {{ slot.time }}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="tip">
          <IconInfo :size="14" />
          <span>可选日期范围固定为<b>下一周的周一 ~ 周五</b>，不在这里改。留空则退回解析「开播时间」设置，再退回默认三个。<br>
          每格能排几首在 <b>② 排期</b> 里设（当前每格 <b>{{ capUnlimited ? '不限' : `${cap.capacity || 0} 首` }}</b>）。</span>
        </div>
      </div>

      <!-- 小程序首页（仅超管，2026-09-21） -->
      <div class="cfg" v-if="auth.isSuperAdmin">
        <div class="cfg-head">
          <span class="cfg-t">小程序首页</span>
          <span class="pill green">即时生效</span>
          <span class="sp"><span class="micro">模块开关 home_song_schedule · 缺行视为开</span></span>
        </div>
        <div class="kv" style="border-bottom:none">
          <span class="k">展示本周点歌排期</span>
          <span class="rowc gap13 wrap">
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

    <!-- ══════════════════ 组 ④ 学生端文案 ══════════════════ -->
    <div class="grp">
      <div class="grp-head">
        <span class="gt">④ 学生端文案</span>
        <span class="gd">两份互相独立，改内容才会让学生重新确认</span>
      </div>

      <div class="two-col" style="gap:var(--s5)">
        <!-- 点歌注意事项 -->
        <div class="cfg">
          <div class="cfg-head">
            <span class="cfg-t">点歌注意事项</span>
            <span class="sp">
              <span class="micro">
                v{{ noticeList[0].version }} · 已确认 <b class="num">{{ noticeList[0].ackedCount }}</b> 人
              </span>
              <span class="save-state" :class="noticeDirty(noticeList[0]) ? 'dirty' : 'ok'" v-if="auth.isSuperAdmin">
                {{ noticeDirty(noticeList[0]) ? '有未保存的改动' : '已保存 ✓' }}
              </span>
            </span>
          </div>
          <el-input
            v-model="noticeList[0].content"
            type="textarea"
            :rows="6"
            placeholder="一行一条，例如：&#10;一、点歌前请确认歌曲名与歌手填写正确。&#10;二、每人每周最多点 2 次。（留空 = 不启用）"
          />
          <div class="tip">
            <IconInfo :size="14" />
            <span>内容有改动才 +1 版本，<b>所有用户需重新确认</b>；只改排版不打扰用户。</span>
          </div>
          <div class="btns">
            <el-button type="primary" size="small" :loading="noticeList[0].saving" @click="saveNotice(noticeList[0])">
              <IconCheck :size="14" class="btn-icon" />保存
            </el-button>
            <el-button size="small">预览用户端</el-button>
          </div>
        </div>

        <!-- 文稿注意事项 -->
        <div class="cfg">
          <div class="cfg-head">
            <span class="cfg-t">文稿注意事项</span>
            <span class="pill pass">与点歌独立</span>
            <span class="sp">
              <span class="micro">
                v{{ noticeList[1].version }} · 已确认 <b class="num">{{ noticeList[1].ackedCount }}</b> 人
              </span>
              <span class="save-state" :class="noticeDirty(noticeList[1]) ? 'dirty' : 'ok'" v-if="auth.isSuperAdmin">
                {{ noticeDirty(noticeList[1]) ? '有未保存的改动' : '已保存 ✓' }}
              </span>
            </span>
          </div>
          <el-input
            v-model="noticeList[1].content"
            type="textarea"
            :rows="6"
            placeholder="一行一条，例如：&#10;一、文稿须为原创，禁止抄袭转载。&#10;二、篇幅 300~1500 字，请勿提交纯图片内容。"
          />
          <div class="tip">
            <IconInfo :size="14" />
            <span>两份内容、版本号、确认记录<b>互相独立</b>：改文稿这份不会让点歌那批人重新确认。</span>
          </div>
          <div class="btns">
            <el-button type="primary" size="small" :loading="noticeList[1].saving" @click="saveNotice(noticeList[1])">
              <IconCheck :size="14" class="btn-icon" />保存
            </el-button>
            <el-button size="small">预览用户端</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════════════ 组 ⑤ 危险区（仅超管） ══════════════════ -->
    <div class="grp danger" v-if="auth.isSuperAdmin">
      <div class="grp-head">
        <span class="gt">⑤ 危险区</span>
        <span class="gd">仅超级管理员 · 服务端 40301 把关</span>
      </div>
      <div class="dangerzone">
        <div class="rowc danger-row">
          <div class="grow">
            <div class="dz-title">一键清空全部点歌数据</div>
            <div class="dz-desc">
              删除<b>全部点歌记录</b>，<b>不可恢复</b>；文稿、注意事项确认记录、学生账号一概不动。<br>
              容量与候补都是<b>实时统计</b>（直接数投稿记录），没有独立的名额计数器，
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
  base.cap = sigCap.value;   // 服务端值落盘 = 此刻没有未保存改动
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
  // null = 「跟随点播结束 + 偏移」档位（升级前的旧行为，保持不变）
  reviewDay: null, reviewTime: '22:00',
});
const winSaving = ref(false);
/** 非超管或未启用窗口 → 表单只读 */
const winDisabled = computed(() => !auth.isSuperAdmin || !Number(winForm.enabled));

/** 审核截止的「跟随点播结束 + 偏移」档位哨兵值。
 *  ⚠️ 不能直接用 null 当 el-option 的 value —— Element Plus 把 null 视为「空值」，
 *  即使存在 value=null 的选项也照样落回 placeholder（实测显示成「请选择」），
 *  管理员就看不出当前到底是不是跟随档。所以线上传 null、UI 里用字符串哨兵。 */
const FOLLOW_REVIEW = '__follow__';

/** 「跟随点播结束 + 偏移」档位的文案：偏移分钟数由服务端下发，前端不硬编码 360 */
const followLabel = computed(() => {
  const m = Number(win.value?.followOffsetMinutes);
  if (!Number.isFinite(m) || m <= 0) return '跟随点播结束';
  const h = m / 60;
  return `跟随点播结束 + ${Number.isInteger(h) ? `${h} 小时` : `${m} 分钟`}`;
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
  //    否则管理员只是改了点播时间、顺手保存，就把「点播结束 + 偏移」固化成具体时刻，行为悄悄变了
  winForm.reviewDay = cfg.reviewDay === null || cfg.reviewDay === undefined ? FOLLOW_REVIEW : Number(cfg.reviewDay);
  winForm.reviewTime = cfg.reviewTime || '22:00';
}
async function fetchWindow() {
  win.value = await http.get('/admin/submit/window');
  fillWinForm(win.value);
  base.win = sigWin.value;
}
async function saveWindow() {
  if (Number(winForm.enabled) && (!winForm.startTime || !winForm.endTime)) {
    ElMessage.warning('请填写点播开始与结束时刻（HH:mm）');
    return;
  }
  if (Number(winForm.enabled) && winForm.reviewDay !== FOLLOW_REVIEW && !winForm.reviewTime) {
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
      // null 是合法档位（跟随点播结束 + 偏移），后端不会当非法值拒掉
      reviewDay: winForm.reviewDay === FOLLOW_REVIEW ? null : Number(winForm.reviewDay),
      reviewTime: winForm.reviewTime || null,
    });
    fillWinForm(win.value);
    base.win = sigWin.value;
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
  base.rules = sigRules.value;
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
    base.rules = sigRules.value;
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

/** 页首周期总览右侧：播出场次一行速览（早间 07:20 · 午间 12:20 · 晚间 18:00） */
const slotLegend = computed(() => (slotTimes.value || [])
  .map((t) => `${t.label || ''} ${t.time || ''}`.trim()).filter(Boolean).join(' · '));

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

/** 标签提示里的样例串：用真实的第一天 + 第一个时段拼 —— 别再写死日期，写死必然过期 */
const slotSample = computed(() => {
  const day = weekDays.value[0] || '周一';
  const t = slotTimes.value[0];
  return t ? `${day} · ${t.label || ''} ${t.time || ''}`.replace(/\s+/g, ' ').trim() : day;
});

async function fetchSlots() {
  // GET 走 /admin/submit/timeslots（/submit/slots 只注册了 PUT，GET 会被 /submit/:id 吃掉）
  slotConfig.value = await http.get('/admin/submit/timeslots');
  slotTimes.value = (slotConfig.value?.times || []).map((t) => ({ time: t.time, label: t.label || '' }));
  base.slots = sigSlots.value;
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
    base.slots = sigSlots.value;
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
  base.noticeSong = noticeList.value[0].content || '';
  base.noticeArticle = noticeList.value[1].content || '';
}
async function saveNotice(nt) {
  nt.saving = true;
  try {
    const data = await http.put('/admin/submit/notice', { content: nt.content, type: nt.type });
    nt.version = data.version;
    nt.ackedCount = data.ackedCount;
    if (nt.type === 'song') base.noticeSong = nt.content || '';
    else base.noticeArticle = nt.content || '';
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

/* ─────────── 保存状态：每卡一份 baseline 快照，一改就变「有未保存的改动」 ───────────
 * 只做「提示」，不做拦截：保存按钮始终可点，不清空管理员的操作习惯。
 * 口径统一为「把表单压成一个顺序固定的字符串再比」，避免对象键序 / undefined 参与比较。
 * ⚠️ baseline 只在「拉取」与「保存成功」两处落盘，别在别处随手改 —— 否则提示会骗人。 */
const base = reactive({
  cap: '', rules: '', win: '', slots: '', noticeSong: '', noticeArticle: '',
});

const sigCap = computed(() => [
  Number(capForm.capacity) || 0, Number(capForm.queueLimit) || 0,
].join('|'));
const sigRules = computed(() => [
  Number(ruleForm.weeklyUserLimit) || 0, Number(ruleForm.dupBlock) ? 1 : 0,
].join('|'));
const sigWin = computed(() => [
  Number(winForm.enabled) ? 1 : 0,
  winForm.startDay, winForm.startTime || '',
  winForm.endDay, winForm.endTime || '',
  winForm.reviewDay === FOLLOW_REVIEW ? 'follow' : winForm.reviewDay,
  winForm.reviewTime || '',
].join('|'));
const sigSlots = computed(() => slotTimes.value
  .map((t) => `${(t.time || '').trim()}/${t.label || ''}`).join('|'));

/** 只对超管显示改动提示（非超管的控件本身是只读的，提示没意义） */
const capDirty = computed(() => auth.isSuperAdmin && sigCap.value !== base.cap);
const rulesDirty = computed(() => auth.isSuperAdmin && sigRules.value !== base.rules);
const winDirty = computed(() => auth.isSuperAdmin && sigWin.value !== base.win);
const slotsDirty = computed(() => auth.isSuperAdmin && sigSlots.value !== base.slots);
const noticeDirty = (nt) => auth.isSuperAdmin
  && String(nt.content || '') !== String(base[nt.type === 'song' ? 'noticeSong' : 'noticeArticle'] ?? '');

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
.rowc { display: flex; align-items: center; }
.wrap { flex-wrap: wrap; }
.stack { display: flex; flex-direction: column; }
.gap8 { gap: 8px; }
.gap13 { gap: 13px; }
.grow { flex: 1; min-width: 0; }

/* 两等分（排期编辑 / 播出时段 / 两份注意事项） */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); }
.two-col > * { min-width: 0; }
@media (max-width: 980px) { .two-col { grid-template-columns: 1fr; } }

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

/* 卡底提示条：羊皮纸一整条，视觉上明确「这段不是给你填的」 */
.tip {
  display: flex; gap: 9px; align-items: flex-start;
  background: var(--parchment);
  border-radius: var(--r-input);
  padding: 11px 14px;
  margin-top: var(--s3);
  font-size: var(--fs-sm);
  color: var(--muted);
  line-height: 1.75;
}
.tip :deep(svg) { flex: none; margin-top: 3px; color: var(--soft); }
.tip b { color: var(--ink-2); font-weight: 600; }

/* 小胶囊：pass / green / amber（与 el-tag 区分，不走 Element 主题） */
.pill {
  display: inline-flex; align-items: center;
  font-size: var(--fs-xs);
  padding: 2px 9px;
  border-radius: var(--r-pill);
  background: var(--parchment);
  color: var(--muted);
  white-space: nowrap;
}
.pill.pass { background: var(--acc-bg); color: var(--accent); }
.pill.green { background: var(--green-bg); color: var(--green-fg); }
.pill.amber { background: var(--amber-bg); color: var(--amber-fg); }

.num { font-variant-numeric: tabular-nums; }
.micro {
  font-size: var(--fs-xs);
  color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}

/* ══════════ 页首：一个播出周期 ══════════ */
.cycle {
  display: flex; align-items: stretch; gap: var(--s4); flex-wrap: wrap;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  padding: var(--s4) var(--s5);
}
.cy-side { flex: 1; min-width: 300px; display: flex; flex-direction: column; gap: 9px; }
.cy-right { text-align: right; align-items: flex-end; }
.cy-flag {
  align-self: flex-start;
  font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: 0.1em;
  padding: 3px 10px;
  border-radius: var(--r-pill);
}
.cy-flag.a { background: var(--acc-bg); color: var(--accent); }
.cy-flag.b { background: var(--tile); color: #fff; }
.cy-right .cy-flag { align-self: flex-end; }
.cy-big { font-size: var(--fs-lg); font-weight: 600; letter-spacing: var(--ls-tight-sm); }
.cy-big em { font-style: normal; color: var(--muted); font-weight: 400; font-size: var(--fs-sm); }
.cy-sub { font-size: var(--fs-sm); color: var(--muted); line-height: 1.75; }
.cy-sub b { color: var(--ink-2); font-weight: 600; }
.cy-mid {
  flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; padding: 0 var(--s2); min-width: 120px;
}
.cy-ln { width: 100%; height: 2px; background: var(--soft); border-radius: 2px; }
.cy-tag { font-size: var(--fs-xs); color: var(--muted-2); text-align: center; line-height: 1.6; }

/* ══════════ 分组标题（竖线 + 人话副标题） ══════════ */
.grp { margin-bottom: var(--s6); }
.grp:last-child { margin-bottom: 0; }
.grp-head {
  display: flex; align-items: flex-end; gap: 11px; flex-wrap: wrap;
  margin-bottom: var(--s3);
  padding-left: 12px;
  border-left: 3px solid var(--ink);
}
.grp-head .gt { font-size: var(--fs-lg); font-weight: 600; }
.grp-head .gd { font-size: var(--fs-sm); color: var(--muted); padding-bottom: 2px; }
.grp.danger .grp-head { border-left-color: var(--red-fg); }
.grp.danger .grp-head .gt { color: var(--red-fg); }

/* ══════════ 配置卡 ══════════ */
.cfg {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  padding: var(--s4) var(--s5);
}
.grp > .cfg:not(:last-child) { margin-bottom: var(--s3); }
.cfg-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-bottom: var(--s4);
}
.cfg-t { font-size: var(--fs-md); font-weight: 600; }
.cfg-head .sp { margin-left: auto; display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }

/* 保存状态（卡头右侧）：绿=已保存，琥珀=有未保存的改动 */
.save-state {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: var(--fs-sm); white-space: nowrap;
}
.save-state.ok { color: var(--green-fg); }
.save-state.dirty { color: var(--amber-fg); }

/* 统计块 */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s3); }
@media (max-width: 980px) { .stats { grid-template-columns: repeat(2, 1fr); } }
.stat { background: var(--parchment); border-radius: var(--r-input); padding: 12px 14px; min-width: 0; }
.stat .sl { font-size: var(--fs-xs); color: var(--muted-2); }
.stat .sv {
  font-size: var(--fs-xl); font-weight: 600; line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.stat .sv small { font-size: var(--fs-sm); font-weight: 400; color: var(--muted); }
.stat .bar { height: 4px; border-radius: 2px; background: #e6e6e9; margin-top: 8px; }
.stat .bar i { background: var(--tile); border-radius: 2px; }
.div-line { height: 1px; background: var(--divider); margin: var(--s4) 0; }

/* 按钮行 */
.btns { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: var(--s4); }

/* ══════════ 点歌时间窗口（深色卡） ══════════ */
/* 表单行包一层：让末行 .kv:last-child 的 border-bottom 能正常去掉 */
.win-form { display: flex; flex-direction: column; }
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

/* ══════════ 播出时段：编辑行 ══════════ */
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
.dangerzone {
  background: var(--canvas);
  border: 1px solid #f0c4c0;
  border-radius: var(--r-card);
  padding: var(--s4) var(--s5);
}
.danger-row { gap: 24px; align-items: flex-start; flex-wrap: wrap; }
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
