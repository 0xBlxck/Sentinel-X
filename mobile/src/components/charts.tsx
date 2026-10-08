// Graphiques SVG : courbes sur 5 min (meme rendu que le LineChart canvas du web) et jauge de menace.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { fmt, hm, hms } from '../lib/format';
import { WINDOW_MS } from '../lib/session';
import { alpha, C, LEVEL_COLOR, MONO } from '../lib/theme';
import type { Sample } from '../lib/types';

type Key = 'temp' | 'hum' | 'gas' | 'score';

export interface Series {
  key: Key;
  color: string;
  label?: string;
  unit?: string;
  digits?: number;
  axis?: 'l' | 'r';
  fill?: boolean;
}

interface ChartProps {
  data: Sample[];
  series: Series[];
  now: number;
  height: number;
  mini?: boolean;
  zero?: boolean;                          // seuil 0 du score IA
  markers?: boolean;                       // cercles rouges sur les anomalies
  limit?: { v: number; label: string };    // seuil d'alarme (gaz)
}

export function LineChart({ data, series, now, height, mini, zero, markers, limit }: ChartProps) {
  const [w, setW] = useState(0);
  const [tapX, setTapX] = useState<number | null>(null);
  const t1 = now, t0 = t1 - WINDOW_MS;
  const pts = data.filter((p) => p.t >= t0 - 5000);
  const hasRight = series.some((s) => s.axis === 'r');
  const pad = mini ? { l: 1, r: 1, t: 5, b: 2 } : { l: 38, r: hasRight ? 36 : 10, t: 10, b: 20 };
  const iw = Math.max(w - pad.l - pad.r, 1), ih = height - pad.t - pad.b;
  const X = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * iw;

  // une echelle par axe
  const axes: Record<'l' | 'r', { lo: number; hi: number; empty?: boolean }> = { l: { lo: 0, hi: 1, empty: true }, r: { lo: 0, hi: 1, empty: true } };
  for (const ax of ['l', 'r'] as const) {
    const vals: number[] = [];
    series.filter((s) => (s.axis || 'l') === ax).forEach((s) => pts.forEach((p) => p[s.key] != null && vals.push(p[s.key] as number)));
    if (!vals.length) continue;
    if (ax === 'l' && limit && !mini) vals.push(limit.v);  // le seuil reste toujours visible
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const span = hi - lo || Math.max(Math.abs(hi) * 0.1, 1);
    const m = mini ? 0.12 : 0.18;
    axes[ax] = { lo: lo - span * m, hi: hi + span * m };
  }
  const Y = (v: number, ax: 'l' | 'r' = 'l') => pad.t + (1 - (v - axes[ax].lo) / (axes[ax].hi - axes[ax].lo)) * ih;

  // segments continus (coupure si trou > 15 s)
  const paths = series.map((s) => {
    const ax = s.axis || 'l';
    const segs: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> | null = null, prevT = 0;
    for (const p of pts) {
      const v = p[s.key];
      if (v == null) { cur = null; continue; }
      if (!cur || p.t - prevT > 15000) { cur = []; segs.push(cur); }
      cur.push([X(p.t), Y(v, ax)]);
      prevT = p.t;
    }
    return { s, segs };
  });

  const ticks = [];
  if (!mini && w) {
    for (let t = Math.ceil(t0 / 60000) * 60000; t <= t1; t += 60000) ticks.push(t);
  }

  // info-bulle : touche le graphique pour lire une mesure
  let tip: { x: number; p: Sample } | null = null;
  if (tapX != null && pts.length && !mini) {
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p.t) - tapX) < Math.abs(X(best.t) - tapX)) best = p;
    tip = { x: X(best.t), p: best };
  }

  const svg = (
    <Svg width={w} height={height}>
      <Defs>
        {series.map((s) => (
          <LinearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={s.color} stopOpacity={mini ? 0.28 : 0.22} />
            <Stop offset="1" stopColor={s.color} stopOpacity={0} />
          </LinearGradient>
        ))}
      </Defs>

      {!mini && [0, 1, 2, 3, 4].map((i) => {
        const y = pad.t + (ih * i) / 4;
        const lab = (ax: 'l' | 'r') => {
          if (axes[ax].empty) return '';
          const v = axes[ax].hi - ((axes[ax].hi - axes[ax].lo) * i) / 4;
          return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 1 ? 2 : 1);
        };
        return (
          <G key={i}>
            <Line x1={pad.l} y1={y} x2={pad.l + iw} y2={y} stroke={alpha(C.mut, i === 4 ? 0.25 : 0.09)} strokeWidth={1} />
            <SvgText x={pad.l - 5} y={y + 3} fill={alpha(series[0].color, 0.8)} fontSize={9} fontFamily={MONO} textAnchor="end">{lab('l')}</SvgText>
            {hasRight && (
              <SvgText x={w - pad.r + 5} y={y + 3} fill={alpha(series.find((s) => s.axis === 'r')!.color, 0.8)} fontSize={9} fontFamily={MONO}>{lab('r')}</SvgText>
            )}
          </G>
        );
      })}
      {ticks.map((t) => (
        <G key={t}>
          <Line x1={X(t)} y1={pad.t} x2={X(t)} y2={pad.t + ih} stroke={alpha(C.mut, 0.07)} strokeWidth={1} />
          <SvgText x={X(t)} y={height - 5} fill={C.dim} fontSize={9} fontFamily={MONO} textAnchor="middle">{hm(new Date(t))}</SvgText>
        </G>
      ))}

      {zero && !axes.l.empty && (
        <G>
          <Rect x={pad.l} y={Y(0)} width={iw} height={Math.max(pad.t + ih - Y(0), 0)} fill={alpha(C.bad, 0.07)} />
          <Line x1={pad.l} y1={Y(0)} x2={pad.l + iw} y2={Y(0)} stroke={alpha(C.bad, 0.7)} strokeDasharray="5 4" strokeWidth={1} />
          <SvgText x={pad.l + iw - 4} y={Y(0) - 4} fill={alpha(C.bad, 0.85)} fontSize={9} fontFamily={MONO} textAnchor="end">SEUIL</SvgText>
        </G>
      )}
      {limit && !mini && !axes.l.empty && (
        <G>
          <Rect x={pad.l} y={pad.t} width={iw} height={Math.max(Y(limit.v) - pad.t, 0)} fill={alpha(C.bad, 0.06)} />
          <Line x1={pad.l} y1={Y(limit.v)} x2={pad.l + iw} y2={Y(limit.v)} stroke={alpha(C.bad, 0.75)} strokeDasharray="5 4" strokeWidth={1} />
          <SvgText x={pad.l + iw - 4} y={Y(limit.v) - 4} fill={alpha(C.bad, 0.9)} fontSize={9} fontFamily={MONO} textAnchor="end">{limit.label}</SvgText>
        </G>
      )}

      {paths.map(({ s, segs }) => segs.map((seg, i) => {
        const line = seg.map(([x, y], j) => `${j ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
        const area = seg.length > 1 ? `M${seg[0][0]},${pad.t + ih}${seg.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join('')}L${seg[seg.length - 1][0]},${pad.t + ih}Z` : '';
        return (
          <G key={`${s.key}-${i}`}>
            {s.fill !== false && area ? <Path d={area} fill={`url(#g-${s.key})`} /> : null}
            <Path d={line} stroke={s.color} strokeWidth={mini ? 1.6 : 2} fill="none" strokeLinejoin="round" />
          </G>
        );
      }))}
      {paths.map(({ s, segs }) => {
        const last = segs.at(-1)?.at(-1);
        return last && pts.at(-1)?.[s.key] != null
          ? <Circle key={`d-${s.key}`} cx={last[0]} cy={last[1]} r={mini ? 2.5 : 3.5} fill={s.color} /> : null;
      })}

      {markers && pts.filter((p) => p.anomaly && p[series[0].key] != null).map((p) => {
        const x = X(p.t), y = Y(p[series[0].key] as number, series[0].axis || 'l');
        return (
          <G key={`a-${p.t}`}>
            {!mini && <Rect x={x - 3} y={pad.t} width={6} height={ih} fill={alpha(C.bad, 0.08)} />}
            <Circle cx={x} cy={y} r={mini ? 3 : 6} stroke={C.bad} strokeWidth={2} fill="none" />
          </G>
        );
      })}

      {!pts.length && !mini && (
        <SvgText x={pad.l + iw / 2} y={pad.t + ih / 2} fill={C.dim} fontSize={11} fontFamily={MONO} textAnchor="middle">EN ATTENTE DE MESURES</SvgText>
      )}

      {tip && (
        <G>
          <Line x1={tip.x} y1={pad.t} x2={tip.x} y2={pad.t + ih} stroke={alpha(C.fg, 0.35)} strokeDasharray="3 3" />
          {series.map((s) => tip!.p[s.key] != null
            ? <Circle key={s.key} cx={tip!.x} cy={Y(tip!.p[s.key] as number, s.axis || 'l')} r={4} fill={s.color} /> : null)}
        </G>
      )}
    </Svg>
  );

  return (
    <View style={{ height }} onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}>
      {mini ? svg : (
        <Pressable onPress={(e) => setTapX(tapX == null ? e.nativeEvent.locationX : null)}>{svg}</Pressable>
      )}
      {tip && (
        <View pointerEvents="none" style={[st.tip, tip.x > w / 2 ? { left: 8 } : { right: 8 }]}>
          <Text style={st.tipHead}>{hms(new Date(tip.p.t))}</Text>
          {series.map((s) => tip!.p[s.key] != null ? (
            <Text key={s.key} style={[st.tipLine, { color: s.color }]}>
              {s.label} {fmt(tip!.p[s.key] as number, s.digits ?? 1)}{s.unit || ''}
            </Text>
          ) : null)}
          {tip.p.anomaly && <Text style={[st.tipLine, { color: C.bad }]}>⚠ ANOMALIE</Text>}
        </View>
      )}
    </View>
  );
}

