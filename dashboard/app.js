// Sentinel-X · centre de commandement (JS natif, aucune dependance externe).
// Contrat d'API : docs/API.md
'use strict';

const $ = (id) => document.getElementById(id);
const WINDOW_MS = 5 * 60 * 1000;   // fenetre des graphiques
const RECENT_MS = 60 * 1000;       // une alerte compte dans le niveau de menace pendant 1 min
const HOUR_MS = 60 * 60 * 1000;
const MIN_TRAIN = 60;              // cf. server/api/app/ml.py
const css = getComputedStyle(document.documentElement);
const C = Object.fromEntries(['acc', 'ok', 'warn', 'bad', 'temp', 'hum', 'gas', 'ai', 'mut', 'dim', 'fg']
  .map((k) => [k, css.getPropertyValue('--' + k).trim()]));
const MONO = css.getPropertyValue('--mono');

const LABELS = {
  type: { intrusion: 'Intrusion détectée', anomaly: 'Anomalie capteurs', motion: 'Mouvement détecté',
    unknown_face: 'Visage inconnu', access: 'Accès autorisé' },
  source: { vision: 'Vision', ml: 'IA', esp8266: 'Boîtier' },
  sev: { info: 'Info', medium: 'Moyenne', high: 'Haute', critical: 'Critique' },
};

const state = {
  key: '',
  ws: null,
  wsOpen: false,
  stopped: true,
  history: [],          // {t, temp, hum, gas, motion, score, anomaly}
  alerts: [],           // plus recentes d'abord
  liveSamples: 0,
  lastTelemetry: 0,
  lastMotion: 0,
  modelReady: false,
  mqtt: null,
  apiUp: null,
  anomaly: false,
  motion: false,
  camOn: false,
  muted: false,
  filter: { source: '', sev: '' },
  device: { buzzer: false, led: 'off' },
};

// ---------- utilitaires ----------
const pad2 = (n) => String(n).padStart(2, '0');
const hms = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmt = (v, n = 1) => (v == null || Number.isNaN(v) ? '--' : Number(v).toFixed(n));
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function store(kind, k, v) {
  try { v == null ? window[kind].removeItem(k) : window[kind].setItem(k, v); } catch { /* stockage indisponible */ }
}
function load(kind, k) {
  try { return window[kind].getItem(k); } catch { return null; }
}

