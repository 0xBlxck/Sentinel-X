// Actionneurs : etat reel du boitier (LED, buzzer, alarme gaz, inconnu) et commandes MQTT.
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../../components/chrome';
import { Icon } from '../../components/Icon';
import { BigButton, Blink, Chips, Panel, s as ui } from '../../components/ui';
import { hms } from '../../lib/format';
import { useSession } from '../../lib/session';
import { alpha, C, MONO } from '../../lib/theme';
import type { Led } from '../../lib/types';

/** Buzzer qui "sonne" (rotation alternee, comme l'animation ring du web). */
function Ringing({ on, children }: { on: boolean; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on) { v.setValue(0); return; }
    const a = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(v, { toValue: -1, duration: 120, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [on, v]);
  const rotate = v.interpolate({ inputRange: [-1, 1], outputRange: ['-12deg', '12deg'] });
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>;
}

function Indicator({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={st.ind}>
      <View style={st.indIcon}>{children}</View>
      <Text style={st.indLabel}>{label}</Text>
    </View>
  );
}

export default function Actionneurs() {
  const ss = useSession();
  const { buzzer, led, gas_alarm: gas, stranger } = ss.device;
  const ledColor = led === 'green' ? C.ok : led === 'red' ? C.bad : null;
  const sync = ss.syncState;
  const syncText = sync === 'none' ? 'état non confirmé' : sync === 'wait' ? 'en attente du boîtier…'
    : sync === 'late' ? 'pas de réponse du boîtier' : `✓ confirmé ${hms(new Date(ss.syncAt))}`;
  const syncColor = sync === 'wait' ? C.warn : sync === 'ok' ? C.ok : sync === 'late' ? C.bad : C.dim;
  const buzzOn = buzzer || gas;

  const clear = async () => {
    await ss.command({ buzzer: false, led: 'green' }, "Levée d'alerte");
  };

  return (
    <Screen>
      <Panel title="Actionneurs" sub="MQTT → ESP8266" right={<Text style={[st.sync, { color: syncColor }]}>{syncText}</Text>}>
        <View style={st.device}>
          <Indicator label="LED">
            <View style={[st.led, ledColor && { backgroundColor: ledColor, borderColor: alpha(ledColor, 0.7), shadowColor: ledColor, shadowOpacity: 1 }]} />
          </Indicator>
          <Indicator label="Buzzer">
            <Ringing on={buzzOn}><Icon name="bell" size={34} color={buzzOn ? C.warn : C.dim} width={1.6} /></Ringing>
          </Indicator>
          <Indicator label="Gaz">
            <Blink on={gas} period={700}><Icon name="flame" size={34} color={gas ? C.gas : C.dim} width={1.6} /></Blink>
          </Indicator>
          <Indicator label="Inconnu">
            <Blink on={stranger} period={700}><Icon name="user" size={34} color={stranger ? C.bad : C.dim} width={1.6} /></Blink>
          </Indicator>
        </View>

        <View style={st.row}>
          <Text style={st.lbl}>Buzzer</Text>
          <Pressable
            accessibilityRole="switch" accessibilityState={{ checked: buzzOn }} disabled={ss.busy}
            onPress={() => ss.command({ buzzer: !buzzer }, buzzer ? 'Buzzer coupé' : 'Buzzer activé')}
            style={[st.switch, buzzOn && st.switchOn]}
          >
            <View style={[st.knob, buzzOn && st.knobOn]} />
          </Pressable>
        </View>
        <View style={st.row}>
          <Text style={st.lbl}>LED</Text>
          <Chips<Led>
            items={[['green', 'Verte'], ['red', 'Rouge'], ['off', 'Off']]}
            value={led}
            tint={(v) => (v === 'green' ? C.ok : v === 'red' ? C.bad : undefined)}
            onChange={(v) => ss.command({ led: v }, `LED ${v === 'green' ? 'verte' : v === 'red' ? 'rouge' : 'off'}`)}
          />
        </View>

        <View style={st.macros}>
          <BigButton style={{ flex: 1 }} label="Alerte générale" sub="buzzer + LED rouge" kind="danger" disabled={ss.busy}
            onPress={() => ss.command({ buzzer: true, led: 'red' }, 'Alerte générale')} />
          <BigButton style={{ flex: 1 }} label="Levée d'alerte" kind="ok" disabled={ss.busy} onPress={clear}
            sub={gas ? 'gaz : s’arrête quand l’air redevient sain' : 'buzzer off + LED verte'} />
        </View>
        {gas && (
          <Text style={[ui.note, { color: C.gas }]}>
            Alarme gaz locale en cours : le boîtier garde le buzzer et la LED rouge tant que le gaz dépasse le seuil. Aérez la pièce.
          </Text>
        )}
        <Text style={ui.note}>{ss.cmdNote}</Text>
      </Panel>
    </Screen>
  );
}

const st = StyleSheet.create({
  sync: { fontFamily: MONO, fontSize: 11 },
  device: {
    flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14, marginBottom: 12,
    borderWidth: 1, borderStyle: 'dashed', borderColor: C.lineStrong, borderRadius: 9,
    backgroundColor: 'rgba(62,230,255,0.03)',
  },
  ind: { alignItems: 'center', gap: 6 },
  indIcon: { height: 36, alignItems: 'center', justifyContent: 'center' },
  indLabel: { color: C.mut, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  led: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: '#1a2230', borderWidth: 2, borderColor: '#2a3546',
    shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.line,
  },
  lbl: { color: C.mut, fontSize: 12, letterSpacing: 1.6, textTransform: 'uppercase' },
  switch: { width: 52, height: 28, borderRadius: 14, backgroundColor: '#1a2230', borderWidth: 1, borderColor: C.lineStrong, justifyContent: 'center' },
  switchOn: { backgroundColor: 'rgba(255,176,32,0.2)', borderColor: C.warn },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.mut, marginLeft: 3 },
  knobOn: { backgroundColor: C.warn, transform: [{ translateX: 24 }] },
  macros: { flexDirection: 'row', gap: 8, marginTop: 10 },
});
