// Journal des alertes : filtres source / gravite, prise en compte par l'operateur.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../../components/chrome';
import { Chips, Panel, s as ui } from '../../components/ui';
import { hms } from '../../lib/format';
import { useSession } from '../../lib/session';
import { RECENT_MS } from '../../lib/threat';
import { C, MONO, SEV_COLOR } from '../../lib/theme';
import { alertTitle, LABELS, type Alert } from '../../lib/types';

function AlertRow({ a }: { a: Alert }) {
  const ss = useSession();
  const acked = ss.acked.has(a.id);
  const color = SEV_COLOR[a.severity] || C.acc;
  const d = new Date(a.ts);
  return (
    <View style={[st.row, acked && { opacity: 0.5 }]}>
      <View style={[st.stripe, { backgroundColor: color, shadowColor: color, shadowOpacity: acked ? 0 : 0.9 }]} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={st.line1}>
          <Text style={st.time}>{hms(d)}</Text>
          <Text style={st.title} numberOfLines={1}>{alertTitle(a)}</Text>
        </View>
        {a.message ? <Text style={st.msg} numberOfLines={2}>{a.message}</Text> : null}
        <View style={st.line3}>
          <Text style={[st.pill, { color, borderColor: color }]}>{LABELS.sev[a.severity] || a.severity}</Text>
          <Text style={st.src}>{LABELS.source[a.source] || a.source}</Text>
          <Pressable
            disabled={acked}
            onPress={() => ss.ack([a.id])}
            style={({ pressed }) => [st.ack, acked && st.acked, pressed && { borderColor: C.ok }]}
          >
            <Text style={[st.ackText, acked && { color: C.ok }]}>{acked ? 'Pris en compte' : 'Prendre en compte'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export default function Alertes() {
  const ss = useSession();
  const [source, setSource] = useState('');
  const [sev, setSev] = useState('');
  const items = ss.alerts.filter((a) => (!source || a.source === source) && (!sev || a.severity === sev)).slice(0, 200);
  const open = ss.alerts.filter((a) => !ss.acked.has(a.id) && ss.now - new Date(a.ts).getTime() < RECENT_MS).length;
  const unacked = ss.alerts.filter((a) => !ss.acked.has(a.id));
  return (
    <Screen>
      <Panel
        title="Journal des alertes"
        sub={`${ss.alerts.length} chargées${open ? ` · ${open} à traiter` : ''}`}
      >
        <Pressable
          disabled={!unacked.length}
          onPress={() => ss.ack(unacked.map((a) => a.id))}
          style={[st.ackAll, !unacked.length && { opacity: 0.4 }]}
        >
          <Text style={st.ackText}>Tout prendre en compte</Text>
        </Pressable>
        <View style={{ gap: 8, marginBottom: 10 }}>
          <Chips items={[['', 'Toutes'], ['vision', 'Vision'], ['ml', 'IA'], ['esp8266', 'Boîtier']]} value={source} onChange={setSource} />
          <Chips items={[['', 'Toutes gravités'], ['critical', 'Critique'], ['high', 'Haute'], ['medium', 'Moyenne'], ['info', 'Info']]} value={sev} onChange={setSev} />
        </View>
        {items.length ? items.map((a) => <AlertRow key={a.id} a={a} />) : <Text style={ui.empty}>AUCUNE ALERTE</Text>}
      </Panel>
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  stripe: { width: 4, borderRadius: 2, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  line1: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  time: { color: C.mut, fontFamily: MONO, fontSize: 12 },
  title: { flex: 1, color: C.fg, fontSize: 14, fontWeight: '600', letterSpacing: 0.4 },
  msg: { color: C.mut, fontSize: 12 },
  line3: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  pill: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  src: { color: C.mut, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  ack: { marginLeft: 'auto', paddingVertical: 5, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1, borderColor: C.lineStrong },
  acked: { borderColor: 'transparent' },
  ackText: { color: C.mut, fontSize: 11, letterSpacing: 0.4 },
  ackAll: {
    alignSelf: 'flex-start', marginTop: -4, marginBottom: 10, paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: 6, borderWidth: 1, borderColor: C.lineStrong,
  },
});
