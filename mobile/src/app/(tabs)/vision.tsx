// Vision : flux YOLO annote (MJPEG de vision/detect.py) et controle d'acces par reconnaissance faciale.
import { useMemo, useState } from 'react';
import { Alert as RNAlert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Screen } from '../../components/chrome';
import { Icon } from '../../components/Icon';
import { BigButton, Blink, Panel, Stat, s as ui } from '../../components/ui';
import { fmt, hms } from '../../lib/format';
import { useSession } from '../../lib/session';
import { alpha, C, MONO } from '../../lib/theme';

function Feed() {
  const ss = useSession();
  const on = !!ss.cam?.camera;
  // une detection recente (intrusion / visage inconnu) colore le cadre en rouge pendant 5 s
  const det = ss.alerts.find((a) => a.type === 'intrusion' || a.type === 'unknown_face');
  const hot = !!det && ss.now - new Date(det.ts).getTime() < 5000;
  const frame = hot ? C.bad : C.acc;
  // page construite une seule fois par serveur : l'ecran se rafraichit chaque seconde (horloge),
  // et une nouvelle page relancerait le flux a chaque fois. Le flux se reconnecte seul s'il coupe.
  const html = useMemo(() => `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;background:#000;overflow:hidden">
    <img id="v" style="width:100vw;height:100vh;object-fit:cover;display:block">
    <script>
      var v = document.getElementById('v');
      function load() { v.src = '${ss.camBase}/stream?t=' + Date.now(); }
      v.onerror = function () { setTimeout(load, 1000); };
      load();
    </script></body></html>`, [ss.camBase]);
  return (
    <View style={[st.feed, hot && { borderColor: C.bad }]}>
      {on ? (
        <WebView
          key={ss.camBase}
          source={{ html, baseUrl: ss.camBase }}
          originWhitelist={['*']}
          mixedContentMode="always"
          scrollEnabled={false}
          style={{ backgroundColor: '#000' }}
          pointerEvents="none"
        />
      ) : (
        <View style={st.nosignal}>
          <Icon name="nosignal" size={40} color={C.dim} width={1.5} />
          <Blink period={2000}><Text style={st.nosigTitle}>SIGNAL PERDU</Text></Blink>
          <Text style={st.nosigSub}>Lancer vision/detect.py sur le PC serveur</Text>
        </View>
      )}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[st.c, st.tl, { borderColor: frame }]} />
        <View style={[st.c, st.tr, { borderColor: frame }]} />
        <View style={[st.c, st.bl, { borderColor: frame }]} />
        <View style={[st.c, st.br, { borderColor: frame }]} />
        {on && (
          <View style={st.rec}>
            <Blink period={1000}><View style={st.recDot} /></Blink>
            <Text style={st.hud}>REC</Text>
          </View>
        )}
        <Text style={[st.hud, st.camId]}>CAM-01 · ZONE ACCÈS</Text>
        <Text style={[st.hud, st.camTs]}>{new Date(ss.now).toISOString().slice(0, 10)} {hms(new Date(ss.now))}</Text>
      </View>
    </View>
  );
}