// ---------- graphiques canvas ----------
class LineChart {
  constructor(canvas, opts) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.o = opts;
    this.mx = null;
    if (!opts.mini) {
      canvas.addEventListener('mousemove', (e) => { this.mx = e.offsetX; this.draw(); });
      canvas.addEventListener('mouseleave', () => { this.mx = null; this.draw(); });
    }
  }

  fit() {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width), h = Math.round(r.height);
    if (this.c.width !== w * dpr || this.c.height !== h * dpr) {
      this.c.width = w * dpr;
      this.c.height = h * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  draw() {
    const { w, h } = this.fit();
    if (!w || !h) return;
    const { ctx, o } = this;
    const mini = !!o.mini;
    ctx.clearRect(0, 0, w, h);

    const t1 = Date.now(), t0 = t1 - WINDOW_MS;
    const pts = state.history.filter((p) => p.t >= t0 - 5000);
    const hasRight = o.series.some((s) => s.axis === 'r');
    const pad = mini ? { l: 1, r: 1, t: 5, b: 2 } : { l: 42, r: hasRight ? 42 : 14, t: 10, b: 22 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * iw;

    // echelles (une par axe)
    const axes = {};
    for (const ax of ['l', 'r']) {
      const vals = [];
      o.series.filter((s) => (s.axis || 'l') === ax).forEach((s) => pts.forEach((p) => p[s.key] != null && vals.push(p[s.key])));
      if (!vals.length) { axes[ax] = { lo: 0, hi: 1, empty: true }; continue; }
      let lo = Math.min(...vals), hi = Math.max(...vals);
      if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      const span = hi - lo || Math.max(Math.abs(hi) * 0.1, 1);
      axes[ax] = { lo: lo - span * (mini ? 0.12 : 0.18), hi: hi + span * (mini ? 0.12 : 0.18) };
    }
    const Y = (v, ax = 'l') => pad.t + (1 - (v - axes[ax].lo) / (axes[ax].hi - axes[ax].lo)) * ih;

    if (!mini) this.grid(ctx, pad, w, h, iw, ih, t0, t1, X, axes, hasRight);

    if (o.zero && !axes.l.empty) {
      const y0 = Y(0);
      ctx.fillStyle = alpha(C.bad, 0.07);
      ctx.fillRect(pad.l, y0, iw, pad.t + ih - y0);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = alpha(C.bad, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y0); ctx.lineTo(pad.l + iw, y0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = alpha(C.bad, 0.85);
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText('SEUIL', pad.l + iw - 4, y0 - 4);
    }

    // series : segments continus (coupure si trou > 15 s)
    for (const s of o.series) {
      const ax = s.axis || 'l';
      const segs = [];
      let cur = null, prevT = 0;
      for (const p of pts) {
        if (p[s.key] == null) { cur = null; continue; }
        if (!cur || p.t - prevT > 15000) { cur = []; segs.push(cur); }
        cur.push([X(p.t), Y(p[s.key], ax)]);
        prevT = p.t;
      }
      for (const seg of segs) {
        if (s.fill !== false && seg.length > 1) {
          const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
          g.addColorStop(0, alpha(s.color, mini ? 0.28 : 0.22));
          g.addColorStop(1, alpha(s.color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(seg[0][0], pad.t + ih);
          seg.forEach(([x, y]) => ctx.lineTo(x, y));
          ctx.lineTo(seg[seg.length - 1][0], pad.t + ih);
          ctx.fill();
        }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = mini ? 1.6 : 2;
        ctx.lineJoin = 'round';
        ctx.shadowColor = s.color;
        ctx.shadowBlur = mini ? 4 : 8;
        ctx.beginPath();
        seg.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      const last = segs.at(-1)?.at(-1);
      if (last && segs.at(-1).length && pts.at(-1)?.[s.key] != null) {
        ctx.fillStyle = s.color;
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(last[0], last[1], mini ? 2.5 : 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // marqueurs d'anomalie
    if (o.markers) {
      const s0 = o.series[0];
      for (const p of pts) {
        if (!p.anomaly || p[s0.key] == null) continue;
        const x = X(p.t), y = Y(p[s0.key], s0.axis || 'l');
        if (!mini) {
          ctx.fillStyle = alpha(C.bad, 0.08);
          ctx.fillRect(x - 3, pad.t, 6, ih);
        }
        ctx.strokeStyle = C.bad;
        ctx.lineWidth = 2;
        ctx.shadowColor = C.bad;
        ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(x, y, mini ? 3 : 6, 0, Math.PI * 2); ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    if (!pts.length && !mini) {
      ctx.fillStyle = C.dim;
      ctx.font = `12px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText('EN ATTENTE DE MESURES', pad.l + iw / 2, pad.t + ih / 2);
    }

    if (this.mx != null && pts.length) this.tooltip(ctx, pts, X, Y, pad, w, ih);
  }

  grid(ctx, pad, w, h, iw, ih, t0, t1, X, axes, hasRight) {
    ctx.font = `10px ${MONO}`;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ih * i) / 4;
      ctx.strokeStyle = alpha(C.mut, i === 4 ? 0.25 : 0.09);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + iw, y); ctx.stroke();
      const lab = (ax, x, align, color) => {
        if (axes[ax].empty) return;
        const v = axes[ax].hi - ((axes[ax].hi - axes[ax].lo) * i) / 4;
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 1 ? 2 : 1), x, y + 3);
      };
      lab('l', pad.l - 6, 'right', alpha(this.o.series[0].color, 0.8));
      if (hasRight) lab('r', w - pad.r + 6, 'left', alpha(this.o.series.find((s) => s.axis === 'r').color, 0.8));
    }
    const step = 60000;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = X(t);
      ctx.strokeStyle = alpha(C.mut, 0.07);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ih); ctx.stroke();
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'center';
      ctx.fillText(hm(new Date(t)), x, h - 6);
    }
  }

  tooltip(ctx, pts, X, Y, pad, w, ih) {
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p.t) - this.mx) < Math.abs(X(best.t) - this.mx)) best = p;
    const x = X(best.t);
    ctx.strokeStyle = alpha(C.fg, 0.35);
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ih); ctx.stroke();
    ctx.setLineDash([]);
    const lines = [hms(new Date(best.t))];
    for (const s of this.o.series) {
      const v = best[s.key];
      if (v == null) continue;
      lines.push(`${s.label} ${fmt(v, s.digits ?? 1)}${s.unit || ''}`);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(x, Y(v, s.axis || 'l'), 4, 0, Math.PI * 2); ctx.fill();
    }
    if (best.anomaly) lines.push('⚠ ANOMALIE');
    ctx.font = `11px ${MONO}`;
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18, bh = lines.length * 16 + 10;
    let bx = x + 12;
    if (bx + bw > w - 4) bx = x - 12 - bw;
    const by = pad.t + 4;
    ctx.fillStyle = 'rgba(5,10,17,.92)';
    ctx.strokeStyle = alpha(C.acc, 0.4);
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left';
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? C.mut : (l.startsWith('⚠') ? C.bad : C.fg);
      ctx.fillText(l, bx + 9, by + 18 + i * 16);
    });
  }
}

const charts = [
  new LineChart($('c-env'), { markers: true, series: [
    { key: 'temp', label: 'Temp', unit: ' °C', color: C.temp },
    { key: 'hum', label: 'Hum', unit: ' %', color: C.hum, axis: 'r', fill: false },
  ] }),
  new LineChart($('c-gas'), { series: [{ key: 'gas', label: 'Gaz', color: C.gas, digits: 0 }] }),
  new LineChart($('c-ai'), { zero: true, markers: true, series: [{ key: 'score', label: 'Score', color: C.ai, digits: 3 }] }),
  new LineChart($('s-temp'), { mini: true, markers: true, series: [{ key: 'temp', color: C.temp }] }),
  new LineChart($('s-hum'), { mini: true, series: [{ key: 'hum', color: C.hum }] }),
  new LineChart($('s-gas'), { mini: true, series: [{ key: 'gas', color: C.gas }] }),
];
let drawQueued = false;
function drawCharts() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; charts.forEach((c) => c.draw()); });
}
new ResizeObserver(drawCharts).observe(document.body);

// ---------- son ----------
let audio = null;
function unlockAudio() {
  if (!audio) { try { audio = new AudioContext(); } catch { return; } }
  if (audio.state === 'suspended') audio.resume();
}
function beep(pattern) {
  if (state.muted || !audio || audio.state !== 'running') return;
  let t = audio.currentTime;
  for (const [freq, dur] of pattern) {
    const osc = audio.createOscillator(), g = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(audio.destination);
    osc.start(t); osc.stop(t + dur + 0.02);
    t += dur + 0.05;
  }
}
const SIREN = [[880, 0.18], [660, 0.18], [880, 0.18], [660, 0.18]];
const CHIME = [[1046, 0.1], [1318, 0.14]];
addEventListener('pointerdown', unlockAudio);
addEventListener('keydown', unlockAudio);

// ---------- journal systeme ----------
function log(tag, msg) {
  const el = $('log');
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  const li = document.createElement('li');
  li.innerHTML = `<time>${hms(new Date())}</time><span class="t t-${tag}">${tag.toUpperCase()}</span><span></span>`;
  li.lastChild.textContent = msg;
  el.append(li);
  while (el.children.length > 200) el.firstChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}

function toast(title, msg, sev = 'info') {
  const t = document.createElement('div');
  t.className = `toast sev-${sev}`;
  t.innerHTML = '<b></b><span></span>';
  t.firstChild.textContent = title;
  t.lastChild.textContent = msg;
  $('toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 4500);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

// ---------- API ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-API-Key': state.key, ...opts.headers } });
  if (r.status === 401) { logout('Clé refusée par le serveur.'); throw new Error('401'); }
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// ---------- telemetrie ----------
function onTelemetry(m) {
  const p = { t: Date.now(), temp: m.temp, hum: m.hum, gas: m.gas, motion: !!m.motion, score: m.score ?? null, anomaly: !!m.anomaly };
  state.history.push(p);
  const cutoff = Date.now() - WINDOW_MS - 10000;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();
  state.liveSamples++;
  state.lastTelemetry = p.t;
  state.modelReady = !!m.model_ready;
  if (p.anomaly && !state.anomaly) log('ia', `Anomalie : T=${fmt(p.temp)} H=${fmt(p.hum)} G=${p.gas} score=${fmt(p.score, 3)}`);
  state.anomaly = p.anomaly;
  if (p.motion) state.lastMotion = p.t;
  state.motion = p.motion;
  log('mqtt', `T=${fmt(p.temp)}°C H=${fmt(p.hum)}% G=${p.gas} M=${+p.motion}${p.score != null ? ` S=${fmt(p.score, 3)}` : ''}`);
  renderTiles(p);
  renderAI(p);
  drawCharts();
  renderThreat();
  renderLinks();
}

function valueAgo(key, ms) {
  const target = Date.now() - ms;
  let best = null;
  for (const p of state.history) {
    if (p[key] == null) continue;
    if (p.t <= target) best = p; else { best ??= p; break; }
  }
  return best?.[key];
}

function renderTiles(p) {
  const win = state.history.filter((q) => q.t >= Date.now() - WINDOW_MS);
  for (const [k, digits] of [['temp', 1], ['hum', 1], ['gas', 0]]) {
    const el = $('v-' + k), txt = fmt(p[k], digits);
    if (el.textContent !== txt) {
      el.textContent = txt;
      const tile = el.closest('.tile');
      tile.classList.remove('flash'); void tile.offsetWidth; tile.classList.add('flash');
    }
    const vals = win.map((q) => q[k]).filter((v) => v != null);
    $('mn-' + k).textContent = vals.length ? fmt(Math.min(...vals), digits) : '--';
    $('mx-' + k).textContent = vals.length ? fmt(Math.max(...vals), digits) : '--';
    const prev = valueAgo(k, 60000), d = $('d-' + k);
    if (prev != null) {
      const diff = p[k] - prev;
      const flat = Math.abs(diff) < (digits ? 0.05 : 1);
      d.className = 'delta ' + (flat ? '' : diff > 0 ? 'up' : 'down');
      d.textContent = `${flat ? '=' : diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff), digits)}/min`;
    }
    $('v-' + k).closest('.tile').classList.toggle('anomaly', p.anomaly);
  }
  $('tile-motion').classList.toggle('on', p.motion);
  $('v-motion').textContent = p.motion ? 'DÉTECTÉ' : 'R.A.S.';
}

function renderAI(p) {
  const box = $('ai-state');
  if (!state.modelReady) {
    box.dataset.s = 'learn';
    $('ai-label').textContent = 'APPRENTISSAGE';
    const n = Math.min(state.liveSamples, MIN_TRAIN);
    $('ai-progress').style.width = (n / MIN_TRAIN) * 100 + '%';
    $('ai-sub').textContent = `${n} / ${MIN_TRAIN} mesures reçues · régime normal en cours d'apprentissage`;
  } else if (p?.anomaly) {
    box.dataset.s = 'anomaly';
    $('ai-label').textContent = 'ANOMALIE';
    $('ai-sub').textContent = `Mesure hors régime appris · score ${fmt(p.score, 3)}`;
  } else {
    box.dataset.s = 'ok';
    $('ai-label').textContent = 'RÉGIME NORMAL';
    $('ai-sub').textContent = p?.score != null ? `Modèle entraîné · score ${fmt(p.score, 3)}` : 'Modèle entraîné';
  }
}

// ---------- alertes ----------
function alertTitle(a) { return LABELS.type[a.type] || a.type; }

function renderAlerts(newId) {
  const list = $('alerts');
  const f = state.filter;
  const items = state.alerts.filter((a) => (!f.source || a.source === f.source) && (!f.sev || a.severity === f.sev)).slice(0, 200);
  list.replaceChildren(...items.map((a) => {
    const li = document.createElement('li');
    li.className = `sev-${a.severity}${a.id === newId ? ' new' : ''}`;
    const d = new Date(a.ts);
    li.innerHTML = '<time></time><b></b><p></p><span class="tag"><span class="pill"></span><span class="src"></span></span>';
    li.children[0].textContent = hms(d);
    li.children[0].title = d.toLocaleString('fr-FR');
    li.children[1].textContent = alertTitle(a);
    li.children[2].textContent = a.message || '';
    li.querySelector('.pill').textContent = LABELS.sev[a.severity] || a.severity;
    li.querySelector('.src').textContent = LABELS.source[a.source] || a.source;
    return li;
  }));
  if (!items.length) list.innerHTML = '<li class="empty">AUCUNE ALERTE</li>';
  const hour = state.alerts.filter((a) => Date.now() - new Date(a.ts) < HOUR_MS);
  $('alerts-count').textContent = `${state.alerts.length} chargées`;
  $('cnt-alerts').textContent = hour.length;
  $('cnt-intrusion').textContent = hour.filter((a) => a.type === 'intrusion').length;
  $('cnt-anomaly').textContent = hour.filter((a) => a.source === 'ml').length;
}

function onAlert(a) {
  state.alerts.unshift(a);
  if (state.alerts.length > 500) state.alerts.pop();
  renderAlerts(a.id);
  renderThreat();
  log('alert', `[${a.source}] ${a.type} ${a.severity} — ${a.message || ''}`);
  if (a.type === 'intrusion' || a.type === 'unknown_face') onDetection(a);
  if (a.severity === 'high' || a.severity === 'critical') openCritical(a);
  else { toast(alertTitle(a), a.message || LABELS.source[a.source] || a.source, a.severity); beep(CHIME); }
}

let detectTimer = 0;
function onDetection(a) {
  const d = a.data || {};
  $('det-time').textContent = hms(new Date(a.ts));
  $('det-count').textContent = d.count ?? '--';
  $('det-conf').textContent = d.confidence != null ? Math.round(d.confidence * 100) + ' %' : '--';
  $('det-ms').textContent = d.inference_ms != null ? fmt(d.inference_ms) + ' ms' : '--';
  $('feed').classList.add('detect');
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => $('feed').classList.remove('detect'), 5000);
}

// ---------- alerte critique plein ecran ----------
let critCount = 0, sirenTimer = 0;
function openCritical(a) {
  const box = $('critical');
  critCount = box.hidden ? 1 : critCount + 1;
  $('crit-source').textContent = `ALERTE ${(LABELS.sev[a.severity] || '').toUpperCase()} · ${(LABELS.source[a.source] || a.source).toUpperCase()}`;
  $('crit-title').textContent = alertTitle(a).toUpperCase();
  $('crit-msg').textContent = `${a.message || ''} — ${hms(new Date(a.ts))}`;
  const data = Object.entries(a.data || {}).slice(0, 5);
  $('crit-data').replaceChildren(...data.map(([k, v]) => {
    const div = document.createElement('div');
    div.innerHTML = '<dt></dt><dd></dd>';
    div.firstChild.textContent = k;
    div.lastChild.textContent = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(Math.abs(v) >= 10 ? 1 : 3)) : String(v);
    return div;
  }));
  $('crit-count').textContent = critCount > 1 ? `×${critCount}` : '';
  box.hidden = false;
  beep(SIREN);
  clearInterval(sirenTimer);
  sirenTimer = setInterval(() => beep(SIREN), 1600);
}
function closeCritical() {
  if ($('critical').hidden) return;
  $('critical').hidden = true;
  clearInterval(sirenTimer);
  log('alert', `Alerte acquittée par l'opérateur${critCount > 1 ? ` (${critCount} événements)` : ''}`);
}
$('crit-ack').onclick = closeCritical;
$('crit-alarm').onclick = async () => { await command({ buzzer: true, led: 'red' }, 'Alarme déclenchée'); closeCritical(); };

// ---------- niveau de menace ----------
const LEVELS = [
  ['NOMINAL', 'Aucune menace active'],
  ['VIGILANCE', ''],
  ['ALERTE', ''],
  ['DANGER', ''],
  ['CRITIQUE', ''],
];
const ARC = 2 * Math.PI * 84;
(function ticks() {
  const g = $('threat-ticks');
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2, r1 = i % 4 ? 94 : 91, r2 = 98;
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', 100 + r1 * Math.cos(a)); l.setAttribute('y1', 100 + r1 * Math.sin(a));
    l.setAttribute('x2', 100 + r2 * Math.cos(a)); l.setAttribute('y2', 100 + r2 * Math.sin(a));
    g.append(l);
  }
})();

function renderThreat() {
  const now = Date.now();
  const recent = state.alerts.filter((a) => now - new Date(a.ts) < RECENT_MS);
  const has = (fn) => recent.some(fn);
  const intrusion = has((a) => a.type === 'intrusion');
  const anomaly = state.anomaly || has((a) => a.source === 'ml');
  const espDown = state.lastTelemetry && now - state.lastTelemetry > 30000;
  let lvl = 0, desc = LEVELS[0][1];
  if (has((a) => a.severity === 'critical') || (intrusion && anomaly)) {
    lvl = 4; desc = intrusion && anomaly ? 'Intrusion et anomalie simultanées' : 'Alerte critique en cours';
  } else if (has((a) => a.severity === 'high')) {
    lvl = 3; desc = intrusion ? 'Présence humaine détectée par la caméra' : 'Anomalie capteurs confirmée';
  } else if (anomaly || has((a) => a.severity === 'medium')) {
    lvl = 2; desc = anomaly ? 'Mesures hors du régime appris' : 'Mouvement détecté sur site';
  } else if (state.motion || espDown || !state.wsOpen || state.mqtt === false) {
    lvl = 1;
    desc = !state.wsOpen ? 'Liaison serveur interrompue' : state.mqtt === false ? 'Broker MQTT injoignable'
      : espDown ? 'Boîtier silencieux' : 'Mouvement en zone surveillée';
  }
  const el = $('threat');
  if (el.dataset.level !== String(lvl)) {
    if (+el.dataset.level < lvl) log('alert', `Niveau de menace : ${LEVELS[lvl][0]}`);
    el.dataset.level = lvl;
    document.body.dataset.level = lvl;
  }
  $('threat-level').textContent = LEVELS[lvl][0];
  $('threat-desc').textContent = desc;
  $('threat-arc').style.strokeDashoffset = ARC * (1 - (lvl + 1) / 5);
}

// ---------- liaisons ----------
function setLink(id, cls, title) {
  const el = $(id);
  el.className = cls;
  el.title = title;
}
function renderLinks() {
  const now = Date.now();
  setLink('st-ws', state.wsOpen ? 'ok' : 'bad', state.wsOpen ? 'WebSocket connecté' : 'WebSocket déconnecté');
  setLink('st-mqtt', state.mqtt ? 'ok' : state.mqtt === false ? 'bad' : '', state.mqtt ? 'API abonnée au broker (TLS)' : 'Broker injoignable');
  const age = state.lastTelemetry ? (now - state.lastTelemetry) / 1000 : Infinity;
  setLink('st-esp', age < 10 ? 'ok' : age < 30 ? 'warn' : 'bad', isFinite(age) ? `Dernière mesure il y a ${Math.round(age)} s` : 'Aucune mesure reçue');
  setLink('st-ai', state.modelReady ? 'ok' : 'warn', state.modelReady ? 'Isolation Forest entraîné' : 'Apprentissage en cours');
  setLink('st-cam', state.camOn ? 'ok' : 'bad', state.camOn ? 'Flux MJPEG actif' : 'Flux caméra indisponible');
  $('last-seen').textContent = isFinite(age) ? (age < 3 ? 'temps réel' : `dernière mesure il y a ${Math.round(age)} s`) : 'en attente de données…';
  if (state.lastMotion) {
    const s = Math.round((now - state.lastMotion) / 1000);
    $('last-motion').textContent = s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
  }
}

// ---------- camera ----------
// vision/detect.py tourne sur le PC serveur : flux MJPEG sur /stream, etat JSON sur /status
const CAM = `http://${location.hostname}:8090`;
let camMiss = 0;
async function checkCam() {
  let st = null;
  try { st = await (await fetch(CAM + '/status', { signal: AbortSignal.timeout(1500) })).json(); } catch { /* detecteur arrete */ }
  const img = $('cam');
  const on = !!st?.camera && img.naturalWidth > 0;
  $('cam-info').textContent = !st ? 'détecteur arrêté' : !st.camera ? 'caméra déconnectée, reconnexion…'
    : `${fmt(st.cam_fps, 0)} fps · YOLO ${fmt(st.infer_ms, 0)} ms`;
  renderWho(st);
  if (on !== state.camOn) {
    state.camOn = on;
    if (on) loadFaces();
    $('feed').dataset.state = on ? 'on' : 'off';
    log('cam', on ? 'Flux vision connecté' : 'Flux vision perdu');
    renderLinks();
  }
  if (st && !img.naturalWidth) img.src = `${CAM}/stream?t=${Date.now()}`;
  else if (!st && ++camMiss % 3 === 0) img.removeAttribute('src');
}
$('cam').onerror = () => $('cam').removeAttribute('src');

// ---------- controle d'acces (reconnaissance faciale) ----------
async function camApi(path, opts = {}) {
  const r = await fetch(CAM + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-API-Key': state.key } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || String(r.status));
  return body;
}

function renderWho(st) {
  const who = $('who');
  if (!st?.camera || st.face_recognition === false) {
    $('access-info').textContent = st?.face_recognition === false ? 'désactivée (--no-faces)' : 'caméra requise';
    who.innerHTML = '<span class="empty-who">Caméra inactive</span>';
    return;
  }
  $('access-info').textContent = 'reconnaissance faciale';
  if (!st.faces?.length) { who.innerHTML = '<span class="empty-who">Aucun visage dans le champ</span>'; return; }
  who.replaceChildren(...st.faces.map((f) => {
    const chip = document.createElement('span');
    chip.className = 'face-chip ' + (f.small ? 'small' : f.name ? 'known' : 'unknown');
    chip.textContent = f.small ? 'Trop loin' : f.name || 'INCONNU';
    if (!f.small) {
      const i = document.createElement('i');
      i.textContent = Math.round(f.score * 100) + ' %';
      chip.append(i);
    }
    return chip;
  }));
}

async function loadFaces() {
  if (state.stopped) return;
  try { renderFaces(await camApi('/faces')); } catch { /* detecteur arrete */ }
}

function renderFaces(list) {
  const ul = $('faces');
  if (!list.length) { ul.innerHTML = '<li class="empty">AUCUN VISAGE AUTORISÉ · ALARME INACTIVE</li>'; return; }
  ul.replaceChildren(...list.map((f) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="av"></span><b></b><span></span><button type="button" title="Retirer l’autorisation">✕</button>';
    li.children[0].textContent = f.name.slice(0, 2).toUpperCase();
    li.children[1].textContent = f.name;
    li.children[2].textContent = `${f.samples} échant.`;
    li.children[3].onclick = async () => {
      if (!confirm(`Retirer ${f.name} des visages autorisés ?`)) return;
      try {
        await camApi('/faces/' + encodeURIComponent(f.name), { method: 'DELETE' });
        log('cam', `Visage retiré : ${f.name}`);
        loadFaces();
      } catch (e) { toast('Suppression impossible', e.message, 'high'); }
    };
    return li;
  }));
}

$('enroll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = $('enroll-form'), note = $('enroll-note'), name = $('enroll-name').value.trim();
  form.classList.add('busy');
  $('enroll-btn').disabled = true;
  note.className = 'note';
  note.textContent = `Capture de ${name}… regardez la caméra et bougez légèrement la tête.`;
  try {
    const r = await camApi('/faces', { method: 'POST', body: JSON.stringify({ name }) });
    note.className = 'note ok';
    note.textContent = `${r.name} autorisé (${r.samples} échantillons). Recommencez sous un autre angle pour fiabiliser.`;
    log('cam', `Visage enregistré : ${r.name} (${r.samples} échantillons)`);
    $('enroll-name').value = '';
    loadFaces();
  } catch (err) {
    note.className = 'note err';
    note.textContent = `Échec : ${err.message === 'Failed to fetch' ? 'détecteur vision injoignable' : err.message}`;
  } finally {
    form.classList.remove('busy');
    $('enroll-btn').disabled = false;
  }
});

// ---------- commandes ----------
async function command(body, label) {
  const btns = document.querySelectorAll('.controls button, .crit-actions button');
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await api('/api/v1/command', { method: 'POST', body: JSON.stringify(body) });
    Object.assign(state.device, r.sent);
    renderDevice();
    const txt = Object.entries(r.sent).map(([k, v]) => `${k}=${v}`).join(' ');
    log('cmd', `${label} → sentinel/cmd ${txt}`);
    $('cmd-note').textContent = `${label} · publiée sur MQTT (QoS 1) à ${hms(new Date())}`;
    toast(label, `Commande publiée : ${txt}`, 'info');
  } catch (e) {
    if (e.message !== '401') {
      log('cmd', `Échec ${label} (${e.message})`);
      toast('Commande refusée', `${label} : erreur ${e.message}`, 'high');
    }
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}
function onCommand(m) {
  const { kind, ...cmd } = m;
  if (Object.entries(cmd).every(([k, v]) => state.device[k] === v)) return;  // deja connu (commande locale)
  Object.assign(state.device, cmd);
  renderDevice();
  log('cmd', `Actionneurs : ${Object.entries(cmd).map(([k, v]) => `${k}=${v}`).join(' ')} (autre opérateur ou vision)`);
}
function renderDevice() {
  const { buzzer, led } = state.device;
  $('sw-buzz').setAttribute('aria-checked', String(!!buzzer));
  $('dev-buzz').dataset.on = buzzer ? '1' : '0';
  $('dev-led').dataset.c = led;
  document.querySelectorAll('#seg-led button').forEach((b) => b.classList.toggle('on', b.dataset.led === led));
}
$('sw-buzz').onclick = () => command({ buzzer: !state.device.buzzer }, state.device.buzzer ? 'Buzzer coupé' : 'Buzzer activé');
document.querySelectorAll('#seg-led button').forEach((b) => {
  b.onclick = () => command({ led: b.dataset.led }, `LED ${b.textContent.toLowerCase()}`);
});
$('m-alarm').onclick = () => command({ buzzer: true, led: 'red' }, 'Alerte générale');
$('m-clear').onclick = () => command({ buzzer: false, led: 'green' }, "Levée d'alerte");

// ---------- filtres ----------
for (const [id, key] of [['f-source', 'source'], ['f-sev', 'sev']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filter[key] = b.dataset.v;
    $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderAlerts();
  });
}

// ---------- WebSocket ----------
let wsRetry = 0;
function connect() {
  if (state.stopped) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?key=${encodeURIComponent(state.key)}`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsOpen = true;
    wsRetry = 0;
    log('ws', 'Canal temps réel ouvert');
    renderLinks(); renderThreat();
  };
  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    const was = state.wsOpen;
    state.wsOpen = false;
    renderLinks(); renderThreat();
    if (e.code === 4401) { logout('Clé refusée par le serveur.'); return; }
    if (was) log('ws', 'Canal temps réel fermé, reconnexion…');
    if (!state.stopped) setTimeout(connect, Math.min(1000 * 2 ** wsRetry++, 10000));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.kind === 'telemetry') onTelemetry(m);
    else if (m.kind === 'alert') onAlert(m);
    else if (m.kind === 'command') onCommand(m);
  };
}

async function pollHealth() {
  try {
    const h = await (await fetch('/api/v1/health')).json();
    if (state.mqtt !== h.mqtt) log('mqtt', h.mqtt ? 'API abonnée au broker Mosquitto (TLS)' : 'Broker MQTT injoignable');
    if (h.model_ready && !state.modelReady) log('ia', 'Isolation Forest entraîné : détection active');
    state.mqtt = h.mqtt;
    state.modelReady = h.model_ready;
    state.apiUp = true;
  } catch {
    if (state.apiUp) log('ws', 'API injoignable');
    state.apiUp = false;
    state.mqtt = null;
  }
  renderAI(state.history.at(-1));
  renderLinks();
}

// ---------- session ----------
async function start() {
  state.stopped = false;
  $('login').hidden = true;
  log('ws', 'Opérateur authentifié');
  try {
    const [tele, alerts] = await Promise.all([api('/api/v1/telemetry?limit=200'), api('/api/v1/alerts?limit=200')]);
    state.history = tele.map((p) => ({ t: new Date(p.ts).getTime(), temp: p.temp, hum: p.hum, gas: p.gas, motion: p.motion, score: null, anomaly: p.anomaly }))
      .filter((p) => p.t >= Date.now() - WINDOW_MS);
    state.alerts = alerts;
    log('ws', `Historique chargé : ${tele.length} mesures, ${alerts.length} alertes`);
    const last = state.history.at(-1);
    if (last) { state.lastTelemetry = last.t; renderTiles(last); }
  } catch (e) {
    if (e.message === '401') return;
    log('ws', `Historique indisponible (${e.message})`);
  }
  renderAlerts();
  renderThreat();
  drawCharts();
  pollHealth();
  loadFaces();
  connect();
}

function logout(err) {
  state.stopped = true;
  state.key = '';
  store('sessionStorage', 'sx-key', null);
  if (state.ws) { const ws = state.ws; state.ws = null; ws.close(); }
  state.wsOpen = false;
  closeCritical();
  $('login-err').textContent = err || '';
  $('login').hidden = false;
  $('key').value = '';
  $('key').focus();
  if (err) {
    const box = $('login-form');
    box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockAudio();
  const key = $('key').value.trim();
  $('login-err').textContent = '';
  try {
    const r = await fetch('/api/v1/alerts?limit=1', { headers: { 'X-API-Key': key } });
    if (r.status === 401) { logout('Clé invalide.'); return; }
    if (!r.ok) throw new Error(r.status);
  } catch (err) {
    $('login-err').textContent = `Serveur injoignable (${err.message}).`;
    return;
  }
  state.key = key;
  store('sessionStorage', 'sx-key', key);
  start();
});
$('btn-logout').onclick = () => logout();

// ---------- en-tete ----------
state.muted = load('localStorage', 'sx-muted') === '1';
$('btn-mute').setAttribute('aria-pressed', String(state.muted));
function toggleMute() {
  state.muted = !state.muted;
  store('localStorage', 'sx-muted', state.muted ? '1' : '0');
  $('btn-mute').setAttribute('aria-pressed', String(state.muted));
  toast(state.muted ? 'Son coupé' : 'Son activé', 'Alertes sonores', 'info');
}
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}
$('btn-mute').onclick = toggleMute;
$('btn-full').onclick = toggleFull;
addEventListener('keydown', (e) => {
  if (e.target.matches('input')) return;
  if (e.key === 'Escape') closeCritical();
  else if (e.key === 'f' || e.key === 'F') toggleFull();
  else if (e.key === 'm' || e.key === 'M') toggleMute();
});

function tick() {
  const d = new Date();
  $('clock').textContent = hms(d);
  $('date').textContent = d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  $('cam-ts').textContent = `${d.toISOString().slice(0, 10)} ${hms(d)}`;
  if (!state.stopped) { renderLinks(); renderThreat(); drawCharts(); }
}

// ---------- demarrage ----------
renderDevice();
renderAI(null);
renderAlerts();
renderThreat();
renderLinks();
tick();
setInterval(tick, 1000);
setInterval(() => !state.stopped && pollHealth(), 5000);
setInterval(checkCam, 1000);

state.key = load('sessionStorage', 'sx-key') || '';
if (state.key) start();
else logout();
