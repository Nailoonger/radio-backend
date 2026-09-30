(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const device = byId('device');
  const loginForm = byId('login-form');
  const activateForm = byId('activate-form');
  const successPanel = byId('success-panel');
  const studentId = byId('student-id');
  const loginPassword = byId('login-password');
  const newPassword = byId('new-password');
  const confirmPassword = byId('confirm-password');
  const signalPath = byId('signal-path');
  const signalAvatar = byId('signal-avatar');
  const signalInitial = byId('signal-initial');
  const motionToggle = byId('motion-toggle');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const dialog = byId('help-dialog');
  const timers = new Set();
  const descriptions = new Map();
  const profiles = {
    '20240101': { password: 'user20240101', firstLogin: true, name: '李同学' },
    '20240102': { password: 'Radio2026', firstLogin: false, name: '李同学' },
  };
  const buttonLabels = new Map([
    [byId('login-submit'), byId('login-submit').querySelector('[data-button-label]').textContent],
    [byId('activate-submit'), byId('activate-submit').querySelector('[data-button-label]').textContent],
  ]);
  let stage = 'login';
  let activeProfile = null;
  let activeStudentId = '';
  let busy = false;
  let operation = 0;
  let frame = 0;
  let pulseAt = -Infinity;
  let verificationAt = 0;
  let windowFocused = document.hasFocus();

  for (const input of document.querySelectorAll('input')) {
    descriptions.set(input, input.getAttribute('aria-describedby') || '');
  }

  function announce(message) {
    byId('demo-log').textContent = message;
  }

  function later(callback, delay) {
    const currentOperation = operation;
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (currentOperation === operation) callback();
    }, delay);
    timers.add(timer);
  }

  function setBusy(value, label) {
    busy = value;
    for (const form of [loginForm, activateForm]) {
      form.setAttribute('aria-busy', String(value && !form.hidden));
      for (const button of form.querySelectorAll('button')) button.disabled = value;
      for (const input of form.querySelectorAll('input')) input.readOnly = value;
    }
    for (const [button, originalLabel] of buttonLabels) {
      const isActive = (stage === 'login' && button.id === 'login-submit')
        || (stage === 'activate' && button.id === 'activate-submit');
      button.setAttribute('aria-busy', String(value && isActive));
      button.querySelector('[data-button-label]').textContent = value && isActive ? label : originalLabel;
    }
  }

  function cancelPending() {
    operation += 1;
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    setBusy(false);
    pulseAt = -Infinity;
  }

  function restoreDescription(input) {
    const original = descriptions.get(input);
    if (original) input.setAttribute('aria-describedby', original);
    else input.removeAttribute('aria-describedby');
    input.removeAttribute('aria-invalid');
  }

  function clearError(form) {
    const error = byId(form === loginForm ? 'login-error' : 'activate-error');
    error.textContent = '';
    error.hidden = true;
    for (const input of form.querySelectorAll('input')) restoreDescription(input);
  }

  function showError(form, message, inputs, shouldFocus = true) {
    const error = byId(form === loginForm ? 'login-error' : 'activate-error');
    error.textContent = message;
    error.hidden = false;
    for (const input of inputs) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', [descriptions.get(input), error.id].filter(Boolean).join(' '));
    }
    if (shouldFocus) inputs[0].focus({ preventScroll: true });
    setWave('error');
    later(() => setWave(stage === 'login' ? 'idle' : 'identity'), 900);
  }

  function updateRules() {
    const password = newPassword.value;
    byId('rule-length').dataset.met = String(password.length >= 8);
    byId('rule-letter').dataset.met = String(/[A-Za-z]/.test(password));
    byId('rule-number').dataset.met = String(/[0-9]/.test(password));
  }

  function setPasswordVisibility(button, visible) {
    const input = byId(button.dataset.togglePassword);
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    const names = {
      'login-password': '登录密码',
      'new-password': '新密码',
      'confirm-password': '确认密码',
    };
    button.setAttribute('aria-label', `${visible ? '隐藏' : '显示'}${names[input.id] || '密码'}`);
    button.querySelector('img').src = visible ? 'icons/eye-off.svg' : 'icons/eye.svg';
  }

  function clearPasswords() {
    for (const input of [loginPassword, newPassword, confirmPassword]) input.value = '';
    for (const button of document.querySelectorAll('[data-toggle-password]')) {
      setPasswordVisibility(button, false);
    }
    updateRules();
  }

  function setStage(nextStage, { focus = false, activated = false } = {}) {
    stage = nextStage;
    device.dataset.stage = nextStage;
    loginForm.hidden = nextStage !== 'login';
    activateForm.hidden = nextStage !== 'activate';
    successPanel.hidden = nextStage !== 'success';
    const headings = {
      login: ['学生账号', '让校园<br>听见你。', '用学号登录菁悠广播站'],
      activate: ['首次登录', '你好，李同学', '首次登录，请设置新密码'],
      success: ['准备好了', '你的声音，<br>已就位。', '欢迎回来，李同学'],
    };
    const [eyebrow, title, subtitle] = headings[nextStage];
    byId('hero-eyebrow').textContent = eyebrow;
    byId('hero-title').innerHTML = title;
    byId('hero-subtitle').textContent = subtitle;
    byId('back-button').hidden = false;
    device.querySelector('.phone-scroll').scrollTop = 0;
    for (const button of document.querySelectorAll('[data-preview]')) {
      button.setAttribute('aria-pressed', String(button.dataset.preview === nextStage));
    }
    if (nextStage === 'success') {
      byId('success-name').textContent = activeProfile ? activeProfile.name : '李同学';
      byId('success-copy').textContent = activated
        ? '高二（3）班，账号已准备就绪。'
        : '高二（3）班，欢迎回到菁悠广播站。';
      byId('finish-button').textContent = '重新体验';
    }
    setWave(nextStage === 'login' ? 'idle' : 'identity');
    if (focus) {
      const target = nextStage === 'login' ? studentId
        : nextStage === 'activate' ? newPassword : byId('finish-button');
      target.focus({ preventScroll: true });
    }
  }

  function reset({ focus = false, announceReset = true } = {}) {
    cancelPending();
    if (dialog.open) dialog.close();
    activeProfile = null;
    activeStudentId = '';
    loginForm.reset();
    activateForm.reset();
    clearPasswords();
    clearError(loginForm);
    clearError(activateForm);
    setStage('login', { focus });
    if (announceReset) announce('已回到登录页，可填写演示账号体验完整流程。');
  }

  function canAnimate() {
    return motionToggle.checked && !reducedMotion.matches && !document.hidden && windowFocused;
  }

  function drawWave(now) {
    const state = device.dataset.wave;
    const identity = state === 'identity';
    signalAvatar.style.opacity = identity ? '1' : '0';
    signalInitial.style.opacity = identity ? '1' : '0';
    signalInitial.textContent = '李';
    if (identity) {
      signalPath.setAttribute('d', 'M 0 44 H 146 M 214 44 H 360');
      return;
    }
    const animated = canAnimate();
    const pulseProgress = Math.min(1, Math.max(0, (now - pulseAt) / 700));
    const pulse = Number.isFinite(pulseAt) ? Math.pow(1 - pulseProgress, 2) : 0;
    const verifying = state === 'verifying';
    const amplitude = verifying ? 17 : state === 'error' ? 5 : 1.5 + (animated ? pulse * 10 : 0);
    const phase = animated && verifying ? (now - verificationAt) / 125 : animated ? now / 310 : 0;
    const points = [];
    for (let x = 0; x <= 360; x += 3) {
      const envelope = Math.sin((x / 360) * Math.PI) ** 2;
      const y = 44 + Math.sin((x / 360) * Math.PI * 10 - phase) * amplitude * envelope;
      points.push(`${x === 0 ? 'M' : 'L'} ${x} ${y.toFixed(2)}`);
    }
    signalPath.setAttribute('d', points.join(' '));
  }

  function updateFrame(now) {
    frame = 0;
    drawWave(now);
    const pulsing = now - pulseAt < 700;
    if (canAnimate() && (device.dataset.wave === 'verifying' || pulsing)) {
      frame = window.requestAnimationFrame(updateFrame);
    }
  }

  function refreshWave() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    updateFrame(performance.now());
  }

  function setWave(state) {
    device.dataset.wave = state;
    if (state === 'verifying') verificationAt = performance.now();
    refreshWave();
  }

  function pulseWave() {
    if (stage !== 'login' || busy) return;
    pulseAt = performance.now();
    setWave('focus');
  }

  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    clearError(loginForm);
    const username = studentId.value.trim();
    const password = loginPassword.value;
    if (!username) {
      showError(loginForm, '请先填写学号。', [studentId]);
      return;
    }
    if (!password) {
      showError(loginForm, '请填写登录密码。', [loginPassword]);
      return;
    }
    cancelPending();
    setBusy(true, '正在验证');
    setWave('verifying');
    announce('正在验证演示账号。');
    later(() => {
      setBusy(false);
      const profile = profiles[username];
      if (!profile || password !== profile.password) {
        showError(loginForm, '学号或密码不正确，请重新输入。', [studentId, loginPassword]);
        announce('验证未通过。可使用页面旁的演示账号体验。');
        return;
      }
      activeProfile = profile;
      activeStudentId = username;
      clearPasswords();
      if (profile.firstLogin) {
        setStage('activate', { focus: true });
        announce('演示账号验证通过。首次登录，请设置新密码。');
      } else {
        setStage('success', { focus: true });
        announce('演示登录成功。此预览未连接真实账号。');
      }
    }, 950);
  });

  activateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    clearError(activateForm);
    const password = newPassword.value;
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      showError(activateForm, '新密码至少 8 位，并包含英文字母与数字。', [newPassword]);
      return;
    }
    if (password === `user${activeStudentId}`) {
      showError(activateForm, '请设置一个与初始密码不同的新密码。', [newPassword]);
      return;
    }
    if (confirmPassword.value !== password) {
      showError(activateForm, '两次输入的密码不一致，请再检查一下。', [confirmPassword]);
      return;
    }
    cancelPending();
    clearPasswords();
    setBusy(true, '正在准备');
    setWave('verifying');
    announce('正在演示账号激活。');
    later(() => {
      setBusy(false);
      setStage('success', { focus: true, activated: true });
      announce('演示完成：已模拟设置新密码，未保存任何账号数据。');
    }, 900);
  });

  for (const form of [loginForm, activateForm]) {
    for (const input of form.querySelectorAll('input')) {
      input.addEventListener('focus', pulseWave);
      input.addEventListener('input', () => {
        clearError(form);
        if (input === newPassword) updateRules();
        pulseWave();
      });
    }
    form.addEventListener('focusout', () => {
      if (!busy && stage === 'login') setWave('idle');
    });
  }

  for (const button of document.querySelectorAll('[data-toggle-password]')) {
    button.addEventListener('click', () => {
      setPasswordVisibility(button, byId(button.dataset.togglePassword).type === 'password');
    });
  }

  for (const button of document.querySelectorAll('[data-preview]')) {
    button.addEventListener('click', () => {
      reset({ announceReset: false });
      const preview = button.dataset.preview;
      if (preview === 'error') {
        studentId.value = '20240101';
        loginPassword.value = 'sample-wrong-password';
        showError(loginForm, '学号或密码不正确，请重新输入。', [studentId, loginPassword], false);
        announce('正在预览登录错误状态。');
      } else if (preview === 'activate' || preview === 'success') {
        activeStudentId = preview === 'activate' ? '20240101' : '20240102';
        activeProfile = profiles[activeStudentId];
        setStage(preview);
        announce(preview === 'activate' ? '正在预览首次登录设置密码。' : '正在预览登录完成状态。');
      } else {
        announce('正在预览登录页。');
      }
      for (const previewButton of document.querySelectorAll('[data-preview]')) {
        previewButton.setAttribute('aria-pressed', String(previewButton === button));
      }
    });
  }

  byId('fill-demo').addEventListener('click', () => {
    reset({ announceReset: false });
    studentId.value = '20240101';
    loginPassword.value = 'user20240101';
    pulseWave();
    announce('已填入首次登录演示账号。点击登录可体验设置密码流程。');
    byId('login-submit').focus({ preventScroll: true });
  });
  byId('reset-demo').addEventListener('click', () => reset());
  byId('back-button').addEventListener('click', () => reset({ focus: true }));
  byId('finish-button').addEventListener('click', () => reset({ focus: true }));

  function openHelp(title, copy) {
    byId('dialog-title').textContent = title;
    byId('dialog-copy').textContent = copy;
    if (!dialog.open) dialog.showModal();
  }

  byId('help-button').addEventListener('click', () => {
    openHelp('登录帮助', '请使用学校分发的学号登录。初始密码为 user 加学号，例如 user20240101。如果忘记密码或学号无法登录，请联系广播站老师。');
  });
  byId('wechat-button').addEventListener('click', () => {
    openHelp('微信登录', '请优先使用学号登录。微信登录需在微信小程序内使用，当前网页可体验学号登录流程。');
  });
  byId('dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });

  motionToggle.addEventListener('change', () => {
    refreshWave();
    announce(motionToggle.checked && !reducedMotion.matches ? '动效已开启。' : '动效已关闭，交互流程保持可用。');
  });
  reducedMotion.addEventListener('change', refreshWave);
  document.addEventListener('visibilitychange', refreshWave);
  window.addEventListener('blur', () => {
    windowFocused = false;
    refreshWave();
  });
  window.addEventListener('focus', () => {
    windowFocused = true;
    refreshWave();
  });

  reset({ announceReset: false });
})();
