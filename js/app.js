/**
 * 화면 로직 (UI). 계산은 engine.js(window.LottoEngine)에 위임합니다.
 */
(function () {
  'use strict';

  var E = window.LottoEngine;
  var draws = window.LOTTO_DRAWS || [];
  var isSample = !!window.LOTTO_DATA_IS_SAMPLE;
  var SAVE_KEY = 'lottopick.savedCombos.v1';
  var DEFAULT_FILTER = { oddMin: 2, oddMax: 4, sumMin: 100, sumMax: 180, minAC: 6 };
  var VIEW_TITLES = {
    dashboard: '분석 대시보드',
    db: '역대 회차 DB',
    simulator: '백테스팅 시뮬레이터',
    saved: '저장된 조합함',
  };

  var state = {
    view: 'dashboard',
    stats: null,
    filter: Object.assign({ fixed: [], exclude: [] }, DEFAULT_FILTER),
    pickerMode: 'fixed',
    result: null,
    selectedIdx: 0,
    simNums: null,
    dbPage: 0,
    dbQuery: '',
    saved: loadSaved(),
    seed: null,        // 재현용 시드 (null이면 매번 무작위 샘플링)
    wf: null,          // 워크포워드 검증 결과 (버튼을 눌렀을 때만 계산)
    baselineCache: {}, // 조합별 무작위 기준선 결과
  };

  /* ---------- 공통 유틸 ---------- */

  function $(id) { return document.getElementById(id); }

  function setHtml(id, html) {
    var el = $(id);
    if (el) el.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ballClass(n) {
    if (n <= 10) return 'ball-y';
    if (n <= 20) return 'ball-b';
    if (n <= 30) return 'ball-r';
    if (n <= 40) return 'ball-g';
    return 'ball-k';
  }

  function ballsHtml(nums, small) {
    return nums.map(function (n) {
      return '<span class="ball ' + ballClass(n) + (small ? ' sm' : '') + '">' + n + '</span>';
    }).join('');
  }

  function alertsHtml(items) {
    return items.map(function (it) {
      return '<div class="alert ' + it[0] + '">' + esc(it[1]) + '</div>';
    }).join('');
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  function loadSaved() {
    try {
      var raw = window.localStorage.getItem(SAVE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function persistSaved() {
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(state.saved));
    } catch (e) {
      toast('브라우저 저장소에 기록할 수 없습니다.');
    }
  }

  function parseNums(text) {
    return String(text).split(/[^0-9]+/).filter(function (s) { return s !== ''; }).map(Number);
  }

  /* ---------- 초기화 ---------- */

  // 회차 데이터를 교체하고 모든 통계/화면을 다시 계산한다.
  // 오류가 있으면 기존 데이터를 유지하고 false를 반환한다.
  function loadData(list, sample) {
    var errors = E.validateDraws(list);
    if (errors.length) {
      showDataMessage(['danger', '회차 데이터 오류: ' + errors[0]]);
      return false;
    }
    draws = list;
    isSample = sample;
    state.stats = E.buildStats(draws, { trendWindow: 20 });
    state.dbPage = 0;
    state.wf = null;
    state.baselineCache = {};
    $('data-status').innerHTML = '<b>' + (isSample ? '샘플 데이터' : '실데이터') + '</b>' +
      '<span>' + state.stats.total + '회차 · 최신 ' + state.stats.latestRound + '회</span>';
    $('sidebar-foot').classList.toggle('is-sample', !!isSample);
    var chip = $('m-chip');
    if (chip) chip.textContent = state.stats.latestRound + '회 · ' + (isSample ? '샘플' : '실데이터');

    var notes = [];
    if (isSample) {
      notes.push(['warn', '샘플 데이터(난수 생성)로 동작 중입니다. 실제 결과가 아니며, 아래 DB 화면에서 CSV를 불러오면 실제 회차로 분석합니다.']);
    }
    if (draws.length < 100) {
      notes.push(['warn', '분석 회차가 100회 미만입니다 (' + draws.length + '회). 통계 신뢰도가 낮을 수 있습니다.']);
    }
    var gaps = E.findMissingRounds(draws);
    if (gaps.length) {
      notes.push(['warn', '회차 누락 ' + gaps.length + '개: ' + gaps.slice(0, 10).join(', ') + (gaps.length > 10 ? ' ...' : '')]);
    }
    setHtml('global-messages', alertsHtml(notes));

    renderStatTiles();
    renderHeatmap();
    renderHotLists();
    renderBands();
    renderFilterPanel();
    runGenerate();
    renderDb();
    renderProbCards();
    renderBudget();
    renderSelfCheck();
    return true;
  }

  /* ---------- 통계 검정 카드 ---------- */

  function renderStatTests() {
    var s = state.stats;

    // 1) 번호 출현 균등성 (카이제곱): 전체 데이터 기준, 즉시 계산
    var chi = E.chiSquareUniformity(s.freq);
    $('test-chi').innerHTML = 'χ² = ' + chi.chi2.toFixed(2) + ' (자유도 ' + chi.df + ')<br>p = ' + chi.pValue.toFixed(3) +
      verdictBadge(chi.pValue);

    // 2) 워크포워드 검증: 버튼을 눌렀을 때 계산된 결과 표시
    if (state.wf) {
      var w = state.wf;
      $('test-wf').innerHTML = '시험 ' + w.n + '회 · 상위 6개 번호 평균 적중 ' + w.mean.toFixed(3) +
        '개 (무작위 기대 ' + w.expected.toFixed(2) + '개)<br>95% 신뢰구간 [' + w.ci95[0].toFixed(3) + ', ' +
        w.ci95[1].toFixed(3) + ']<br>z = ' + w.z.toFixed(2) + ', p = ' + w.pValue.toFixed(3) +
        verdictBadge(w.pValue);
    }

    // 3) 선택 조합의 무작위 기준선
    var sel = currentSelection();
    if (!sel) {
      $('test-baseline').textContent = '추천 조합이 없습니다';
      return;
    }
    var key = sel.nums.join(',');
    if (!state.baselineCache[key]) {
      state.baselineCache[key] = E.randomBaselinePercentile(s, sel.nums, { samples: 20000, seed: 12345 });
    }
    var b = state.baselineCache[key];
    $('test-baseline').innerHTML = '무작위 조합 20,000개 중 번호 가중치가 이 조합 이상인 비율: <b>' +
      (b.fraction * 100).toFixed(1) + '%</b><br><span class="muted">' +
      (b.fraction <= 0.05 ? '상위 5% 이내' : '상위 5%를 벗어남 (무작위와 뚜렷한 차이 없음)') + '</span>' +
      (state.wf && state.wf.pValue >= 0.05
        ? '<br><span class="muted">※ 가중치 기준 상위권이지만, 워크포워드 검증에서 과거 신호는 유의하지 않았습니다.</span>'
        : '');
  }

  function verdictBadge(p) {
    return p < 0.05
      ? '<span class="verdict signal">유의한 차이</span>'
      : '<span class="verdict none">무작위와 구별되지 않음</span>';
  }

  function runWalkForward() {
    $('test-wf').textContent = '계산 중…';
    // 화면이 먼저 갱신되도록 다음 틱에 계산
    setTimeout(function () {
      state.wf = E.walkForwardSignal(draws, { minTrain: 100 });
      renderStatTests();
    }, 20);
  }

  // 추천 파이프라인 전체(후보 생성 → 다음 회차 대입)를 과거 시점마다 검증
  function runPipeline() {
    $('test-pipeline').textContent = '계산 중… (5회차 간격, 약 1초)';
    setTimeout(function () {
      var res = E.walkForwardPipeline(draws, currentFilterForPipeline(), { minTrain: 100, step: 5, attempts: 4000 });
      state.pipeline = res;
      var verdict = res.pValue < 0.05
        ? '<span class="verdict signal">유의한 차이</span>'
        : '<span class="verdict none">무작위와 구별되지 않음</span>';
      $('test-pipeline').innerHTML = '<b>추천 파이프라인</b> 시험 ' + res.n + '회 (' + res.step + '회차 간격)<br>' +
        '평균 적중 ' + res.mean.toFixed(3) + '개 · 무작위 기대 ' + res.expected.toFixed(2) + '개<br>' +
        '95% 신뢰구간 [' + res.ci95[0].toFixed(3) + ', ' + res.ci95[1].toFixed(3) + '] · p = ' +
        res.pValue.toFixed(3) + ' ' + verdict;
    }, 20);
  }

  // 파이프라인 검증은 현재 필터 조건을 그대로 쓴다
  function currentFilterForPipeline() {
    return Object.assign({}, state.filter, {
      fixed: state.filter.fixed.slice(),
      exclude: state.filter.exclude.slice(),
    });
  }

  /* ---------- 확률 · 기대 수익 · 필터 깔때기 ---------- */

  function fmtKRW(n) {
    return Math.round(n).toLocaleString('ko-KR') + '원';
  }

  // 확률 표시: 매우 작은 값은 지수 표기로 보여준다
  function fmtProb(p) {
    var pct = p * 100;
    if (pct >= 0.01) return pct.toFixed(2) + '%';
    return pct.toExponential(2) + '%';
  }

  function renderProbCards() {
    var probs = E.rankProbabilities();

    var rows = probs.map(function (p) {
      return '<tr><td>' + p.label + '</td><td class="num">1 / ' +
        Math.round(p.oneIn).toLocaleString('ko-KR') + '</td><td class="num">' + fmtProb(p.prob) + '</td></tr>';
    }).join('');
    var yearly = E.atLeastOnce(probs[0].prob, 52);
    $('odds-card').innerHTML =
      '<div class="card-head"><h3>등수별 정확한 확률</h3><span class="badge">1장 기준</span></div>' +
      '<table class="odds-table"><thead><tr><th>등수</th><th style="text-align:right">확률 (분의 1)</th><th style="text-align:right">확률</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="odds-foot">모든 조합의 확률은 동일합니다. 1년(52주) 동안 1등에 한 번이라도 당첨될 확률은 <b>' +
      fmtProb(yearly) + '</b>입니다. 분석 점수는 이 확률을 바꾸지 않습니다.</div>';

    var ev = E.expectedReturn(draws);
    if (!ev.available) {
      $('ev-card').innerHTML =
        '<div class="card-head"><h3>1장당 기대 수익</h3></div>' +
        '<div class="empty"><strong>계산할 수 없습니다</strong><p>' + ev.message + '</p></div>';
      state.ev = null;
      return;
    }
    state.ev = ev;
    var loss = ev.expectedLoss;
    $('ev-card').innerHTML =
      '<div class="card-head"><h3>1장당 기대 수익</h3><span class="badge">과거 평균 당첨금 기준</span></div>' +
      '<div class="ev-big">' + fmtKRW(ev.ev) + ' <small>/ ' + fmtKRW(ev.price) + '</small></div>' +
      '<div class="ev-rate">기대 환급률 ' + (ev.returnRate * 100).toFixed(1) + '%</div>' +
      '<div class="ev-kv">' +
        '<div><span>1장당 기대 손실</span><b>' + fmtKRW(loss) + '</b></div>' +
        '<div><span>분석 회차</span><b>' + ev.sampleRounds.toLocaleString('ko-KR') + '회</b></div>' +
      '</div>' +
      '<p class="ev-note">1등 당첨금은 회차마다 크게 달라 평균이 큰 영향을 받습니다. 이 값은 추정치이며, 구매 금액보다 낮은 기대 수익이 일반적입니다.</p>';
  }

  // 필터 조건이 후보를 얼마나 줄이는지 무작위 표본(10만 회)으로 추정
  function renderFunnel() {
    var f = E.filterFunnel(currentFilterForPipeline(), { samples: 100000, seed: 2026 });
    state.funnel = f;
    var rows = f.stages.map(function (s) {
      var w = Math.max(0.6, s.pct);
      return '<div class="funnel-row"><div class="funnel-label"><span>' + s.label +
        '</span><b>' + fmtProb(s.count / f.samples) + '</b></div>' +
        '<div class="funnel-track"><div class="funnel-fill" style="width:' + w.toFixed(2) + '%"></div></div></div>';
    }).join('');
    $('funnel-card').innerHTML =
      '<div class="card-head"><h3>필터 깔때기</h3><span class="badge">추정치</span></div>' +
      '<div class="funnel">' + rows + '</div>' +
      '<p class="funnel-foot">무작위 조합 ' + f.samples.toLocaleString('ko-KR') + '개를 뽑아 단계별 통과율을 추정했습니다. ' +
      '[조건 적용 · 후보 생성]을 누르면 다시 계산됩니다.</p>';
  }

  /* ---------- 구매 계획 · 예산 보호 · 자가 점검 ---------- */

  function renderBudget() {
    var tickets = Number($('bd-tickets').value) || 0;
    var weeks = Number($('bd-weeks').value) || 0;
    var budget = Number($('bd-budget').value);
    var hasBudget = Number.isFinite(budget) && $('bd-budget').value !== '';
    var ev = state.ev ? state.ev.ev : 0;
    var plan = E.budgetPlan({ ticketsPerWeek: tickets, weeks: weeks, budget: hasBudget ? budget : undefined, evPerTicket: ev });

    var warn = '';
    if (plan.overBudget) {
      warn = '<div class="alert danger">계획한 구매 금액(' + fmtKRW(plan.cost) + ')이 예산을 ' +
        fmtKRW(-plan.remaining) + ' 초과합니다. 장수나 기간을 줄여 보세요.</div>';
    }
    var evNote = state.ev ? '' : '<div class="alert info">당첨금 데이터가 없어 기대 손실은 구매 금액 전체로 표시합니다.</div>';

    $('bd-result').innerHTML = warn + evNote +
      '<div class="budget-kv">' +
        '<div><span>총 구매 장수</span><b>' + plan.totalTickets.toLocaleString('ko-KR') + '장</b></div>' +
        '<div><span>총 구매 금액</span><b>' + fmtKRW(plan.cost) + '</b></div>' +
        '<div><span>기대 손실</span><b>' + fmtKRW(state.ev ? plan.expectedLoss : plan.cost) + '</b></div>' +
        '<div><span>예산 잔액</span><b>' + (plan.remaining === null ? '-' : fmtKRW(plan.remaining)) + '</b></div>' +
      '</div>';
  }

  function renderSelfCheck() {
    var answers = state.selfCheck || [false, false, false, false];
    state.selfCheck = answers;
    $('sc-list').innerHTML = E.SELF_CHECK_QUESTIONS.map(function (q, i) {
      return '<label class="sc-item"><input type="checkbox" data-sc="' + i + '"' + (answers[i] ? ' checked' : '') + ' />' +
        '<span>' + esc(q) + '</span></label>';
    }).join('');

    var lv = E.selfCheckLevel(answers);
    var html = '';
    if (lv.level === 1) {
      html = '<div class="support"><b>조금 주의가 필요합니다.</b> 구매가 걱정되신다면 <b>1336</b>(국번 없이)으로 ' +
        '도박문제 상담을 받을 수 있습니다. 한국도박문제예방치유원의 헬프라인입니다.</div>';
    } else if (lv.level === 2) {
      html = '<div class="support strong"><b>여러 항목에 해당합니다.</b> 지금은 구매를 멈추고, 가족이나 주변 사람과 ' +
        '이야기해 보시길 권합니다. 도박문제 상담은 <b>1336</b>(국번 없이)에서 받을 수 있습니다. ' +
        '위급한 상황이라면 <b>112</b> 또는 자살예방상담전화 <b>109</b>에 바로 연락하세요.</div>';
    }
    $('sc-result').innerHTML = html;
  }

  function showDataMessage(item) {
    setHtml('global-messages', item ? alertsHtml([item]) : '');
  }

  /* ---------- 스마트폰 설치 (QR · 홈 화면 설치) ---------- */

  var deferredInstall = null; // 브라우저의 설치 프롬프트 이벤트

  function isLocalHost() {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  }

  function isIos() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function drawQr(url) {
    var box = $('qr-box');
    if (typeof window.qrcode !== 'function') {
      box.textContent = 'QR 생성 실패';
      return;
    }
    var qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag(4, 2);
  }

  function setQr(url, label, guide) {
    drawQr(url);
    $('qr-url').textContent = url;
    var badge = $('qr-status');
    badge.textContent = label;
    badge.className = 'qr-badge ' + (isLocalHost() ? 'warn' : 'ok');
    $('qr-guide').textContent = guide;
  }

  // QR이 가리킬 설치 페이지 주소를 정한다. (공개 주소 > 같은 Wi-Fi 주소 > 현재 주소)
  function installPageUrl(base) {
    return base.replace(/\/?$/, '/') + 'install.html';
  }

  function initQr() {
    var baseGuide = isIos()
      ? 'QR을 스캔한 뒤 안내에 따라 Safari에서 홈 화면에 추가하세요.'
      : 'QR을 스캔하면 설치 페이지가 열립니다. 거기서 설치 버튼을 누르세요.';
    var publicUrl = (window.LOTTO_CONFIG && LOTTO_CONFIG.publicUrl) || '';

    if (publicUrl) {
      setQr(installPageUrl(publicUrl), '공개 주소', baseGuide);
    } else if (!isLocalHost()) {
      setQr(installPageUrl(location.origin + '/'), '접속 중', baseGuide);
    } else {
      // 이 PC에서 열린 경우: 같은 Wi-Fi의 주소를 서버에 물어본다
      setQr(installPageUrl(location.origin + '/'), '이 PC 전용', '스마트폰용 주소를 찾는 중…');
      fetch('/__lan', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          if (info && info.addresses && info.addresses.length) {
            var base = 'http://' + info.addresses[0].address + ':' + info.port + '/';
            setQr(installPageUrl(base), '같은 Wi-Fi', baseGuide);
            $('qr-guide').textContent = '같은 Wi-Fi에서만 열립니다. 홈 화면 설치는 HTTPS 공개 주소에서 가능합니다.';
          } else {
            $('qr-guide').textContent = 'PC 주소를 찾지 못했습니다. npm run serve 로 실행하면 스마트폰용 주소가 표시됩니다.';
          }
        })
        .catch(function () {
          $('qr-guide').textContent = 'npm run serve 로 실행하면 스마트폰용 주소가 표시됩니다.';
        });
    }

    if (!window.isSecureContext && !isLocalHost()) {
      $('qr-guide').textContent = '이 주소는 보안 연결(HTTPS)이 아니어서 홈 화면 설치가 제한될 수 있습니다.';
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').catch(function () {
      // 등록 실패해도 앱은 그대로 동작한다
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    var btn = $('install-btn');
    if (btn) btn.hidden = false;
  });

  window.addEventListener('appinstalled', function () {
    deferredInstall = null;
    var btn = $('install-btn');
    if (btn) btn.hidden = true;
    toast('홈 화면에 설치되었습니다.');
  });

  function installApp() {
    if (!deferredInstall) {
      return toast(isIos() ? 'Safari 공유 버튼 → "홈 화면에 추가"를 이용하세요.' : '이미 설치되었거나 이 브라우저에서는 지원되지 않습니다.');
    }
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function () {
      deferredInstall = null;
      $('install-btn').hidden = true;
    });
  }

  /* ---------- 설치 마법사 / 라이선스 ---------- */

  var LICENSE_KEY = 'lottopick.license.v1';
  var LICENSE_VERSION = '1.0.0';

  function hasAcceptedLicense() {
    try {
      return window.localStorage.getItem(LICENSE_KEY) === LICENSE_VERSION;
    } catch (e) {
      return false;
    }
  }

  // 설치 마법사 표시. 동의 전이면 시작 버튼이 체크 전까지 비활성, 동의 후 다시 열면 '닫기'로 표시
  function showSetup() {
    var accepted = hasAcceptedLicense();
    var agree = $('setup-agree');
    var start = $('setup-start');
    agree.checked = accepted;
    start.disabled = !accepted;
    start.textContent = accepted ? '닫기' : '설치 완료 · 시작하기';
    $('setup').hidden = false;
    document.body.classList.add('locked');
    agree.focus();
  }

  function hideSetup() {
    $('setup').hidden = true;
    document.body.classList.remove('locked');
  }

  function init() {
    bindEvents();
    initQr();
    registerServiceWorker();
    if (!hasAcceptedLicense()) showSetup();
    if (!loadData(draws, isSample)) return;
    renderSaved();
    setView('dashboard');
  }

  // CSV 파일을 읽어 회차 데이터로 불러온다 (형식: 회차,번호1..6,보너스)
  function importCsv(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = E.parseDrawsCsv(String(reader.result));
      if (parsed.errors.length) {
        setHtml('db-import-msg', alertsHtml([['danger', 'CSV 오류: ' + parsed.errors.slice(0, 3).join(' / ')]]));
        return;
      }
      if (loadData(parsed.draws, false)) {
        toast(parsed.draws.length + '회차를 불러왔습니다.');
        setHtml('db-import-msg', alertsHtml([['info', parsed.draws.length + '회차 실데이터 적용 완료 (최신 ' + state.stats.latestRound + '회)']]));
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ---------- 뷰 전환 ---------- */

  function setView(view) {
    state.view = view;
    document.querySelectorAll('[data-view-panel]').forEach(function (el) {
      el.hidden = el.getAttribute('data-view-panel') !== view;
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    $('page-title').textContent = VIEW_TITLES[view] || '';
    document.body.setAttribute('data-view', view);
    if (view !== 'dashboard') closeSheet();
    if (view === 'saved') renderSaved();
    if (view === 'db') renderDb();
  }

  /* ---------- 대시보드: 통계 타일 ---------- */

  function renderStatTiles() {
    var s = state.stats;
    var tiles = [
      ['분석 회차 수', s.total + '회', '최신 ' + s.latestRound + '회 기준'],
      ['평균 번호 합계', s.pattern.sum.mean.toFixed(1), '표준편차 ' + s.pattern.sum.std.toFixed(1)],
      ['평균 홀수 개수', s.pattern.odd.mean.toFixed(2), '6개 중'],
      ['평균 AC값', s.pattern.ac.mean.toFixed(2), '범위 0~10'],
      ['평균 이월수', s.pattern.carry.mean.toFixed(2), '직전 회차 대비'],
    ];
    setHtml('stat-tiles', tiles.map(function (t) {
      return '<div class="stat-tile"><div class="stat-label">' + t[0] + '</div>' +
        '<div class="stat-value">' + t[1] + '</div><div class="stat-sub">' + t[2] + '</div></div>';
    }).join(''));
  }

  /* ---------- 대시보드: 추천 조합 ---------- */

  function currentSelection() {
    var r = state.result;
    if (!r || !r.ok || !r.candidates.length) return null;
    return r.candidates[state.selectedIdx] || null;
  }

  function runGenerate() {
    state.result = E.generateCandidates(state.filter, state.stats, { seed: state.seed });
    state.selectedIdx = 0;
    renderMessages();
    renderRecommendation();
    renderCandidates();
    renderStatTests();
    renderFunnel();
  }

  function renderMessages() {
    var r = state.result;
    var items = [];
    r.errors.forEach(function (e) { items.push(['danger', e]); });
    if (r.ok && r.candidates.length) {
      var how = r.method === 'exhaustive'
        ? '전수 탐색'
        : '무작위 샘플링 ' + r.attempts.toLocaleString() + '회';
      items.push(['info', '조건 통과 후보 ' + r.totalFound.toLocaleString() + '개 중 상위 ' +
        r.candidates.length + '개 표시 (' + how + ')']);
    }
    r.warnings.forEach(function (w) { items.push(['warn', w]); });
    setHtml('dash-messages', alertsHtml(items));
  }

  function metricCell(label, value) {
    return '<div class="metric"><div class="metric-label">' + label +
      '</div><div class="metric-value">' + value + '</div></div>';
  }

  function renderRecommendation() {
    var box = $('recommend');
    var sel = currentSelection();
    var head = '<div class="card-head"><h3>추천 조합 &amp; 적합도</h3>' +
      '<span class="badge">통계 지표 기반 조합 필터링</span></div>';

    if (!sel) {
      box.innerHTML = head +
        '<div class="empty"><strong>표시할 추천 조합이 없습니다</strong>' +
        '<p>필터 조건을 완화한 뒤 [조건 적용 · 후보 생성]을 눌러 주세요.</p></div>' +
        actionsHtml(false);
      return;
    }

    var m = sel.metrics;
    box.innerHTML = head +
      '<div class="reco-main">' +
        '<div class="balls">' + ballsHtml(sel.nums) + '</div>' +
        '<div class="score">' +
          '<div class="score-num">' + sel.score + '<small> / 100</small></div>' +
          '<div class="score-label">패턴 적합도 스코어 (후보군 내 상대 점수)</div>' +
          '<div class="bar"><span style="width:' + sel.score + '%"></span></div>' +
        '</div>' +
      '</div>' +
      '<div class="sub-scores">번호 가중치 ' + Math.round(sel.numberFit * 100) +
        ' · 패턴 일치 ' + Math.round(sel.patternFit * 100) + '</div>' +
      '<div class="tags">' + sel.tags.map(function (t) {
        return '<span class="tag">' + esc(t) + '</span>';
      }).join('') + '</div>' +
      '<div class="metric-grid">' +
        metricCell('합계', m.sum) +
        metricCell('홀:짝', m.odd + ':' + m.even) +
        metricCell('저:고', m.low + ':' + m.high) +
        metricCell('AC값', m.ac) +
        metricCell('연속번호', m.consecutive + '쌍') +
        metricCell('이월수', m.carry + '개') +
      '</div>' +
      actionsHtml(true) +
      '<p class="note">적합도는 과거 데이터의 통계 지표를 비교한 분석 점수이며, 당첨 번호를 예측하거나 확정하지 않습니다.</p>';
  }

  function actionsHtml(hasSel) {
    return '<div class="actions">' +
      '<button class="btn primary" data-action="generate">새 조합 생성</button>' +
      '<button class="btn" data-action="save" ' + (hasSel ? '' : 'disabled') + '>조합 저장</button>' +
      '<button class="btn" data-action="backtest" ' + (hasSel ? '' : 'disabled') + '>백테스트 실행</button>' +
    '</div>';
  }

  function renderCandidates() {
    var r = state.result;
    if (!r || !r.ok || !r.candidates.length) {
      setHtml('candidates', '<div class="empty">후보 목록이 비어 있습니다.</div>');
      $('cand-meta').textContent = '';
      return;
    }
    $('cand-meta').textContent = '상위 ' + r.candidates.length + '개';
    setHtml('candidates', r.candidates.map(function (c, i) {
      return '<button class="cand ' + (i === state.selectedIdx ? 'active' : '') +
        '" data-action="select-cand" data-idx="' + i + '">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="balls">' + ballsHtml(c.nums, true) + '</span>' +
        '<span class="cand-score">' + c.score + '점</span></button>';
    }).join(''));
  }

  /* ---------- 스마트폰: 조건 시트 ---------- */

  function openSheet() {
    var panel = $('filter-sheet');
    if (!panel) return;
    panel.classList.add('open');
    document.querySelector('.sheet-backdrop').hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closeSheet() {
    var panel = $('filter-sheet');
    if (!panel) return;
    panel.classList.remove('open');
    document.querySelector('.sheet-backdrop').hidden = true;
    document.body.classList.remove('sheet-open');
  }

  /* ---------- 대시보드: 필터 패널 ---------- */

  function renderFilterPanel() {
    var f = state.filter;

    // 모드 버튼
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === state.pickerMode);
    });

    // 번호판
    var pk = '';
    for (var n = 1; n <= 45; n++) {
      var cls = f.fixed.indexOf(n) >= 0 ? 'fixed' : (f.exclude.indexOf(n) >= 0 ? 'exclude' : '');
      pk += '<button class="pk ' + cls + '" data-num="' + n + '">' + n + '</button>';
    }
    setHtml('picker', pk);

    // 칩
    setHtml('chips-fixed', chipsHtml(f.fixed, 'fixed'));
    setHtml('chips-exclude', chipsHtml(f.exclude, 'exclude'));

    // 셀렉트/입력 값
    var oddOpts = '';
    for (var k = 0; k <= 6; k++) oddOpts += '<option value="' + k + '">' + k + '개</option>';
    setHtml('f-odd-min', oddOpts);
    setHtml('f-odd-max', oddOpts);
    $('f-odd-min').value = f.oddMin;
    $('f-odd-max').value = f.oddMax;
    $('f-sum-min').value = f.sumMin;
    $('f-sum-max').value = f.sumMax;
    $('f-min-ac').value = f.minAC;
  }

  function chipsHtml(list, kind) {
    if (!list.length) return '<span class="none">없음</span>';
    return list.map(function (n) {
      return '<span class="chip ' + kind + '">' + n +
        '<button data-remove="' + kind + '" data-value="' + n + '" aria-label="' + n + ' 제거">×</button></span>';
    }).join('');
  }

  function toggleNum(n) {
    var f = state.filter;
    var target = state.pickerMode === 'fixed' ? f.fixed : f.exclude;
    var other = state.pickerMode === 'fixed' ? f.exclude : f.fixed;
    var idx = target.indexOf(n);
    if (idx >= 0) {
      target.splice(idx, 1);
    } else {
      if (state.pickerMode === 'fixed' && target.length >= E.PICK) {
        toast('고정수는 최대 6개까지 선택할 수 있습니다.');
        return;
      }
      target.push(n);
      var oi = other.indexOf(n);
      if (oi >= 0) other.splice(oi, 1);
    }
    target.sort(function (a, b) { return a - b; });
    renderFilterPanel();
  }

  function resetFilter() {
    state.filter = Object.assign({ fixed: [], exclude: [] }, DEFAULT_FILTER);
    renderFilterPanel();
    runGenerate();
    toast('필터를 초기화했습니다.');
  }

  /* ---------- 대시보드: 히트맵 / 번호대 ---------- */

  function renderHeatmap() {
    var freq = state.stats.freq;
    var min = Infinity, max = -Infinity;
    for (var n = 1; n <= 45; n++) {
      min = Math.min(min, freq[n]);
      max = Math.max(max, freq[n]);
    }
    var span = max - min || 1;
    var html = '';
    for (var k = 1; k <= 45; k++) {
      var t = (freq[k] - min) / span;
      var light = 18 + t * 42;
      var textColor = t > 0.6 ? '#0b1222' : '#e2e8f0';
      html += '<div class="hm-cell" title="' + k + '번: 전체 ' + freq[k] + '회 · 최근 ' + state.stats.recent[k] + '회"' +
        ' style="background:hsl(190,75%,' + light.toFixed(1) + '%);color:' + textColor + '">' +
        '<div class="hm-num">' + k + '</div><div class="hm-cnt">' + freq[k] + '회</div></div>';
    }
    setHtml('heatmap', html);
  }

  function renderHotLists() {
    var s = state.stats;
    var nums = [];
    for (var n = 1; n <= 45; n++) nums.push(n);
    var byTotal = nums.slice().sort(function (a, b) { return s.freq[b] - s.freq[a] || a - b; }).slice(0, 5);
    var byRecent = nums.slice().sort(function (a, b) { return s.recent[b] - s.recent[a] || a - b; }).slice(0, 5);

    function list(title, arr, countArr, unit) {
      return '<div><div class="hot-title">' + title + '</div>' + arr.map(function (v) {
        return '<div class="hot-item"><span class="ball sm ' + ballClass(v) + '">' + v + '</span>' +
          '<span class="count">' + countArr[v] + unit + '</span></div>';
      }).join('') + '</div>';
    }
    setHtml('hot-lists',
      list('전체 빈출 TOP 5', byTotal, s.freq, '회') +
      list('최근 ' + s.window + '회 빈출 TOP 5', byRecent, s.recent, '회'));
  }

  function renderBands() {
    var s = state.stats;
    var dist = E.bandDistribution(draws, s.window);
    var maxPct = 0;
    dist.forEach(function (d) {
      maxPct = Math.max(maxPct, d.allPct, d.recentPct, d.expectedPct);
    });
    var scale = maxPct * 1.15 || 1;

    setHtml('bands', dist.map(function (d) {
      var hAll = (d.allPct / scale) * 100;
      var hRec = (d.recentPct / scale) * 100;
      return '<div class="band">' +
        '<div class="band-bars">' +
          '<div class="band-bar all" style="height:' + hAll.toFixed(1) + '%"><span>' + d.allPct.toFixed(1) + '%</span></div>' +
          '<div class="band-bar recent" style="height:' + hRec.toFixed(1) + '%"><span>' + d.recentPct.toFixed(1) + '%</span></div>' +
        '</div>' +
        '<div class="band-label">' + d.label + '번</div>' +
        '<div class="band-exp">기대 ' + d.expectedPct.toFixed(1) + '%</div>' +
      '</div>';
    }).join('') + '<div style="grid-column:1/-1;font-size:12px;color:var(--muted)">' +
      '<span class="legend-dot" style="background:var(--accent)"></span>전체 회차' +
      '<span class="legend-dot" style="background:var(--accent-2)"></span>최근 ' + s.window + '회' +
      ' · 기대값은 번호 개수 비율(균등 출현 가정) 기준</div>');
    $('band-meta').textContent = '번호 1~45 전체 출현 비율';
  }

  /* ---------- 조합 저장 / 시뮬레이터 연동 ---------- */

  function saveCurrent() {
    var sel = currentSelection();
    if (!sel) return;
    var key = sel.nums.join(',');
    var dup = state.saved.some(function (s) { return s.nums.join(',') === key; });
    if (dup) {
      toast('이미 조합함에 있는 조합입니다.');
      return;
    }
    state.saved.unshift({
      id: String(Date.now()),
      nums: sel.nums.slice(),
      score: sel.score,
      tags: sel.tags.slice(),
      savedAt: new Date().toLocaleString('ko-KR'),
    });
    persistSaved();
    renderSaved();
    toast('조합함에 저장했습니다.');
  }

  function openSimulator(nums) {
    state.simNums = nums.slice();
    $('sim-input').value = nums.join(', ');
    setView('simulator');
    runSimulation();
  }

  function runSimulation() {
    var input = $('sim-input');
    var nums = parseNums(input.value);
    var err = E.validateCombo(nums);
    if (err) {
      setHtml('sim-result', alertsHtml([['danger', err + ' 예: 3, 12, 19, 27, 33, 41']]));
      return;
    }
    nums.sort(function (a, b) { return a - b; });
    state.simNums = nums;
    input.value = nums.join(', ');
    renderSimResult(E.backtest(nums, draws));
  }

  function renderSimResult(r) {
    var maxCount = Math.max.apply(null, r.dist) || 1;
    var distHtml = r.dist.map(function (c, k) {
      return '<div class="dist-col"><b>' + c + '</b>' +
        '<div class="dist-bar" style="height:' + ((c / maxCount) * 100).toFixed(1) + '%"></div>' +
        '<span>' + k + '개</span></div>';
    }).join('');

    var ranks = Object.keys(r.rankCounts).map(function (k) {
      return '<div class="rank-item"><b>' + r.rankCounts[k] + '</b><span>' + k + '</span></div>';
    }).join('');

    var recentRows = r.recent.map(function (row) {
      return '<tr><td>' + row.round + '회</td><td>' + row.match + '개' +
        (row.bonusHit ? ' + 보너스' : '') + '</td></tr>';
    }).join('');

    var pct3 = r.total ? ((r.atLeast3 / r.total) * 100).toFixed(2) : '0.00';

    setHtml('sim-result',
      '<div class="sim-grid">' +
        '<div class="stat-tile"><div class="stat-label">시뮬레이션 회차</div><div class="stat-value">' + r.total + '회</div></div>' +
        '<div class="stat-tile"><div class="stat-label">평균 일치 개수</div><div class="stat-value">' + r.avgMatch.toFixed(2) + '개</div>' +
          '<div class="stat-sub">무작위 기대치 ' + r.expectedMatch.toFixed(2) + '개</div></div>' +
        '<div class="stat-tile"><div class="stat-label">3개 이상 일치</div><div class="stat-value">' + r.atLeast3 + '회</div>' +
          '<div class="stat-sub">전체의 ' + pct3 + '%</div></div>' +
        '<div class="stat-tile"><div class="stat-label">최고 일치</div><div class="stat-value">' + r.best + '개</div>' +
          '<div class="stat-sub">' + (r.bestRounds.length ? r.bestRounds.join(', ') + '회' : '-') + '</div></div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="card"><div class="card-head"><h3>일치 개수 분포</h3></div>' +
          '<div class="dist">' + distHtml + '</div></div>' +
        '<div class="card"><div class="card-head"><h3>일치 기준 분류</h3><span class="muted">당첨금 계산 아님</span></div>' +
          '<div class="rank-list" style="grid-template-columns:repeat(2,minmax(0,1fr))">' + ranks + '</div></div>' +
      '</div>' +
      '<div class="card" style="margin-top:18px"><div class="card-head"><h3>최근 10회 대입 결과</h3></div>' +
        '<div class="table-wrap"><table><thead><tr><th>회차</th><th>일치 개수</th></tr></thead><tbody>' +
        recentRows + '</tbody></table></div>' +
        '<p class="note">과거 회차에 단순 대입한 결과이며, 미래 결과를 예측하거나 확정하지 않습니다. 기대치(0.80개)는 무작위 조합의 이론적 평균 일치 수입니다.</p>' +
      '</div>'
    );
  }

  /* ---------- 역대 회차 DB ---------- */

  function renderDb() {
    var s = state.stats;
    var q = state.dbQuery.trim();
    var rows = s.analyzed.slice().reverse().filter(function (r) {
      return !q || String(r.round).indexOf(q) >= 0;
    });
    var pageSize = 20;
    var pages = Math.max(1, Math.ceil(rows.length / pageSize));
    state.dbPage = Math.min(Math.max(0, state.dbPage), pages - 1);
    var slice = rows.slice(state.dbPage * pageSize, (state.dbPage + 1) * pageSize);

    if (!slice.length) {
      setHtml('db-table', '<div class="empty">검색 결과가 없습니다.</div>');
    } else {
      setHtml('db-table', '<table><thead><tr>' +
        '<th>회차</th><th class="left">당첨 번호</th><th>보너스</th><th>합계</th><th>홀:짝</th>' +
        '<th>고:저</th><th>AC</th><th>연속</th><th>이월</th></tr></thead><tbody>' +
        slice.map(function (r) {
          return '<tr><td>' + r.round + '</td>' +
            '<td class="left balls-inline">' + ballsHtml(r.nums, true) + '</td>' +
            '<td>' + ballsHtml([r.bonus], true) + '</td>' +
            '<td>' + r.sum + '</td><td>' + r.odd + ':' + r.even + '</td>' +
            '<td>' + r.low + ':' + r.high + '</td><td>' + r.ac + '</td>' +
            '<td>' + r.consecutive + '</td><td>' + r.carry + '</td></tr>';
        }).join('') + '</tbody></table>');
    }

    setHtml('db-pager',
      '<button class="btn small" data-action="db-prev" ' + (state.dbPage === 0 ? 'disabled' : '') + '>이전</button>' +
      '<span>' + (state.dbPage + 1) + ' / ' + pages + ' 페이지 · 총 ' + rows.length + '회</span>' +
      '<button class="btn small" data-action="db-next" ' + (state.dbPage >= pages - 1 ? 'disabled' : '') + '>다음</button>');
  }

  /* ---------- 저장된 조합함 ---------- */

  function renderSaved() {
    // 사이드바 배지: 저장된 조합 개수
    var badge = $('nav-saved-count');
    if (badge) {
      badge.textContent = String(state.saved.length);
      badge.hidden = state.saved.length === 0;
    }
    if (!state.saved.length) {
      setHtml('saved-list', '<div class="empty"><strong>저장된 조합이 없습니다</strong>' +
        '<p>대시보드에서 추천 조합을 만든 뒤 [조합 저장]을 눌러 보관하세요.</p></div>');
      return;
    }
    setHtml('saved-list', state.saved.map(function (s) {
      return '<div class="saved-item">' +
        '<div class="balls">' + ballsHtml(s.nums) + '</div>' +
        '<div class="saved-meta"><div><b>적합도 ' + s.score + '점</b> <span class="muted">' + esc(s.savedAt) + '</span></div>' +
          '<div class="tags">' + s.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div></div>' +
        '<div class="actions">' +
          '<button class="btn small" data-action="open-sim" data-id="' + esc(s.id) + '">백테스트</button>' +
          '<button class="btn small danger" data-action="del-saved" data-id="' + esc(s.id) + '">삭제</button>' +
        '</div></div>';
    }).join(''));
  }

  /* ---------- 이벤트 ---------- */

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-view],[data-action],[data-num],[data-mode],[data-remove]');
      if (!t || t.disabled) return;

      if (t.hasAttribute('data-view')) return setView(t.getAttribute('data-view'));
      if (t.hasAttribute('data-mode')) {
        state.pickerMode = t.getAttribute('data-mode');
        return renderFilterPanel();
      }
      if (t.hasAttribute('data-num')) return toggleNum(Number(t.getAttribute('data-num')));
      if (t.hasAttribute('data-remove')) {
        var list = t.getAttribute('data-remove') === 'fixed' ? state.filter.fixed : state.filter.exclude;
        var v = Number(t.getAttribute('data-value'));
        var i = list.indexOf(v);
        if (i >= 0) list.splice(i, 1);
        return renderFilterPanel();
      }

      var action = t.getAttribute('data-action');
      switch (action) {
        case 'generate':
          return runGenerate();
        case 'apply-filter':
          closeSheet();
          return runGenerate();
        case 'open-sheet':
          return openSheet();
        case 'close-sheet':
          return closeSheet();
        case 'reset-filter':
          return resetFilter();
        case 'select-cand':
          state.selectedIdx = Number(t.getAttribute('data-idx'));
          renderRecommendation();
          renderCandidates();
          return renderStatTests();
        case 'run-wf':
          return runWalkForward();
        case 'run-pipeline':
          return runPipeline();
        case 'install-app':
          return installApp();
        case 'open-license':
          return showSetup();
        case 'license-accept':
          if (hasAcceptedLicense()) return hideSetup();
          if (!$('setup-agree').checked) return;
          try {
            window.localStorage.setItem(LICENSE_KEY, LICENSE_VERSION);
          } catch (err) {
            toast('브라우저 저장소에 동의 기록을 남길 수 없습니다.');
          }
          hideSetup();
          return toast('설치가 완료되었습니다. 분석을 시작하세요.');
        case 'save':
          return saveCurrent();
        case 'backtest': {
          var sel = currentSelection();
          if (sel) openSimulator(sel.nums);
          return;
        }
        case 'sim-run':
          return runSimulation();
        case 'sim-load-current': {
          var cur = currentSelection();
          if (!cur) return toast('불러올 추천 조합이 없습니다.');
          $('sim-input').value = cur.nums.join(', ');
          return runSimulation();
        }
        case 'open-sim': {
          var item = state.saved.filter(function (s) { return s.id === t.getAttribute('data-id'); })[0];
          if (item) openSimulator(item.nums);
          return;
        }
        case 'del-saved':
          state.saved = state.saved.filter(function (s) { return s.id !== t.getAttribute('data-id'); });
          persistSaved();
          renderSaved();
          return toast('조합을 삭제했습니다.');
        case 'clear-saved':
          if (!state.saved.length) return;
          if (!window.confirm('저장된 조합을 모두 삭제할까요?')) return;
          state.saved = [];
          persistSaved();
          renderSaved();
          return toast('조합함을 비웠습니다.');
        case 'db-prev':
          state.dbPage--;
          return renderDb();
        case 'db-next':
          state.dbPage++;
          return renderDb();
      }
    });

    // 필터 입력 변경 (select / number)
    document.addEventListener('change', function (e) {
      if (e.target.id === 'db-file' && e.target.files && e.target.files[0]) {
        return importCsv(e.target.files[0]);
      }
      if (e.target.id && e.target.id.indexOf('bd-') === 0) {
        return renderBudget();
      }
      if (e.target.hasAttribute && e.target.hasAttribute('data-sc')) {
        state.selfCheck[Number(e.target.getAttribute('data-sc'))] = e.target.checked;
        return renderSelfCheck();
      }
      if (e.target.id === 'setup-agree') {
        $('setup-start').disabled = !e.target.checked && !hasAcceptedLicense();
        return;
      }
      if (e.target.id === 'f-seed') {
        var raw = e.target.value.trim();
        state.seed = raw === '' || !Number.isFinite(Number(raw)) ? null : Math.floor(Number(raw));
        return;
      }
      var key = e.target.getAttribute && e.target.getAttribute('data-filter');
      if (!key) return;
      var v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state.filter[key] = v;
      renderFilterPanel();
    });

    // 예산 입력은 타이핑하는 동안에도 바로 계산한다
    document.addEventListener('input', function (e) {
      if (e.target.id && e.target.id.indexOf('bd-') === 0) renderBudget();
    });

    $('db-search').addEventListener('input', function (e) {
      state.dbQuery = e.target.value;
      state.dbPage = 0;
      renderDb();
    });

    $('sim-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runSimulation();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
