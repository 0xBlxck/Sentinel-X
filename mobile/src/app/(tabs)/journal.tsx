// Journal systeme (console du dashboard) et reglages de l'application.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../../components/chrome';
import { Icon } from '../../components/Icon';
import { BigButton, Panel, s as ui } from '../../components/ui';
import { hms } from '../../lib/format';
import { useSession } from '../../lib/session';
import { C, MONO } from '../../lib/theme';
import type { LogTag } from '../../lib/types';

const TAG_COLOR: Record<LogTag, string> = {
  ws: C.ok, mqtt: C.acc, cmd: C.warn, alert: C.bad, ia: C.ai, cam: C.acc,
};

function Toggle({ on, onPress, label, sub }: { on: boolean; onPress: () => void; label: string; sub: string }) {
  return (
    <Pressable onPress={onPress} style={st.toggleRow} accessibilityRole="switch" accessibilityState={{ checked: on }}>
      <View style={{ flex: 1 }}>
        <Text style={st.toggleLabel}>{label}</Text>
        <Text style={st.toggleSub}>{sub}</Text>
      </View>
      <View style={[st.switch, on && st.switchOn]}><View style={[st.knob, on && st.knobOn]} /></View>
    </Pressable>
  );
}

export default function Journal() {
  const ss = useSession();
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (awake) activateKeepAwakeAsync('sentinel').catch(() => {});
    else deactivateKeepAwake('sentinel').catch(() => {});
  }, [awake]);
  const logs = [...ss.logs].reverse();

  return (
    <Screen>
      <Panel title="Journal système" sub={`${ss.logs.length} lignes`}>
        <View style={st.console}>
          {logs.length ? logs.map((l) => (
            <View key={l.id} style={st.line}>
              <Text style={st.t}>{hms(new Date(l.t))}</Text>
              <Text style={[st.tag, { color: TAG_COLOR[l.tag] }]}>{l.tag.toUpperCase()}</Text>
              <Text style={st.msg}>{l.msg}</Text>
            </View>
          )) : <Text style={ui.empty}>EN ATTENTE D'ÉVÉNEMENTS</Text>}
        </View>
      </Panel>

      <Panel title="Réglages" sub={`serveur ${ss.host}`}>
        <Toggle
          on={!ss.muted} onPress={() => ss.setMuted(!ss.muted)}
          label="Vibrations d'alerte" sub="Vibre en boucle sur une alerte critique jusqu'à l'acquittement"
        />
        <Toggle
          on={awake} onPress={() => setAwake(!awake)}
          label="Écran toujours allumé" sub="Pour garder le téléphone en poste de surveillance"
        />
        <BigButton label="Déconnexion" sub="efface la clé ou la session de l'appareil" onPress={() => ss.logout()} style={{ marginTop: 12 }} />
        <View style={st.foot}>
          <Icon name="shield" size={14} color={C.dim} viewBox={32} />
          <Text style={st.footText}>API :8000 · WebSocket temps réel · vision :8090</Text>
        </View>
      </Panel>
    </Screen>
  );
}

const st = StyleSheet.create({
  console: { backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 8 },
  line: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  t: { color: C.dim, fontFamily: MONO, fontSize: 11 },
  tag: { width: 44, fontFamily: MONO, fontSize: 11 },
  msg: { flex: 1, color: '#b9c7d6', fontFamily: MONO, fontSize: 11 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.line },
  toggleLabel: { color: C.fg, fontSize: 14 },
  toggleSub: { color: C.mut, fontSize: 11, marginTop: 2 },
  switch: { width: 52, height: 28, borderRadius: 14, backgroundColor: '#1a2230', borderWidth: 1, borderColor: C.lineStrong, justifyContent: 'center' },
  switchOn: { backgroundColor: 'rgba(62,230,255,0.15)', borderColor: C.acc },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.mut, marginLeft: 3 },
  knobOn: { backgroundColor: C.acc, transform: [{ translateX: 24 }] },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, justifyContent: 'center' },
  footText: { color: C.dim, fontSize: 11 },
});
