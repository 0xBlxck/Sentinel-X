// Habillage commun : en-tete (marque, liaisons, horloge), bandeau hors ligne, toasts, alerte critique.
import type { ReactNode } from 'react';
import { Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dateLabel, fmt, hms } from '../lib/format';
import { useSession } from '../lib/session';
import { alpha, C, MONO, SEV_COLOR } from '../lib/theme';
import { alertTitle, LABELS } from '../lib/types';
import { Icon, Logo } from './Icon';
import { Backdrop, BigButton, Blink } from './ui';

type LinkState = 'ok' | 'warn' | 'bad' | '';

function LinkPill({ label, state }: { label: string; state: LinkState }) {
  const color = state === 'ok' ? C.ok : state === 'warn' ? C.warn : state === 'bad' ? C.bad : C.dim;
  const border = state === 'ok' ? 'rgba(43,245,154,0.3)' : state === 'warn' ? 'rgba(255,176,32,0.35)' : state === 'bad' ? 'rgba(255,59,92,0.35)' : C.line;
  return (
    <View style={[st.pill, { borderColor: border }]}>
      <Blink on={state === 'warn'}>
        <View style={[st.dot, { backgroundColor: color, shadowColor: color }]} />
      </Blink>
      <Text style={[st.pillText, state && state !== 'bad' ? { color: C.fg } : null]}>{label}</Text>
    </View>
  );
}

export function Header() {
  const ss = useSession();
  const age = ss.espAge;
  const d = new Date(ss.now);
  return (
    <View style={st.header}>
      <View style={st.brandRow}>
        <Logo color={C.acc} />
        <View style={{ flex: 1 }}>
          <Text style={st.brand}>SENTINEL<Text style={{ color: C.acc }}>-X</Text></Text>
          <Text style={st.brandSub}>AetherCorp · Centrale Δ-7</Text>
        </View>
        <View style={st.clock}>
          <Text style={st.clockTime}>{hms(d)}</Text>
          <Text style={st.clockDate}>{dateLabel(d)}</Text>
        </View>
        <Pressable style={[st.iconBtn, ss.muted && st.iconBtnWarn]} onPress={() => ss.setMuted(!ss.muted)} hitSlop={6}
          accessibilityLabel={ss.muted ? 'Réactiver les vibrations' : 'Couper les vibrations'}>
          <Icon name={ss.muted ? 'muteOff' : 'muteOn'} size={18} color={ss.muted ? C.warn : C.fg} />
        </Pressable>
        <Pressable
          style={st.iconBtn} hitSlop={6} accessibilityLabel="Déconnexion"
          onPress={() => Alert.alert('Déconnexion', 'Fermer la session sur ce téléphone ?', [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Déconnexion', style: 'destructive', onPress: () => ss.logout() },
          ])}
        >
          <Icon name="logout" size={18} color={C.fg} />
        </Pressable>
      </View>
      <View style={st.links}>
        <LinkPill label="Liaison" state={ss.wsOpen ? 'ok' : 'bad'} />
        <LinkPill label="MQTT/TLS" state={ss.mqtt ? 'ok' : ss.mqtt === false ? 'bad' : ''} />
        <LinkPill label="Boîtier" state={age < 10 ? 'ok' : age < 30 ? 'warn' : 'bad'} />
        <LinkPill label="IA" state={ss.modelReady ? 'ok' : 'warn'} />
        <LinkPill label="Caméra" state={ss.cam?.camera ? 'ok' : 'bad'} />
      </View>
    </View>
  );
}

export function OfflineBanner() {
  const { offline } = useSession();
  if (!offline) return null;
  return (
    <View style={st.offline} accessibilityRole="alert">
      <Blink period={800}><View style={st.offlineDot} /></Blink>
      <Text style={st.offlineText}>{offline}</Text>
    </View>
  );
}

/** Ecran type : fond quadrille, en-tete, bandeau, contenu defilant. */
export function Screen({ children, onRefresh }: { children: ReactNode; onRefresh?: () => void }) {
  const ss = useSession();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Backdrop danger={ss.threat.level >= 3} />
      <View style={{ paddingTop: insets.top }}>
        <Header />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
        refreshControl={onRefresh ? <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={C.acc} /> : undefined}
      >
        <OfflineBanner />
        {children}
      </ScrollView>
    </View>
  );
}

export function Toasts() {
  const { toasts } = useSession();
  const insets = useSafeAreaInsets();
  if (!toasts.length) return null;
  return (
    <View pointerEvents="none" style={[st.toasts, { bottom: insets.bottom + 70 }]}>
      {toasts.map((t) => (
        <View key={t.id} style={[st.toast, { borderLeftColor: SEV_COLOR[t.sev] }]}>
          <Text style={st.toastTitle}>{t.title}</Text>
          <Text style={st.toastMsg}>{t.msg}</Text>
        </View>
      ))}
    </View>
  );
}