function Access() {
  const ss = useSession();
  const [name, setName] = useState('');
  const [note, setNote] = useState<{ text: string; kind?: 'ok' | 'err' }>({ text: 'Face à la caméra, bougez légèrement la tête pendant 3 s.' });
  const [busy, setBusy] = useState(false);
  const st2 = ss.cam;
  const info = !st2 ? 'caméra requise' : st2.face_recognition === false ? 'désactivée (--no-faces)' : 'reconnaissance faciale';

  const enroll = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setNote({ text: `Capture de ${n}… regardez la caméra et bougez légèrement la tête.` });
    try {
      const r = await ss.enroll(n);
      setNote({ text: `${r.name} autorisé (${r.samples} échantillons). Recommencez sous un autre angle pour fiabiliser.`, kind: 'ok' });
      setName('');
    } catch (e) {
      const m = (e as Error).message;
      setNote({ text: `Échec : ${m === 'Network request failed' || m === 'Aborted' ? 'détecteur vision injoignable' : m}`, kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const remove = (n: string) => RNAlert.alert('Retirer l’autorisation', `Retirer ${n} des visages autorisés ?`, [
    { text: 'Annuler', style: 'cancel' },
    { text: 'Retirer', style: 'destructive', onPress: () => ss.deleteFace(n) },
  ]);

  return (
    <Panel title="Contrôle d'accès" sub={info}>
      <View style={st.who}>
        {!st2?.camera || st2.face_recognition === false ? <Text style={st.emptyWho}>Caméra inactive</Text>
          : !st2.faces.length ? <Text style={st.emptyWho}>Aucun visage dans le champ</Text>
            : st2.faces.map((f, i) => {
              const kind = f.small ? 'small' : f.name ? 'known' : 'unknown';
              const color = kind === 'known' ? C.ok : kind === 'unknown' ? C.bad : C.mut;
              const chip = (
                <View style={[st.face, { borderColor: alpha(color, 0.5), backgroundColor: alpha(color, kind === 'small' ? 0 : 0.1) }]}>
                  <Text style={[st.faceName, { color }]}>{f.small ? 'Trop loin' : f.name || 'INCONNU'}</Text>
                  {!f.small && <Text style={[st.faceScore, { color }]}>{Math.round(f.score * 100)} %</Text>}
                </View>
              );
              return kind === 'unknown' ? <Blink key={i} period={1000}>{chip}</Blink> : <View key={i}>{chip}</View>;
            })}
      </View>
      <View style={st.enroll}>
        <TextInput
          style={st.input} value={name} onChangeText={setName} maxLength={32}
          placeholder="Nom de la personne" placeholderTextColor={C.dim} editable={!busy} onSubmitEditing={enroll}
        />
        <BigButton label={busy ? 'Capture…' : 'Enregistrer'} kind="ok" onPress={enroll} disabled={busy || !name.trim()} />
      </View>
      <Text style={[ui.note, note.kind === 'ok' && { color: C.ok }, note.kind === 'err' && { color: C.bad }]}>{note.text}</Text>
      <View style={{ marginTop: 10 }}>
        {!ss.faces.length ? <Text style={ui.empty}>AUCUN VISAGE AUTORISÉ · ALARME INACTIVE</Text>
          : ss.faces.map((f) => (
            <View key={f.name} style={st.faceRow}>
              <View style={st.av}><Text style={st.avText}>{f.name.slice(0, 2).toUpperCase()}</Text></View>
              <Text style={st.faceRowName} numberOfLines={1}>{f.name}</Text>
              <Text style={st.samples}>{f.samples} échant.</Text>
              <Pressable style={st.del} onPress={() => remove(f.name)} hitSlop={6} accessibilityLabel={`Retirer ${f.name}`}>
                <Text style={{ color: C.mut }}>✕</Text>
              </Pressable>
            </View>
          ))}
      </View>
    </Panel>
  );
}

export default function Vision() {
  const ss = useSession();
  const st2 = ss.cam;
  const det = ss.alerts.find((a) => a.type === 'intrusion' || a.type === 'unknown_face');
  const d = (det?.data || {}) as { count?: number; confidence?: number; inference_ms?: number };
  const info = !st2 ? 'détecteur arrêté' : !st2.camera ? 'caméra déconnectée, reconnexion…' : `${fmt(st2.cam_fps, 0)} fps · YOLO ${fmt(st2.infer_ms, 0)} ms`;
  return (
    <Screen>
      <Panel title="Vision · YOLOv8" sub={info}>
        <Feed />
        <View style={[st.stats]}>
          <Stat label="Dernière détection" value={det ? hms(new Date(det.ts)) : '--'} />
          <Stat label="Personnes" value={d.count ?? '--'} />
        </View>
        <View style={st.stats}>
          <Stat label="Confiance" value={d.confidence != null ? `${Math.round(d.confidence * 100)} %` : '--'} />
          <Stat label="Inférence" value={d.inference_ms != null ? `${fmt(d.inference_ms)} ms` : '--'} />
        </View>
      </Panel>
      <Access />
    </Screen>
  );
}

const st = StyleSheet.create({
  feed: { aspectRatio: 4 / 3, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000', borderWidth: 1, borderColor: C.line },
  nosignal: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#070d15' },
  nosigTitle: { color: C.fg, letterSpacing: 4, fontSize: 15, fontWeight: '700' },
  nosigSub: { color: C.mut, fontSize: 12 },
  c: { position: 'absolute', width: 20, height: 20, opacity: 0.8 },
  tl: { top: 8, left: 8, borderTopWidth: 2, borderLeftWidth: 2 },
  tr: { top: 8, right: 8, borderTopWidth: 2, borderRightWidth: 2 },
  bl: { bottom: 8, left: 8, borderBottomWidth: 2, borderLeftWidth: 2 },
  br: { bottom: 8, right: 8, borderBottomWidth: 2, borderRightWidth: 2 },
  hud: { color: 'rgba(228,238,247,0.85)', fontFamily: MONO, fontSize: 10, letterSpacing: 1, textShadowColor: '#000', textShadowRadius: 4 },
  rec: { position: 'absolute', top: 13, left: 34, flexDirection: 'row', alignItems: 'center', gap: 5 },
  recDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.bad },
  camId: { position: 'absolute', top: 13, right: 34 },
  camTs: { position: 'absolute', top: 28, right: 34, color: 'rgba(228,238,247,0.6)' },
  stats: { flexDirection: 'row', gap: 8, marginTop: 8 },
  who: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6, minHeight: 42, padding: 8, marginBottom: 12, alignItems: 'center',
    borderWidth: 1, borderStyle: 'dashed', borderColor: C.lineStrong, borderRadius: 9,
  },
  emptyWho: { color: C.dim, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', marginHorizontal: 'auto' },
  face: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1 },
  faceName: { fontSize: 12, letterSpacing: 0.6 },
  faceScore: { fontSize: 11, fontFamily: MONO, opacity: 0.75 },
  enroll: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  input: {
    flex: 1, minWidth: 0, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, fontSize: 14,
    backgroundColor: '#050a11', color: C.fg, borderWidth: 1, borderColor: C.lineStrong,
  },
  faceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  av: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(43,245,154,0.1)', borderWidth: 1, borderColor: 'rgba(43,245,154,0.4)',
  },
  avText: { color: C.ok, fontWeight: '700', fontSize: 13 },
  faceRowName: { flex: 1, color: C.fg, fontSize: 14, letterSpacing: 0.5 },
  samples: { color: C.mut, fontFamily: MONO, fontSize: 11 },
  del: { width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
});
