/**
 * 로또 통계 분석 엔진 (UI와 분리된 순수 로직)
 *
 * - 회차별 지표 계산 (합계, 홀짝, 고저, AC값, 이월수, 연속번호)
 * - 1차 필터링 (고정수/제외수/홀짝/합계/AC 조건)
 * - 번호 가중치(단기 추세 + 평균 회귀) 및 조합 적합도 스코어(0~100)
 * - 과거 회차 백테스트 (일치 번호 개수 집계)
 *
 * 브라우저에서는 window.LottoEngine, Node에서는 module.exports로 사용합니다.
 * 모든 결과는 과거 데이터의 통계 지표이며, 당첨 번호를 예측하거나 확정하지 않습니다.
 */
(function (root) {
  'use strict';

  const MAX_NUM = 45;
  const PICK = 6;
  const ALL_NUMS = Array.from({ length: MAX_NUM }, (_, i) => i + 1);
  const SUM_MIN = 21;   // 1~45 중 6개를 뽑았을 때의 이론적 최소 합
  const SUM_MAX = 255;  // 이론적 최대 합
  const LOW_MAX = 22;   // 저(1~22) / 고(23~45) 경계
  const NUMBER_WEIGHT = 0.6;   // 적합도 = 번호 가중치 60% + 패턴 일치 40%
  const PATTERN_WEIGHT = 0.4;

  const BANDS = [
    { label: '1–9', from: 1, to: 9 },
    { label: '10–19', from: 10, to: 19 },
    { label: '20–29', from: 20, to: 29 },
    { label: '30–39', from: 30, to: 39 },
    { label: '40–45', from: 40, to: 45 },
  ];

  const DEFAULTS = {
    trendWindow: 20,   // 단기 추세로 볼 최근 회차 수
    trendWeight: 0.5,  // 번호 가중치 중 단기 추세 비율 (나머지는 평균 회귀)
    maxAttempts: 200000, // 전수 탐색 한도 / 무작위 샘플링 최대 시도 수
    poolLimit: 3000,   // 조건을 통과한 후보를 이 개수까지만 수집
    topN: 5,           // 화면에 표시할 상위 후보 수
  };

  /* ---------- 공통 유틸 ---------- */

  function sortAsc(arr) {
    return [...arr].sort((a, b) => a - b);
  }

  function mean(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  }

  function std(arr) {
    const m = mean(arr);
    return Math.sqrt(mean(arr.map(v => (v - m) * (v - m))));
  }

  // 값 배열을 0~1로 정규화 (모든 값이 같으면 0.5)
  function minMax(values) {
    if (values.length === 0) return [];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    return values.map(v => (span === 0 ? 0.5 : (v - min) / span));
  }

  // n개 중 k개를 고르는 경우의 수 (반올림된 정수)
  function combinations(n, k) {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }

  // pool에서 k개를 고르는 모든 조합을 순회 (k=0이면 빈 조합 1회)
  function enumerateCombos(pool, k, visit) {
    const n = pool.length;
    if (k === 0) {
      visit([]);
      return;
    }
    const idx = Array.from({ length: k }, (_, i) => i);
    for (;;) {
      visit(idx.map(i => pool[i]));
      let i = k - 1;
      while (i >= 0 && idx[i] === n - k + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
  }

  // Fisher-Yates 방식으로 pool에서 k개를 비복원 추출
  function sampleWithoutReplacement(pool, k, rng) {
    const a = pool.slice();
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (a.length - i));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a.slice(0, k);
  }

  /* ---------- 검증 ---------- */

  // 한 회차(또는 조합)의 번호 6개가 올바른지 검사. 문제가 없으면 null, 있으면 안내 문구 반환
  function validateCombo(nums) {
    if (!Array.isArray(nums) || nums.length !== PICK) {
      return `번호는 ${PICK}개여야 합니다.`;
    }
    if (!nums.every(n => Number.isInteger(n) && n >= 1 && n <= MAX_NUM)) {
      return '번호는 1~45 사이의 정수여야 합니다.';
    }
    if (new Set(nums).size !== PICK) {
      return '중복된 번호가 있습니다.';
    }
    return null;
  }

  // 회차 데이터 전체 검증 (회차 오름차순, 번호/보너스 유효성)
  function validateDraws(draws) {
    const errors = [];
    if (!Array.isArray(draws) || draws.length === 0) {
      return ['회차 데이터가 없습니다. data/draws.js를 확인해 주세요.'];
    }
    let prev = -Infinity;
    draws.forEach((d, i) => {
      if (!d || !Number.isInteger(d.round)) {
        errors.push(`${i + 1}번째 항목의 회차 번호가 올바르지 않습니다.`);
        return;
      }
      const tag = `${d.round}회차`;
      if (d.round <= prev) errors.push(`${tag}: 회차는 오름차순이어야 합니다.`);
      prev = d.round;
      const err = validateCombo(d.nums);
      if (err) errors.push(`${tag}: ${err}`);
      if (!Number.isInteger(d.bonus) || d.bonus < 1 || d.bonus > MAX_NUM ||
          (Array.isArray(d.nums) && d.nums.includes(d.bonus))) {
        errors.push(`${tag}: 보너스 번호가 올바르지 않습니다.`);
      }
      // 당첨금 정보는 선택 사항이며, 있으면 등수 5개 × [금액, 인원] 형식이어야 한다
      if (d.prizes !== undefined && (!Array.isArray(d.prizes) || d.prizes.length !== 5)) {
        errors.push(`${tag}: 당첨금 정보는 5개 등수 배열이어야 합니다.`);
      }
    });
    return errors;
  }

  // CSV 텍스트를 회차 데이터로 변환. 형식: round,n1,n2,n3,n4,n5,n6,bonus (헤더 행은 자동 생략)
  function parseDrawsCsv(text) {
    const draws = [];
    const errors = [];
    String(text).split(/\r?\n/).forEach((line, i) => {
      const row = line.trim();
      if (!row || row.startsWith('#')) return;
      const cells = row.split(',').map(s => s.trim());
      if (!/^\d+$/.test(cells[0] || '')) return; // 헤더(round 등) 생략
      if (cells.length !== 8) {
        errors.push(`${i + 1}행: 열 개수는 8개(회차,번호6개,보너스)여야 합니다.`);
        return;
      }
      const vals = cells.map(Number);
      draws.push({ round: vals[0], nums: vals.slice(1, 7), bonus: vals[7] });
    });
    draws.sort((a, b) => a.round - b.round);
    if (!errors.length && draws.length === 0) errors.push('읽을 수 있는 회차 행이 없습니다.');
    errors.push(...validateDraws(draws));
    return { draws, errors };
  }

  /* ---------- 회차별 지표 ---------- */

  // 한 조합의 지표 계산. prevNums(직전 회차)가 있으면 이월수를 계산
  function computeMetrics(nums, prevNums) {
    const n = sortAsc(nums);
    const sum = n.reduce((s, v) => s + v, 0);
    const odd = n.filter(v => v % 2 === 1).length;
    const low = n.filter(v => v <= LOW_MAX).length;

    // AC값: 모든 쌍 차이의 서로 다른 개수 - (k-1)
    const diffs = new Set();
    for (let i = 0; i < n.length; i++) {
      for (let j = i + 1; j < n.length; j++) diffs.add(n[j] - n[i]);
    }
    const ac = diffs.size - (n.length - 1);

    // 연속번호: 오름차순에서 바로 이웃한 쌍(차이 1) 개수
    let consecutive = 0;
    for (let i = 0; i < n.length - 1; i++) {
      if (n[i + 1] - n[i] === 1) consecutive++;
    }

    // 이월수: 직전 회차와 겹치는 번호 개수
    const carry = prevNums ? n.filter(v => prevNums.includes(v)).length : 0;

    return {
      sum,
      odd,
      even: n.length - odd,
      low,
      high: n.length - low,
      ac,
      consecutive,
      carry,
    };
  }

  // 회차 목록에 지표를 붙인다. 각 회차의 이월수는 바로 앞 회차 기준
  function analyzeDraws(draws) {
    return draws.map((d, idx) => ({
      round: d.round,
      nums: sortAsc(d.nums),
      bonus: d.bonus,
      ...computeMetrics(d.nums, idx > 0 ? draws[idx - 1].nums : null),
    }));
  }

  /* ---------- 통계 (번호 가중치 + 패턴 기준값) ---------- */

  function buildStats(draws, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const errors = validateDraws(draws);
    if (errors.length) throw new Error(errors[0]);

    const total = draws.length;
    const analyzed = analyzeDraws(draws);

    // 전체 출현 횟수
    const freq = new Array(MAX_NUM + 1).fill(0);
    draws.forEach(d => d.nums.forEach(v => { freq[v]++; }));

    // 최근 W회 출현 횟수 (단기 추세)
    const W = Math.min(cfg.trendWindow, total);
    const recent = new Array(MAX_NUM + 1).fill(0);
    draws.slice(total - W).forEach(d => d.nums.forEach(v => { recent[v]++; }));

    const expTotal = (total * PICK) / MAX_NUM; // 전체 기대 출현 횟수
    const expRecent = (W * PICK) / MAX_NUM;    // 최근 W회 기대 출현 횟수

    // 단기 추세: 최근 기대치 대비 비율이 높을수록 좋음
    const trendRaw = ALL_NUMS.map(v => recent[v] / expRecent);
    // 평균 회귀: 전체 평균보다 적게 나온 번호일수록 높은 값 (편차의 반대 부호)
    const revRaw = ALL_NUMS.map(v => -(freq[v] - expTotal) / expTotal);
    const trendN = minMax(trendRaw);
    const revN = minMax(revRaw);

    const trend = [0];
    const reversion = [0];
    const weight = [0];
    ALL_NUMS.forEach((v, i) => {
      trend[v] = trendN[i];
      reversion[v] = revN[i];
      weight[v] = cfg.trendWeight * trendN[i] + (1 - cfg.trendWeight) * revN[i];
    });

    // 패턴 기준값: 첫 회차는 이월수 기준이 없으므로 제외
    const body = analyzed.slice(1);
    const pick = key => {
      const vals = body.map(a => a[key]);
      return { mean: mean(vals), std: std(vals) };
    };
    const pattern = {
      sum: pick('sum'),
      odd: pick('odd'),
      ac: pick('ac'),
      consecutive: pick('consecutive'),
      carry: pick('carry'),
    };

    return {
      cfg,
      total,
      window: W,
      freq,
      recent,
      expTotal,
      expRecent,
      trend,
      reversion,
      weight,
      pattern,
      analyzed,
      draws,
      latestRound: draws[total - 1].round,
      latestNums: sortAsc(draws[total - 1].nums),
    };
  }

  /* ---------- 1차 필터 ---------- */

  function normalizeFilter(f) {
    const toNums = arr => [...new Set((arr || []).map(Number))]
      .filter(n => Number.isInteger(n) && n >= 1 && n <= MAX_NUM)
      .sort((a, b) => a - b);
    const num = (v, dflt) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : dflt);
    return {
      fixed: toNums(f.fixed),
      exclude: toNums(f.exclude),
      oddMin: num(f.oddMin, 0),
      oddMax: num(f.oddMax, PICK),
      sumMin: num(f.sumMin, SUM_MIN),
      sumMax: num(f.sumMax, SUM_MAX),
      minAC: num(f.minAC, 0),
    };
  }

  // 필터 조건 자체의 모순/불가능 여부 검사. 안내 문구 배열 반환
  function validateFilter(f) {
    const errors = [];

    const overlap = f.fixed.filter(n => f.exclude.includes(n));
    if (overlap.length) {
      errors.push(`고정수와 제외수에 겹치는 번호가 있습니다: ${overlap.join(', ')}`);
    }
    if (f.fixed.length > PICK) {
      errors.push(`고정수는 최대 ${PICK}개까지 선택할 수 있습니다.`);
    }

    const poolSize = ALL_NUMS.filter(n => !f.exclude.includes(n)).length;
    if (poolSize < PICK) {
      errors.push(`제외수가 너무 많아 6개 조합을 만들 수 없습니다 (사용 가능 번호 ${poolSize}개).`);
    }

    if (f.oddMin < 0 || f.oddMax > PICK || f.oddMin > f.oddMax) {
      errors.push('홀수 개수 범위를 확인해 주세요 (0~6, 최소 ≤ 최대).');
    }
    if (f.sumMin > f.sumMax || f.sumMin < SUM_MIN || f.sumMax > SUM_MAX) {
      errors.push(`번호 합계 범위를 확인해 주세요 (${SUM_MIN}~${SUM_MAX}, 최소 ≤ 최대).`);
    }
    if (f.minAC < 0 || f.minAC > 10) {
      errors.push('AC값 최소 조건은 0~10 사이여야 합니다.');
    }

    // 고정수의 홀짝 구성이 홀수 개수 조건과 양립하는지 확인
    const fixedOdd = f.fixed.filter(n => n % 2 === 1).length;
    const fixedEven = f.fixed.length - fixedOdd;
    if (fixedOdd > f.oddMax || fixedEven > PICK - f.oddMin) {
      errors.push('고정수의 홀짝 구성이 홀수 개수 조건과 맞지 않아 후보를 만들 수 없습니다.');
    }
    return errors;
  }

  function passesFilter(m, f) {
    return m.odd >= f.oddMin && m.odd <= f.oddMax &&
      m.sum >= f.sumMin && m.sum <= f.sumMax &&
      m.ac >= f.minAC;
  }

  /* ---------- 스코어링 ---------- */

  // 값이 역대 평균에 가까울수록 1에 가까운 가우시안 형태의 적합도 (표준편차는 최소 1로 보정)
  function gaussFit(value, stat) {
    const sd = Math.max(stat.std, 1);
    const z = (value - stat.mean) / sd;
    return Math.exp(-0.5 * z * z);
  }

  function patternFitOf(m, pattern) {
    return mean([
      gaussFit(m.sum, pattern.sum),
      gaussFit(m.odd, pattern.odd),
      gaussFit(m.ac, pattern.ac),
      gaussFit(m.consecutive, pattern.consecutive),
      gaussFit(m.carry, pattern.carry),
    ]);
  }

  // 근거 태그 생성 (화면에 "선정 근거"로 표시)
  function makeTags(candidate, stats, filter) {
    const m = candidate.metrics;
    const tags = [];
    if (candidate.nums.some(n => stats.trend[n] >= 0.7)) tags.push('단기 추세 번호 포함');
    if (candidate.nums.some(n => stats.reversion[n] >= 0.7)) tags.push('평균 회귀 대상 번호 포함');

    const s = stats.pattern.sum;
    if (Math.abs(m.sum - s.mean) <= s.std) tags.push('합계 역대 평균 구간');
    if (m.odd >= 2 && m.odd <= 4) tags.push(`홀짝 균형 (홀수 ${m.odd}개)`);
    if (m.ac >= Math.round(stats.pattern.ac.mean)) tags.push(`AC값 ${m.ac} (역대 평균 이상)`);
    tags.push(m.consecutive === 0 ? '연속번호 없음' : `연속번호 ${m.consecutive}쌍`);
    if (m.carry >= 1 && m.carry <= 2) tags.push(`직전 회차 이월수 ${m.carry}개`);
    if (filter.fixed.length) tags.push(`고정수 ${filter.fixed.length}개 반영`);
    return tags;
  }

  function scoreCandidates(list, stats, filter) {
    const rawNumberFit = list.map(c => mean(c.nums.map(n => stats.weight[n])));
    // 번호 가중치 점수는 후보군 내 상대값(0~1)으로 정규화
    const relNumberFit = minMax(rawNumberFit);
    return list.map((c, i) => {
      const patternFit = patternFitOf(c.metrics, stats.pattern);
      const score = Math.round(100 * (NUMBER_WEIGHT * relNumberFit[i] + PATTERN_WEIGHT * patternFit));
      return Object.assign({}, c, {
        score,
        numberFit: relNumberFit[i],
        patternFit,
        tags: makeTags(c, stats, filter),
      });
    });
  }

  /* ---------- 후보 생성 ---------- */

  // 조건을 만족하는 후보 조합을 찾고 점수순으로 정렬해 상위 N개를 반환
  function generateCandidates(rawFilter, stats, options) {
    const cfg = Object.assign({}, stats.cfg, options || {});
    // 시드를 주면 같은 조건에서 항상 같은 후보가 나온다 (재현성)
    const rng = cfg.rng || (cfg.seed !== undefined && cfg.seed !== null ? makeRng(cfg.seed) : Math.random);
    const f = normalizeFilter(rawFilter);
    const errors = validateFilter(f);
    if (errors.length) {
      return { ok: false, errors, warnings: [], candidates: [], totalFound: 0, attempts: 0, method: null, poolSize: 0 };
    }

    const pool = ALL_NUMS.filter(n => !f.exclude.includes(n) && !f.fixed.includes(n));
    const need = PICK - f.fixed.length;
    const space = combinations(pool.length, need);

    const found = [];
    const seen = new Set();
    const accept = picked => {
      const combo = sortAsc(f.fixed.concat(picked));
      const key = combo.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      const metrics = computeMetrics(combo, stats.latestNums);
      if (passesFilter(metrics, f)) found.push({ nums: combo, metrics });
    };

    let method;
    let attempts = 0;
    if (space <= cfg.maxAttempts) {
      // 조합 공간이 작으면 전수 탐색 (누락 없이 정확)
      method = 'exhaustive';
      enumerateCombos(pool, need, picked => {
        attempts++;
        accept(picked);
      });
    } else {
      // 공간이 크면 무작위 샘플링 (시도 횟수와 수집 상한으로 제한)
      method = 'sampling';
      while (attempts < cfg.maxAttempts && found.length < cfg.poolLimit) {
        attempts++;
        accept(sampleWithoutReplacement(pool, need, rng));
      }
    }

    const warnings = [];
    if (found.length === 0) {
      warnings.push('조건을 만족하는 조합을 찾지 못했습니다. 합계 범위를 넓히거나, AC값 최소를 낮추거나, 제외수를 줄여 보세요.');
    } else if (found.length < cfg.topN) {
      warnings.push(`조건을 만족하는 후보가 ${found.length}개뿐입니다. 조건을 조금 완화하면 더 많은 후보를 볼 수 있습니다.`);
    }
    if (method === 'sampling' && found.length >= cfg.poolLimit) {
      warnings.push(`후보가 상한(${cfg.poolLimit.toLocaleString()}개)에 도달해 앞서 찾은 후보 기준으로 정렬했습니다.`);
    }

    const scored = scoreCandidates(found, stats, f)
      .sort((a, b) => b.score - a.score || b.numberFit - a.numberFit);

    return {
      ok: true,
      errors: [],
      warnings,
      candidates: scored.slice(0, cfg.topN),
      totalFound: found.length,
      attempts,
      method,
      poolSize: pool.length,
      space,
    };
  }

  /* ---------- 백테스트 ---------- */

  // 조합을 과거 회차에 대입해 일치 번호 개수를 집계
  function backtest(nums, draws) {
    const err = validateCombo(nums);
    if (err) throw new Error(err);
    const combo = new Set(nums);
    const dist = [0, 0, 0, 0, 0, 0, 0];
    let bonusHits = 0;
    let sum = 0;
    const rows = draws.map(d => {
      const match = d.nums.filter(v => combo.has(v)).length;
      const bonusHit = match === 5 && combo.has(d.bonus);
      dist[match]++;
      sum += match;
      if (bonusHit) bonusHits++;
      return { round: d.round, match, bonusHit };
    });
    const total = draws.length;
    const best = rows.reduce((b, r) => Math.max(b, r.match), 0);
    return {
      total,
      dist,
      avgMatch: total ? sum / total : 0,
      expectedMatch: (PICK * PICK) / MAX_NUM, // 무작위 조합의 이론적 기대 일치 개수
      atLeast3: dist[3] + dist[4] + dist[5] + dist[6],
      best,
      bestRounds: rows.filter(r => r.match === best).map(r => r.round).slice(-5),
      // 번호 일치 기준 분류 (당첨금 계산 아님)
      rankCounts: {
        '6개 일치': dist[6],
        '5개+보너스': bonusHits,
        '5개 일치': dist[5] - bonusHits,
        '4개 일치': dist[4],
        '3개 일치': dist[3],
      },
      recent: rows.slice(-10).reverse(),
    };
  }

  /* ---------- 번호대 분포 ---------- */

  function bandDistribution(draws, recentN) {
    const recentDraws = draws.slice(Math.max(0, draws.length - recentN));
    const countIn = list => BANDS.map(b => {
      let c = 0;
      list.forEach(d => d.nums.forEach(n => { if (n >= b.from && n <= b.to) c++; }));
      return c;
    });
    const all = countIn(draws);
    const rec = countIn(recentDraws);
    const allTotal = draws.length * PICK;
    const recTotal = recentDraws.length * PICK;
    return BANDS.map((b, i) => {
      const size = b.to - b.from + 1;
      return {
        label: b.label,
        allPct: allTotal ? (all[i] / allTotal) * 100 : 0,
        recentPct: recTotal ? (rec[i] / recTotal) * 100 : 0,
        expectedPct: (size / MAX_NUM) * 100,
      };
    });
  }

  /* ---------- 재현 가능한 난수 / 통계 검정 ---------- */

  // 시드 기반 난수 생성기 (같은 시드 → 같은 결과)
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 로그 감마 함수 (Lanczos 근사)
  function lgamma(z) {
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61503916999385, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    const zz = z - 1;
    let x = c[0];
    for (let i = 1; i < 9; i++) x += c[i] / (zz + i);
    const t = zz + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
  }

  // 정규화된 상측 불완전 감마 함수 Q(a, x) = 1 - P(a, x)
  function gammaQ(a, x) {
    if (x <= 0) return 1;
    const gln = lgamma(a);
    if (x < a + 1) {
      let ap = a;
      let sum = 1 / a;
      let del = sum;
      for (let n = 0; n < 1000; n++) {
        ap += 1;
        del *= x / ap;
        sum += del;
        if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
      }
      return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
    }
    let b = x + 1 - a;
    let c = 1 / 1e-300;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < 1000; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c;
      if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    return Math.exp(-x + a * Math.log(x) - gln) * h;
  }

  // 양측 검정 p-value (표준정규 근사, erfc 근사식 사용)
  function normalTwoSidedP(z) {
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.5 * x);
    const erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
      t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
      t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return Math.min(1, erfc);
  }

  // 번호 1~45 출현 빈도가 균등한지 검정 (카이제곱 적합도, 자유도 44)
  function chiSquareUniformity(freq) {
    const counts = freq.slice(1, MAX_NUM + 1);
    const total = counts.reduce((s, v) => s + v, 0);
    const expected = total / MAX_NUM;
    const chi2 = counts.reduce((s, o) => s + ((o - expected) * (o - expected)) / expected, 0);
    const df = MAX_NUM - 1;
    return { chi2, df, pValue: gammaQ(df / 2, chi2 / 2), total, expected };
  }

  // 워크포워드 검증: 각 회차 직전까지의 데이터만으로 상위 k개 번호를 고르고,
  // 다음 회차와 몇 개 맞았는지 집계한다. 무작위 기대치와의 차이를 z-검정으로 본다.
  function walkForwardSignal(draws, options) {
    const cfg = Object.assign({ minTrain: 100, k: PICK }, options || {});
    const matches = [];
    for (let r = cfg.minTrain; r < draws.length; r++) {
      const st = buildStats(draws.slice(0, r), { trendWindow: cfg.trendWindow || DEFAULTS.trendWindow });
      const top = ALL_NUMS.slice()
        .sort((a, b) => st.weight[b] - st.weight[a] || a - b)
        .slice(0, cfg.k);
      matches.push(draws[r].nums.filter(v => top.includes(v)).length);
    }
    const n = matches.length;
    const m = mean(matches);
    const k = cfg.k;
    const expected = (PICK * k) / MAX_NUM;
    // 초기하분포 분산 (모집단 45, 성공 k, 표본 6)
    const variance = PICK * (k / MAX_NUM) * ((MAX_NUM - k) / MAX_NUM) * ((MAX_NUM - PICK) / (MAX_NUM - 1));
    const z = n ? (m - expected) / Math.sqrt(variance / n) : 0;
    const sd = std(matches);
    return {
      n,
      mean: m,
      sd,
      expected,
      ci95: confidenceInterval(m, sd, n),
      z,
      pValue: normalTwoSidedP(z),
    };
  }

  // 무작위 조합 중 번호 가중치 평균이 이 조합 이상인 비율 (작을수록 무작위보다 높은 쪽)
  function randomBaselinePercentile(stats, nums, options) {
    const samples = (options && options.samples) || 20000;
    const rng = makeRng((options && options.seed) || 12345);
    const target = mean(nums.map(n => stats.weight[n]));
    let atLeast = 0;
    for (let s = 0; s < samples; s++) {
      const picked = sampleWithoutReplacement(ALL_NUMS, PICK, rng);
      if (mean(picked.map(n => stats.weight[n])) >= target) atLeast++;
    }
    return { fraction: atLeast / samples, samples };
  }

  // 회차 번호 연속성 점검: 최소~최대 사이에서 빠진 회차 목록
  function findMissingRounds(draws) {
    if (!draws.length) return [];
    const have = new Set(draws.map(d => d.round));
    const missing = [];
    const min = draws[0].round;
    const max = draws[draws.length - 1].round;
    for (let r = min; r <= max; r++) if (!have.has(r)) missing.push(r);
    return missing;
  }

  /* ---------- 1) 정확한 당첨 확률 ---------- */

  const TICKET_PRICE = 1000; // 1장 가격(원)
  const RANK_LABELS = ['1등 (6개 일치)', '2등 (5개 + 보너스)', '3등 (5개 일치)', '4등 (4개 일치)', '5등 (3개 일치)'];

  // 한 장(6개 번호) 기준 등수별 정확한 확률. 분모는 C(45,6)=8,145,060
  function rankProbabilities() {
    const total = combinations(MAX_NUM, PICK);
    const counts = [
      1,                                              // 6개 일치
      combinations(6, 5) * 1,                         // 5개 일치 + 보너스 = 나머지 1개가 보너스
      combinations(6, 5) * (combinations(39, 1) - 1), // 5개 일치, 보너스 아님
      combinations(6, 4) * combinations(39, 2),       // 4개 일치
      combinations(6, 3) * combinations(39, 3),       // 3개 일치
    ];
    return counts.map((count, i) => ({
      rank: i + 1,
      label: RANK_LABELS[i],
      count,
      prob: count / total,
      oneIn: total / count,
    }));
  }

  // 주 1회 추첨 기준: N주 동안 해당 등수 이상이 한 번이라도 나올 확률 (독립 가정)
  function atLeastOnce(prob, weeks) {
    return 1 - Math.pow(1 - prob, weeks);
  }

  /* ---------- 2) 기대 수익 (실제 등수별 당첨금 평균 사용) ---------- */

  // 회차 데이터의 prizes([[금액, 인원], ...]) 로 등수별 1인당 평균 당첨금을 계산
  // 당첨자가 없었던 회차는 평균에서 제외한다.
  function averagePrizes(draws) {
    const sums = [0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0];
    let used = 0;
    draws.forEach(d => {
      if (!Array.isArray(d.prizes)) return;
      used++;
      d.prizes.forEach((p, i) => {
        if (!p || p[0] === null || p[0] === undefined || !p[1]) return;
        sums[i] += p[0];
        counts[i]++;
      });
    });
    return {
      used,
      average: sums.map((s, i) => (counts[i] ? s / counts[i] : null)),
    };
  }

  // 1장당 기대 수익: sum(등수별 확률 × 평균 당첨금)
  function expectedReturn(draws) {
    const probs = rankProbabilities();
    const { used, average } = averagePrizes(draws);
    if (!used) {
      return { available: false, message: '당첨금 데이터가 없습니다. 등수별 당첨금 정보가 포함된 회차 데이터를 불러오세요.' };
    }
    const rows = probs.map((p, i) => {
      const avg = average[i];
      const ev = avg === null ? 0 : p.prob * avg;
      return { rank: p.rank, label: p.label, prob: p.prob, oneIn: p.oneIn, avgPrize: avg, ev };
    });
    const ev = rows.reduce((s, r) => s + r.ev, 0);
    return {
      available: true,
      rows,
      ev,
      price: TICKET_PRICE,
      returnRate: ev / TICKET_PRICE,
      expectedLoss: TICKET_PRICE - ev,
      sampleRounds: used,
    };
  }

  /* ---------- 3) 신뢰도: 신뢰구간과 필터 깔때기 ---------- */

  // 워크포워드 결과의 95% 신뢰구간 (정규 근사)
  function confidenceInterval(mean, sd, n) {
    const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
    return [mean - half, mean + half];
  }

  // 필터 단계별 통과율 추정 (무작위 표본 기반). 단계는 누적 적용.
  function filterFunnel(rawFilter, options) {
    const f = normalizeFilter(rawFilter);
    const samples = (options && options.samples) || 100000;
    const rng = makeRng((options && options.seed) || 2026);
    const stages = [
      { key: 'all', label: '전체 무작위 조합', pass: 0 },
      { key: 'include', label: '고정수 포함 · 제외수 배제', pass: 0 },
      { key: 'odd', label: '홀수 개수 조건', pass: 0 },
      { key: 'sum', label: '합계 범위', pass: 0 },
      { key: 'ac', label: 'AC값 최소', pass: 0 },
    ];
    for (let s = 0; s < samples; s++) {
      const combo = sampleWithoutReplacement(ALL_NUMS, PICK, rng).sort((a, b) => a - b);
      stages[0].pass++;
      if (!f.fixed.every(n => combo.includes(n)) || combo.some(n => f.exclude.includes(n))) continue;
      stages[1].pass++;
      const m = computeMetrics(combo, null);
      if (m.odd < f.oddMin || m.odd > f.oddMax) continue;
      stages[2].pass++;
      if (m.sum < f.sumMin || m.sum > f.sumMax) continue;
      stages[3].pass++;
      if (m.ac < f.minAC) continue;
      stages[4].pass++;
    }
    return {
      samples,
      stages: stages.map(st => ({ label: st.label, count: st.pass, pct: (st.pass / samples) * 100 })),
      finalPct: (stages[4].pass / samples) * 100,
    };
  }

  /* ---------- 5) 추천 파이프라인 워크포워드 ---------- */

  // 과거 시점마다 같은 방식으로 추천 조합 1개를 만들고, 다음 회차와 일치 개수를 집계한다.
  // 비용 때문에 step 간격으로 회차를 건너뛰며 평가한다.
  function walkForwardPipeline(draws, filter, options) {
    const cfg = Object.assign({ minTrain: 100, step: 5, attempts: 4000 }, options || {});
    const matches = [];
    for (let r = cfg.minTrain; r < draws.length; r += cfg.step) {
      const st = buildStats(draws.slice(0, r), { trendWindow: DEFAULTS.trendWindow });
      const res = generateCandidates(filter, st, {
        maxAttempts: cfg.attempts,
        poolLimit: 300,
        topN: 1,
        seed: r,
      });
      if (!res.ok || !res.candidates.length) continue;
      const pick = res.candidates[0].nums;
      matches.push(draws[r].nums.filter(v => pick.includes(v)).length);
    }
    const n = matches.length;
    const m = mean(matches);
    const sd = std(matches);
    const expected = (PICK * PICK) / MAX_NUM;
    const z = n > 1 && sd > 0 ? (m - expected) / (sd / Math.sqrt(n)) : 0;
    return {
      n,
      mean: m,
      sd,
      expected,
      ci95: confidenceInterval(m, sd, n),
      z,
      pValue: normalTwoSidedP(z),
      step: cfg.step,
    };
  }

  /* ---------- 4) 예산 보호 ---------- */

  // 주간 구매 계획의 예산과 기대 손실 계산
  function budgetPlan(opts) {
    const ev = opts.evPerTicket || 0;
    const tickets = Math.max(0, Math.floor(opts.ticketsPerWeek || 0));
    const weeks = Math.max(0, Math.floor(opts.weeks || 0));
    const totalTickets = tickets * weeks;
    const cost = totalTickets * TICKET_PRICE;
    const expectedReturn = totalTickets * ev;
    return {
      totalTickets,
      cost,
      expectedReturn,
      expectedLoss: cost - expectedReturn,
      budget: opts.budget,
      overBudget: opts.budget !== undefined && cost > opts.budget,
      remaining: opts.budget === undefined ? null : opts.budget - cost,
    };
  }

  // 자가 점검: 응답 개수에 따라 안내 수준을 정한다 (0 = 안내 없음, 1 = 주의, 2 이상 = 상담 권장)
  const SELF_CHECK_QUESTIONS = [
    '손실을 만회하려고 복권을 더 구매한 적이 있다',
    '정해 둔 예산을 넘겨서 구매한 적이 있다',
    '생활비나 빚으로 복권을 구매한 적이 있다',
    '구매를 줄이려고 해도 잘 되지 않는다',
  ];
  function selfCheckLevel(answers) {
    const yes = (answers || []).filter(Boolean).length;
    if (yes === 0) return { level: 0, yes };
    return { level: yes >= 2 ? 2 : 1, yes };
  }

  const LottoEngine = {
    MAX_NUM,
    PICK,
    SUM_MIN,
    SUM_MAX,
    LOW_MAX,
    BANDS,
    DEFAULTS,
    validateCombo,
    validateDraws,
    parseDrawsCsv,
    computeMetrics,
    analyzeDraws,
    buildStats,
    normalizeFilter,
    validateFilter,
    passesFilter,
    generateCandidates,
    backtest,
    bandDistribution,
    combinations,
    enumerateCombos,
    makeRng,
    gammaQ,
    normalTwoSidedP,
    chiSquareUniformity,
    walkForwardSignal,
    randomBaselinePercentile,
    findMissingRounds,
    TICKET_PRICE,
    RANK_LABELS,
    rankProbabilities,
    atLeastOnce,
    averagePrizes,
    expectedReturn,
    confidenceInterval,
    filterFunnel,
    walkForwardPipeline,
    budgetPlan,
    SELF_CHECK_QUESTIONS,
    selfCheckLevel,
  };

  root.LottoEngine = LottoEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = LottoEngine;
})(typeof window !== 'undefined' ? window : globalThis);