/** Jauge circulaire du niveau de menace (5 crans, graduations, balayage). */
export function Gauge({ level, label, desc, size = 210 }: { level: number; label: string; desc: string; size?: number }) {
  const color = LEVEL_COLOR[level];
  const r = 84, arc = 2 * Math.PI * r;
  const ticks = Array.from({ length: 48 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2, r1 = i % 4 ? 94 : 91, r2 = 98;
    return [100 + r1 * Math.cos(a), 100 + r1 * Math.sin(a), 100 + r2 * Math.cos(a), 100 + r2 * Math.sin(a)];
  });
  return (
    <View style={{ width: size, height: size, alignSelf: 'center' }}>
      <Svg width={size} height={size} viewBox="0 0 200 200">
        <G rotation={-90} origin="100, 100">
          <Circle cx={100} cy={100} r={r} stroke="rgba(98,160,210,0.12)" strokeWidth={10} fill="none" />
          <Circle cx={100} cy={100} r={r} stroke={color} strokeWidth={10} fill="none" strokeLinecap="round"
            strokeDasharray={`${arc} ${arc}`} strokeDashoffset={arc * (1 - (level + 1) / 5)} />
          {ticks.map(([x1, y1, x2, y2], i) => (
            <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(98,160,210,0.3)" strokeWidth={1.2} />
          ))}
          <Circle cx={100} cy={100} r={70} stroke={color} strokeWidth={1} opacity={0.35} fill="none" strokeDasharray="60 380" />
        </G>
      </Svg>
      <View style={[StyleSheet.absoluteFill, st.gaugeLabel]}>
        <Text style={[st.gaugeLevel, { color, textShadowColor: color }]}>{label}</Text>
        <Text style={st.gaugeDesc}>{desc}</Text>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  tip: {
    position: 'absolute', top: 6, backgroundColor: 'rgba(5,10,17,0.92)', borderColor: alpha(C.acc, 0.4),
    borderWidth: 1, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 9,
  },
  tipHead: { color: C.mut, fontFamily: MONO, fontSize: 11 },
  tipLine: { fontFamily: MONO, fontSize: 11, marginTop: 2 },
  gaugeLabel: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34 },
  gaugeLevel: { fontSize: 24, fontWeight: '700', letterSpacing: 3, textShadowRadius: 12 },
  gaugeDesc: { color: C.mut, fontSize: 12, marginTop: 4, textAlign: 'center' },
});
