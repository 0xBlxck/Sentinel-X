// Acces operateur, deux modes au choix :
// - reconnaissance faciale : l'operateur se place devant la camera du PC serveur (vision/detect.py),
//   qui renvoie un jeton de session signe ;
// - cle d'API saisie (jamais ecrite dans le code).
// Cle ou jeton est ensuite stocke chiffre sur l'appareil.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { cleanHost, useSession } from '../lib/session';
import { C, MONO } from '../lib/theme';
import { Logo } from './Icon';
import { Backdrop, BigButton, Chips } from './ui';

type Mode = 'face' | 'key';
const MODES: Array<[Mode, string]> = [['face', 'Reconnaissance faciale'], ['key', "Clé d'API"]];

/** Apercu de la camera du PC serveur, pour se cadrer avant le scan. */
function CamPreview({ host, scanning }: { host: string; scanning: boolean }) {
  const base = `http://${cleanHost(host)}:8090`;
  const html = useMemo(() => `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;background:#000;overflow:hidden;display:grid;place-items:center;height:100vh">
    <span id="m" style="color:#4a5c70;font:12px monospace">Détecteur vision injoignable</span>
    <img id="v" style="position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;display:none">
    <script>
      var v = document.getElementById('v'), m = document.getElementById('m');
      function load() { v.src = '${base}/stream?t=' + Date.now(); }
      v.onload = function () { v.style.display = 'block'; m.style.display = 'none'; };
      v.onerror = function () { v.style.display = 'none'; m.style.display = 'block'; setTimeout(load, 2000); };
      load();
    </script></body></html>`, [base]);
  return (
    <View style={[st.cam, scanning && { borderColor: C.acc, shadowOpacity: 0.6 }]}>
      <WebView
        key={base}
        source={{ html, baseUrl: base }}
        originWhitelist={['*']}
        mixedContentMode="always"
        scrollEnabled={false}
        style={{ backgroundColor: '#000' }}
        pointerEvents="none"
      />
    </View>
  );
}

export function Login() {
  const ss = useSession();
  const [host, setHost] = useState(ss.host || '172.20.10.12');
  const [key, setKey] = useState('');
  const [mode, setMode] = useState<Mode>('face');
  const [busy, setBusy] = useState(false);

  // adresse et mode deja choisis lors d'une session precedente
  useEffect(() => {
    if (!ss.host) AsyncStorage.getItem('sx-host').then((h) => h && setHost(h)).catch(() => {});
    AsyncStorage.getItem('sx-login-mode').then((m) => m === 'key' && setMode('key')).catch(() => {});
  }, [ss.host]);

  const choose = (m: Mode) => {
    setMode(m);
    AsyncStorage.setItem('sx-login-mode', m).catch(() => {});
  };

  const submit = async () => {
    setBusy(true);
    if (mode === 'face') await ss.loginFace(host);
    else await ss.login(host, key);
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Backdrop danger={false} />
      <View style={st.wrap}>
        <View style={st.box}>
          <Logo size={64} color={C.acc} />
          <Text style={st.title}>SENTINEL<Text style={{ color: C.acc }}>-X</Text></Text>
          <Text style={st.sub}>Centre de commandement · accès opérateur</Text>

          <Chips items={MODES} value={mode} onChange={choose} />

          <Text style={st.label}>Adresse du PC serveur</Text>
          <TextInput
            style={st.input} value={host} onChangeText={setHost}
            placeholder="172.20.10.12" placeholderTextColor={C.dim}
            autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation"
          />
          {mode === 'face' ? (
            <>
              {!!cleanHost(host) && <CamPreview host={host} scanning={busy} />}
              <BigButton
                label={busy ? 'Regardez la caméra, puis tournez la tête' : 'Scanner mon visage'} kind="ok"
                onPress={submit} disabled={busy} style={{ alignSelf: 'stretch', marginTop: 6 }}
              />
            </>
          ) : (
            <>
              <Text style={st.label}>Clé d'accès API</Text>
              <TextInput
                style={[st.input, { letterSpacing: 1.5 }]} value={key} onChangeText={setKey}
                placeholder="••••••••••••••••" placeholderTextColor={C.dim}
                secureTextEntry autoCapitalize="none" autoCorrect={false}
                onSubmitEditing={submit} returnKeyType="go"
              />
              <BigButton label={busy ? 'Connexion…' : 'Authentification'} kind="ok" onPress={submit} disabled={busy} style={{ alignSelf: 'stretch', marginTop: 6 }} />
            </>
          )}
          <Text style={st.err}>{ss.loginError}</Text>
          <Text style={st.hint}>
            {mode === 'face'
              ? 'Seul face à la caméra du PC serveur, tournez la tête à gauche puis à droite (photos refusées). Session valable 12 h.'
              : 'Le téléphone doit être sur le même Wi-Fi que le PC serveur. La clé est stockée chiffrée sur l’appareil.'}
          </Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 16 },
  box: {
    alignItems: 'center', gap: 8, paddingVertical: 30, paddingHorizontal: 22, borderRadius: 14,
    backgroundColor: C.panelSolid, borderWidth: 1, borderColor: C.lineStrong,
    shadowColor: C.acc, shadowOpacity: 0.35, shadowRadius: 40, shadowOffset: { width: 0, height: 0 },
  },
  title: { color: C.fg, fontSize: 26, fontWeight: '700', letterSpacing: 5, marginTop: 4 },
  sub: { color: C.mut, fontSize: 13, marginBottom: 12 },
  label: { alignSelf: 'flex-start', color: C.mut, fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', marginTop: 4 },
  input: {
    alignSelf: 'stretch', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 8, fontFamily: MONO, fontSize: 15,
    backgroundColor: '#050a11', color: C.fg, borderWidth: 1, borderColor: C.lineStrong,
  },
  cam: {
    alignSelf: 'stretch', aspectRatio: 4 / 3, marginTop: 6, overflow: 'hidden', borderRadius: 8,
    backgroundColor: '#000', borderWidth: 1, borderColor: C.lineStrong,
    shadowColor: C.acc, shadowOpacity: 0, shadowRadius: 20, shadowOffset: { width: 0, height: 0 },
  },
  err: { minHeight: 18, color: C.bad, fontSize: 13, textAlign: 'center' },
  hint: { color: C.dim, fontSize: 11, textAlign: 'center' },
});
