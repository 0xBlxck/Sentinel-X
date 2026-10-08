// Supervision : niveau de menace, capteurs du boitier, courbes et etat de l'IA.
import { StyleSheet, Text, View } from 'react-native';
import { LineChart } from '../../components/charts';
import { Gauge } from '../../components/charts';
import { Screen } from '../../components/chrome';
import { Blink, Panel, Stat, s as ui } from '../../components/ui';
import { fmt } from '../../lib/format';
import { GAS_ALARM, MIN_TRAIN, useSession, WINDOW_MS } from '../../lib/session';
import { LEVELS } from '../../lib/threat';
import { alpha, C, MONO } from '../../lib/theme';
import type { Sample } from '../../lib/types';

const HOUR_MS = 60 * 60 * 1000;

function valueAgo(history: Sample[], key: 'temp' | 'hum' | 'gas', ms: number, now: number) {
  const target = now - ms;
  let best: Sample | null = null;
  for (const p of history) {
    if (p[key] == null) continue;
    if (p.t <= target) best = p; else { best ??= p; break; }
  }
  return best?.[key] ?? null;
}

function SensorTile({ k, label, chip, unit, color, digits }: {
  k: 'temp' | 'hum' | 'gas'; label: string; chip: string; unit: string; color: string; digits: number;
}) {
  const ss = useSession();
  const last = ss.history.at(-1);
  const win = ss.history.filter((q) => q.t >= ss.now - WINDOW_MS).map((q) => q[k]).filter((v): v is number => v != null);
  const v = last?.[k] ?? null;
  const prev = valueAgo(ss.history, k, 60000, ss.now);
  const diff = v != null && prev != null ? v - prev : null;
  const flat = diff == null || Math.abs(diff) < (digits ? 0.05 : 1);
  const anomaly = !!last?.anomaly;
  return (
    <View style={[st.tile, anomaly && { borderColor: C.bad }]}>
      <View style={[st.tileBar, { backgroundColor: color, shadowColor: color }]} />
      <View style={st.tileHead}>
        <Text style={st.tileLabel}>{label}</Text>
        <Text style={st.tileChip}>{chip}</Text>
      </View>
      <View style={st.valueRow}>
        <Text style={[st.value, anomaly && { color: C.bad }]} adjustsFontSizeToFit numberOfLines={1}>{fmt(v, digits)}</Text>
        <Text style={st.unit}>{unit}</Text>
      </View>
      <Text style={[st.delta, !flat && { color: diff! > 0 ? C.temp : C.hum }]}>
        {diff == null ? ' ' : `${flat ? '=' : diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff), digits)}/min`}
      </Text>
      <LineChart mini data={ss.history} now={ss.now} height={40} markers={k === 'temp'} series={[{ key: k, color }]} />
      <View style={st.tileFoot}>
        <Text style={st.footText}>min <Text style={st.footVal}>{win.length ? fmt(Math.min(...win), digits) : '--'}</Text></Text>
        <Text style={st.footText}>max <Text style={st.footVal}>{win.length ? fmt(Math.max(...win), digits) : '--'}</Text></Text>
      </View>
    </View>
  );
}

function PresenceTile() {
  const ss = useSession();
  const on = ss.live.motion;
  const s = ss.live.lastMotion ? Math.round((ss.now - ss.live.lastMotion) / 1000) : null;
  const c = on ? C.bad : C.ok;
  return (
    <View style={[st.tile, on && { borderColor: alpha(C.bad, 0.5) }]}>
      <View style={[st.tileBar, { backgroundColor: c, shadowColor: c }]} />
      <View style={st.tileHead}>
        <Text style={st.tileLabel}>Présence</Text>
        <Text style={st.tileChip}>PIR</Text>
      </View>
      <View style={st.radar}>
        <View style={[st.ring, { borderColor: alpha(c, 0.3) }]} />
        <View style={[st.ring, { inset: 12, borderColor: alpha(c, 0.3) }]} />
        <Blink on={on} period={600} style={st.core}>
          <View style={[StyleSheet.absoluteFill, { borderRadius: 12, backgroundColor: on ? C.bad : C.dim }]} />
        </Blink>
      </View>
      <Text style={[st.presence, on && { color: C.bad }]}>{on ? 'DÉTECTÉ' : 'R.A.S.'}</Text>
      <Text style={[st.footText, { textAlign: 'center' }]}>
        dernier mvt <Text style={st.footVal}>{s == null ? '--' : s < 60 ? `${s} s` : `${Math.round(s / 60)} min`}</Text>
      </Text>
    </View>
  );
}