/** Alerte critique plein ecran : vibration en boucle jusqu'a l'acquittement (cf. session). */
export function CriticalModal() {
  const ss = useSession();
  const list = ss.crit;
  if (!list?.length) return null;
  const a = list[list.length - 1];
  const data = Object.entries(a.data || {}).slice(0, 5);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={ss.closeCritical} statusBarTranslucent>
      <View style={st.critBack}>
        <Blink period={1200} style={StyleSheet.absoluteFill}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,31,75,0.16)' }]} />
        </Blink>
        <View style={st.critBox}>
          {list.length > 1 && <Text style={st.critCount}>×{list.length}</Text>}
          <Blink period={700}><Icon name="warn" size={60} color={C.crit} width={1.6} /></Blink>
          <Text style={st.critSource}>
            ALERTE {(LABELS.sev[a.severity] || '').toUpperCase()} · {(LABELS.source[a.source] || a.source).toUpperCase()}
          </Text>
          <Text style={st.critTitle}>{alertTitle(a).toUpperCase()}</Text>
          <Text style={st.critMsg}>{a.message || ''} — {hms(new Date(a.ts))}</Text>
          <View style={st.critData}>
            {data.map(([k, v]) => (
              <View key={k} style={st.critItem}>
                <Text style={st.critDt}>{k}</Text>
                <Text style={st.critDd}>{typeof v === 'number' ? (Number.isInteger(v) ? v : fmt(v, Math.abs(v) >= 10 ? 1 : 3)) : String(v)}</Text>
              </View>
            ))}
          </View>
          <View style={{ gap: 10, alignSelf: 'stretch' }}>
            {/* alarme gaz : le boitier sonne deja de lui-meme */}
            {a.type !== 'gas' && (
              <BigButton label="Déclencher l'alarme" sub="buzzer + LED rouge" kind="danger" disabled={ss.busy}
                onPress={async () => { await ss.command({ buzzer: true, led: 'red' }, 'Alarme déclenchée'); ss.closeCritical(); }} />
            )}
            <BigButton label="Acquitter" sub="prendre en compte" onPress={ss.closeCritical} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  header: {
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10, gap: 10,
    backgroundColor: 'rgba(4,7,12,0.88)', borderBottomWidth: 1, borderBottomColor: C.line,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brand: { color: C.fg, fontSize: 18, fontWeight: '700', letterSpacing: 4 },
  brandSub: { color: C.mut, fontSize: 9.5, letterSpacing: 1.4, textTransform: 'uppercase' },
  clock: { alignItems: 'flex-end' },
  clockTime: { color: C.fg, fontFamily: MONO, fontSize: 16, fontWeight: '600' },
  clockDate: { color: C.mut, fontSize: 9, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 2 },
  iconBtn: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  iconBtnWarn: { borderColor: 'rgba(255,176,32,0.4)' },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  pillText: { color: C.mut, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  offline: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, paddingVertical: 11, paddingHorizontal: 14,
    borderRadius: 10, backgroundColor: 'rgba(255,59,92,0.14)', borderWidth: 1, borderColor: 'rgba(255,59,92,0.6)',
  },
  offlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.bad },
  offlineText: { flex: 1, color: '#ffd3da', fontSize: 13, letterSpacing: 0.4 },
  toasts: { position: 'absolute', left: 12, right: 12, gap: 8 },
  toast: {
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: C.panelSolid,
    borderWidth: 1, borderColor: C.lineStrong, borderLeftWidth: 3,
  },
  toastTitle: { color: C.fg, fontSize: 13, fontWeight: '700', letterSpacing: 0.6 },
  toastMsg: { color: C.mut, fontSize: 12 },
  critBack: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, backgroundColor: 'rgba(20,0,5,0.92)' },
  critBox: {
    width: '100%', maxWidth: 520, alignItems: 'center', gap: 6, paddingVertical: 28, paddingHorizontal: 20,
    backgroundColor: 'rgba(16,4,8,0.95)', borderWidth: 2, borderColor: C.crit, borderRadius: 14,
  },
  critCount: { position: 'absolute', top: 12, right: 14, color: '#ff8da0', fontFamily: MONO, fontSize: 12 },
  critSource: { color: '#ff8da0', letterSpacing: 3, fontSize: 11, textAlign: 'center' },
  critTitle: { color: '#fff', fontSize: 30, fontWeight: '800', letterSpacing: 3, textAlign: 'center', textShadowColor: C.crit, textShadowRadius: 20 },
  critMsg: { color: '#f3c4cc', fontSize: 14, textAlign: 'center', marginBottom: 6 },
  critData: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginBottom: 14 },
  critItem: { paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: alpha(C.bad, 0.4), borderRadius: 8 },
  critDt: { color: '#c98f99', fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  critDd: { color: C.fg, fontFamily: MONO, fontSize: 15, fontWeight: '600' },
});