export default function Supervision() {
  const ss = useSession();
  const hour = ss.alerts.filter((a) => ss.now - new Date(a.ts).getTime() < HOUR_MS);
  const last = ss.history.at(-1);
  const age = ss.espAge;
  const n = Math.min(ss.live.samples, MIN_TRAIN);
  const ai = !ss.modelReady ? 'learn' : last?.anomaly ? 'anomaly' : 'ok';
  const lvl = ss.threat.level;

  return (
    <Screen>
      <Panel title="Niveau de menace" danger={lvl >= 3}>
        <Gauge level={lvl} label={LEVELS[lvl]} desc={ss.threat.desc} />
        <View style={st.row}>
          <Stat label="Alertes 1 h" value={hour.length} />
          <Stat label="Intrusions" value={hour.filter((a) => a.type === 'intrusion').length} />
          <Stat label="Anomalies" value={hour.filter((a) => a.source === 'ml').length} />
        </View>
      </Panel>

      <Panel title="Capteurs du boîtier" sub={isFinite(age) ? (age < 3 ? 'temps réel' : `dernière mesure il y a ${Math.round(age)} s`) : 'en attente de données…'}>
        <View style={st.tiles}>
          <SensorTile k="temp" label="Température" chip="DHT22" unit="°C" color={C.temp} digits={1} />
          <SensorTile k="hum" label="Humidité" chip="DHT22" unit="%" color={C.hum} digits={1} />
          <SensorTile k="gas" label="Gaz / fumée" chip={ss.live.gasWarmup ? 'MQ-2 · chauffe' : 'MQ-2'} unit="ADC" color={C.gas} digits={0} />
          <PresenceTile />
        </View>
      </Panel>

      <Panel title="Environnement" sub="5 dernières minutes">
        <View style={st.legend}>
          <View style={[st.legLine, { backgroundColor: C.temp }]} /><Text style={st.legText}>Temp °C</Text>
          <View style={[st.legLine, { backgroundColor: C.hum }]} /><Text style={st.legText}>Hum %</Text>
          <View style={st.legMark} /><Text style={st.legText}>Anomalie</Text>
        </View>
        <LineChart data={ss.history} now={ss.now} height={200} markers series={[
          { key: 'temp', label: 'Temp', unit: ' °C', color: C.temp },
          { key: 'hum', label: 'Hum', unit: ' %', color: C.hum, axis: 'r', fill: false },
        ]} />
      </Panel>

      <Panel title="Maintenance prédictive" sub="Isolation Forest">
        <View style={st.aiRow}>
          <Blink on={ai === 'anomaly'} period={800}>
            <Text style={[st.aiLabel, { color: ai === 'ok' ? C.ok : ai === 'anomaly' ? C.bad : C.ai }]}>
              {ai === 'ok' ? 'RÉGIME NORMAL' : ai === 'anomaly' ? 'ANOMALIE' : 'APPRENTISSAGE'}
            </Text>
          </Blink>
          {ai === 'learn' && (
            <View style={st.bar}><View style={[st.barFill, { width: `${(n / MIN_TRAIN) * 100}%` }]} /></View>
          )}
        </View>
        <Text style={st.aiSub}>
          {ai === 'learn' ? `${n} / ${MIN_TRAIN} mesures reçues · régime normal en cours d'apprentissage`
            : ai === 'anomaly' ? `Mesure hors régime appris · score ${fmt(last?.score, 3)}`
              : last?.score != null ? `Modèle entraîné · score ${fmt(last.score, 3)}` : 'Modèle entraîné'}
        </Text>
        <LineChart data={ss.history} now={ss.now} height={150} zero markers
          series={[{ key: 'score', label: 'Score', color: C.ai, digits: 3 }]} />
        <Text style={ui.note}>Score de normalité : sous 0, la mesure sort du régime appris.</Text>
      </Panel>

      <Panel title="Qualité de l'air" sub="MQ-2 brut">
        <LineChart data={ss.history} now={ss.now} height={150}
          limit={{ v: GAS_ALARM, label: `ALARME BOÎTIER ${GAS_ALARM}` }}
          series={[{ key: 'gas', label: 'Gaz', color: C.gas, digits: 0 }]} />
      </Panel>
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    width: '48%', flexGrow: 1, overflow: 'hidden', padding: 12, paddingLeft: 14, borderRadius: 9,
    backgroundColor: 'rgba(98,160,210,0.05)', borderWidth: 1, borderColor: C.line,
  },
  tileBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, shadowOpacity: 1, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  tileHead: { flexDirection: 'row', justifyContent: 'space-between' },
  tileLabel: { color: C.mut, fontSize: 10, letterSpacing: 1.3, textTransform: 'uppercase' },
  tileChip: { color: C.dim, fontSize: 10, letterSpacing: 1 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 6 },
  value: { color: C.fg, fontFamily: MONO, fontSize: 32, fontWeight: '600', flexShrink: 1 },
  unit: { color: C.mut, fontSize: 13 },
  delta: { color: C.mut, fontFamily: MONO, fontSize: 11, marginBottom: 4 },
  tileFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  footText: { color: C.dim, fontSize: 11 },
  footVal: { color: C.mut, fontFamily: MONO },
  radar: { width: 64, height: 64, alignSelf: 'center', marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', inset: 0, borderWidth: 1, borderRadius: 40 },
  core: { width: 24, height: 24 },
  presence: { color: C.fg, textAlign: 'center', fontSize: 16, fontWeight: '700', letterSpacing: 2.5, marginTop: 8, marginBottom: 4 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -4, marginBottom: 8 },
  legLine: { width: 14, height: 3, borderRadius: 2, marginLeft: 4 },
  legMark: { width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: C.bad, marginLeft: 4 },
  legText: { color: C.mut, fontSize: 11 },
  aiRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  aiLabel: { fontSize: 15, fontWeight: '700', letterSpacing: 2.6 },
  bar: { flex: 1, height: 6, borderRadius: 3, backgroundColor: 'rgba(98,160,210,0.12)', overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: C.ai },
  aiSub: { color: C.mut, fontSize: 12, fontFamily: MONO, marginTop: 4, marginBottom: 8 },
});
