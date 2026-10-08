// Session operateur : configuration du serveur, flux temps reel (WebSocket), commandes et alertes.
// Reprend la logique de dashboard/app.js ; tous les ecrans lisent cet etat via useSession().
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Vibration } from 'react-native';
import { hms, normTs } from './format';
import { computeThreat, ESP_SILENT_MS } from './threat';
import {
  alertTitle, LABELS,
  type Alert, type AuthorizedFace, type CamStatus, type Device, type LogLine, type LogTag, type Sample,
  type Severity, type Toast,
} from './types';

export const WINDOW_MS = 5 * 60 * 1000;  // fenetre des graphiques
export const MIN_TRAIN = 60;             // cf. server/api/app/ml.py
export const GAS_ALARM = 300;            // cf. GAS_ALARM_ON dans firmware/src/main.cpp
const CONFIRM_MS = 5000;                 // delai de confirmation d'une commande par le boitier
const API_PORT = 8000;
const CAM_PORT = 8090;
const K = { host: 'sx-host', key: 'sx-key', acked: 'sx-acked', muted: 'sx-muted' };

type Cmd = Partial<Pick<Device, 'buzzer' | 'led'>>;

/** Accepte "172.20.10.12", "http://172.20.10.12:8000/" ... et garde l'hote seul. */
export function cleanHost(raw: string): string {
  return raw.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
}

async function timedFetch(url: string, init: RequestInit = {}, ms = 4000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function useSessionState() {
  const [ready, setReady] = useState(false);
  const [host, setHost] = useState('');
  const [key, setKey] = useState('');
  const [authed, setAuthed] = useState(false);

  const [history, setHistory] = useState<Sample[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [acked, setAcked] = useState<Set<number>>(new Set());
  const [device, setDevice] = useState<Device>({ buzzer: false, led: 'off', gas_alarm: false, stranger: false });
  const [sync, setSync] = useState({ pending: false, at: 0 });
  const [live, setLive] = useState({ samples: 0, lastTelemetry: 0, lastMotion: 0, anomaly: false, motion: false, gasWarmup: false });
  const [modelReady, setModelReady] = useState(false);
  const [mqtt, setMqtt] = useState<boolean | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [wsSeen, setWsSeen] = useState(false);
  const [cam, setCam] = useState<CamStatus | null>(null);
  const [faces, setFaces] = useState<AuthorizedFace[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [crit, setCrit] = useState<Alert[] | null>(null);
  const [muted, setMutedState] = useState(false);
  const [now, setNow] = useState(Date.now());

  const seq = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const keyRef = useRef('');
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const api = `http://${host}:${API_PORT}`;
  const camBase = `http://${host}:${CAM_PORT}`;

  // ---------- journal et notifications ----------
  const log = useCallback((tag: LogTag, msg: string) => {
    setLogs((l) => [...l.slice(-199), { id: ++seq.current, t: Date.now(), tag, msg }]);
  }, []);

  const toast = useCallback((title: string, msg: string, sev: Severity = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, title, msg, sev }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  // ---------- stockage ----------
  useEffect(() => {
    (async () => {
      const [h, a, m] = await Promise.all([
        AsyncStorage.getItem(K.host), AsyncStorage.getItem(K.acked), AsyncStorage.getItem(K.muted),
      ]).catch(() => [null, null, null]);
      const k = await SecureStore.getItemAsync(K.key).catch(() => null);
      if (h) setHost(h);
      try { setAcked(new Set(JSON.parse(a || '[]'))); } catch { /* illisible */ }
      setMutedState(m === '1');
      if (h && k) { keyRef.current = k; setKey(k); setAuthed(true); }
      setReady(true);
    })();
  }, []);

  const setMuted = useCallback((on: boolean) => {
    setMutedState(on);
    AsyncStorage.setItem(K.muted, on ? '1' : '0').catch(() => {});
    if (on) Vibration.cancel();
  }, []);

  // ---------- requetes ----------
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}, base = api): Promise<T> => {
    const r = await timedFetch(base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': keyRef.current, ...(init.headers || {}) },
    }, path.startsWith('/faces') && init.method === 'POST' ? 15000 : 6000);
    const body = await r.json().catch(() => ({}));
    if (r.status === 401 && base === api) { logout('Clé refusée par le serveur.'); throw new Error('401'); }
    if (!r.ok) throw new Error((body as { error?: string }).error || String(r.status));
    return body as T;
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- session ----------
  const [loginError, setLoginError] = useState('');

  const login = useCallback(async (rawHost: string, k: string): Promise<boolean> => {
    const h = cleanHost(rawHost);
    setLoginError('');
    if (!h || !k.trim()) { setLoginError('Adresse et clé requises.'); return false; }
    try {
      const r = await timedFetch(`http://${h}:${API_PORT}/api/v1/alerts?limit=1`, { headers: { 'X-API-Key': k.trim() } });
      if (r.status === 401) { setLoginError('Clé invalide.'); return false; }
      if (!r.ok) throw new Error(String(r.status));
    } catch (e) {
      setLoginError(`Serveur injoignable (${(e as Error).name === 'AbortError' ? 'délai dépassé' : (e as Error).message}). Même Wi-Fi que le PC ?`);
      return false;
    }
    keyRef.current = k.trim();
    setHost(h);
    setKey(k.trim());
    await AsyncStorage.setItem(K.host, h).catch(() => {});
    await SecureStore.setItemAsync(K.key, k.trim()).catch(() => {});
    setAuthed(true);
    return true;
  }, []);

  const logout = useCallback((err?: string) => {
    keyRef.current = '';
    setKey('');
    setAuthed(false);
    setWsOpen(false);
    setWsSeen(false);
    setCrit(null);
    Vibration.cancel();
    SecureStore.deleteItemAsync(K.key).catch(() => {});
    if (err) setLoginError(err);
  }, []);

  // ---------- telemetrie ----------
  const onTelemetry = useCallback((m: Record<string, unknown>) => {
    const p: Sample = {
      t: Date.now(), temp: m.temp as number, hum: m.hum as number, gas: m.gas as number,
      motion: !!m.motion, score: (m.score as number) ?? null, anomaly: !!m.anomaly,
    };
    setHistory((h) => {
      const cutoff = Date.now() - WINDOW_MS - 10000;
      const next = h.filter((q) => q.t >= cutoff);
      next.push(p);
      return next;
    });
    setModelReady(!!m.model_ready);
    setLive((l) => {
      if (p.anomaly && !l.anomaly) {
        log('ia', `Anomalie : T=${p.temp} H=${p.hum} G=${p.gas} score=${p.score?.toFixed(3)}`);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      }
      if (l.gasWarmup && !m.warmup) log('mqtt', 'MQ-2 préchauffé : mesures de gaz prises en compte par l’IA');
      return {
        samples: l.samples + 1, lastTelemetry: p.t, lastMotion: p.motion ? p.t : l.lastMotion,
        anomaly: p.anomaly, motion: p.motion, gasWarmup: !!m.warmup,
      };
    });
    log('mqtt', `T=${p.temp}°C H=${p.hum}% G=${p.gas} M=${+p.motion}${p.score != null ? ` S=${p.score.toFixed(3)}` : ''}`);
  }, [log]);

  // ---------- alertes ----------
  const ack = useCallback((ids: number[]) => {
    setAcked((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => id != null && next.add(id));
      if (next.size === prev.size) return prev;
      AsyncStorage.setItem(K.acked, JSON.stringify([...next].slice(-500))).catch(() => {});
      return next;
    });
  }, []);

  const onAlert = useCallback((a: Alert) => {
    setAlerts((l) => [a, ...l].slice(0, 500));
    log('alert', `[${a.source}] ${a.type} ${a.severity} — ${a.message || ''}`);
    if (a.severity === 'high' || a.severity === 'critical') {
      setCrit((c) => (c ? [...c, a] : [a]));
    } else {
      toast(alertTitle(a), a.message || LABELS.source[a.source] || a.source, a.severity);
      if (!mutedRef.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }, [log, toast]);

  // alerte critique : vibration en boucle (equivalent de la sirene web) tant qu'elle n'est pas acquittee
  useEffect(() => {
    if (crit && !muted) Vibration.vibrate([0, 600, 400, 600, 400], true);
    else Vibration.cancel();
    return () => Vibration.cancel();
  }, [crit, muted]);

  const closeCritical = useCallback(() => {
    setCrit((c) => {
      if (c) {
        ack(c.map((a) => a.id));
        log('alert', `Alerte acquittée par l'opérateur${c.length > 1 ? ` (${c.length} événements)` : ''}`);
      }
      return null;
    });
  }, [ack, log]);

  // ---------- commandes ----------
  const [busy, setBusy] = useState(false);
  const [cmdNote, setCmdNote] = useState('Aucune commande envoyée.');

  const command = useCallback(async (body: Cmd, label: string) => {
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      const r = await request<{ sent: Cmd }>('/api/v1/command', { method: 'POST', body: JSON.stringify(body) });
      setDevice((d) => ({ ...d, ...r.sent }));
      setSync({ pending: true, at: Date.now() });
      const txt = Object.entries(r.sent).map(([k, v]) => `${k}=${v}`).join(' ');
      log('cmd', `${label} → sentinel/cmd ${txt}`);
      setCmdNote(`${label} · publiée sur MQTT (QoS 1) à ${hms(new Date())}, en attente du boîtier…`);
      toast(label, `Commande publiée : ${txt}`, 'info');
      return true;
    } catch (e) {
      if ((e as Error).message !== '401') {
        log('cmd', `Échec ${label} (${(e as Error).message})`);
        toast('Commande refusée', `${label} : erreur ${(e as Error).message}`, 'high');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [request, log, toast]);

  const onCommand = useCallback((m: Record<string, unknown>) => {
    const { kind, chime, who, ...cmd } = m as Record<string, unknown> & { chime?: string; who?: string };
    if (chime) log('cmd', `Sonnerie « ${chime} » jouée par le boîtier${who ? ` (${who})` : ''}`);
    const keys = Object.keys(cmd).filter((k) => k === 'buzzer' || k === 'led');
    if (!keys.length) return;
    const d = deviceRef.current as unknown as Record<string, unknown>;
    if (keys.every((k) => d[k] === cmd[k])) return;  // deja connu (commande locale)
    setDevice((prev) => ({ ...prev, ...(Object.fromEntries(keys.map((k) => [k, cmd[k]])) as Cmd) }));
    log('cmd', `Actionneurs : ${keys.map((k) => `${k}=${cmd[k]}`).join(' ')} (autre opérateur ou vision)`);
  }, [log]);

  // etat reellement applique, publie par l'ESP sur sentinel/state apres chaque commande
  const onState = useCallback((m: Record<string, unknown>) => {
    const wasGas = deviceRef.current.gas_alarm;
    const next: Device = {
      buzzer: !!m.buzzer, led: (m.led as Device['led']) ?? deviceRef.current.led,
      gas_alarm: !!m.gas_alarm, stranger: !!m.stranger,
    };
    setDevice(next);
    setSync({ pending: false, at: Date.now() });
    const txt = `buzzer=${next.buzzer} led=${next.led}`;
    setCmdNote(`Confirmé par le boîtier à ${hms(new Date())} : ${txt}${next.gas_alarm ? ' · alarme gaz en cours, LED maintenue au rouge' : ''}`);
    log('cmd', `Boîtier : ${txt}${next.gas_alarm ? ' gaz=ALARME' : ''}${next.stranger ? ' inconnu=oui' : ''}`);
    if (wasGas && !next.gas_alarm) toast('Fin de l’alarme gaz', 'Le niveau de gaz est redescendu sous le seuil', 'info');
  }, [log, toast]);

  // ---------- WebSocket ----------
  useEffect(() => {
    if (!authed || !host) return;
    let stopped = false, retry = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`ws://${host}:${API_PORT}/ws?key=${encodeURIComponent(keyRef.current)}`);
      wsRef.current = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        retry = 0;
        setWsOpen(true);
        setWsSeen(true);
        log('ws', 'Canal temps réel ouvert');
      };
      ws.onmessage = (e) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.kind === 'telemetry') onTelemetry(m);
        else if (m.kind === 'alert') onAlert({ ...(m as unknown as Alert), ts: normTs(String(m.ts)) });
        else if (m.kind === 'command') onCommand(m);
        else if (m.kind === 'state') onState(m);
      };
      ws.onerror = (e) => {
        log('ws', `Erreur du canal temps réel : ${(e as unknown as { message?: string }).message || 'réseau'}`);
      };
      ws.onclose = (e) => {
        if (wsRef.current !== ws) return;
        setWsOpen(false);
        if (e.code === 4401) { logout('Clé refusée par le serveur.'); return; }
        // code et raison au journal : c'est le seul indice quand le telephone perd la socket
        log('ws', `Canal temps réel ${opened ? 'fermé' : 'injoignable'} (code ${e.code}${e.reason ? `, ${e.reason}` : ''}), reconnexion…`);
        if (!stopped) timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
      };
    };
    connect();
    // retour au premier plan : on relance tout de suite si le systeme a coupe la socket
    const sub = AppState.addEventListener('change', (st) => {
      // seulement si la socket est vraiment morte : une connexion en cours ne doit pas etre coupee
      const rs = wsRef.current?.readyState;
      if (st === 'active' && (rs === undefined || rs === WebSocket.CLOSED || rs === WebSocket.CLOSING)) {
        clearTimeout(timer);
        retry = 0;
        wsRef.current?.close();
        connect();
      }
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      sub.remove();
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [authed, host, log, logout, onAlert, onCommand, onState, onTelemetry]);

  // ---------- historique au demarrage ----------
  useEffect(() => {
    if (!authed || !host) return;
    log('ws', 'Opérateur authentifié');
    (async () => {
      try {
        const [tele, al] = await Promise.all([
          request<Array<Record<string, unknown>>>('/api/v1/telemetry?limit=200'),
          request<Alert[]>('/api/v1/alerts?limit=200'),
        ]);
        const hist = tele.map((p) => ({
          t: new Date(normTs(String(p.ts))).getTime(), temp: p.temp as number, hum: p.hum as number, gas: p.gas as number,
          motion: !!p.motion, score: null, anomaly: !!p.anomaly,
        })).filter((p) => p.t >= Date.now() - WINDOW_MS);
        setHistory(hist);
        setAlerts(al.map((a) => ({ ...a, ts: normTs(a.ts) })));
        const last = hist.at(-1);
        if (last) setLive((l) => ({ ...l, lastTelemetry: last.t }));
        log('ws', `Historique chargé : ${tele.length} mesures, ${al.length} alertes`);
      } catch (e) {
        if ((e as Error).message !== '401') log('ws', `Historique indisponible (${(e as Error).message})`);
      }
    })();
  }, [authed, host]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- sante de l'API (5 s) et camera (1,5 s) ----------
  useEffect(() => {
    if (!authed || !host) return;
    let alive = true;
    const health = async () => {
      try {
        const h = await (await timedFetch(`${api}/api/v1/health`)).json();
        if (!alive) return;
        setMqtt((prev) => {
          if (prev !== h.mqtt) log('mqtt', h.mqtt ? 'API abonnée au broker Mosquitto (TLS)' : 'Broker MQTT injoignable');
          return h.mqtt;
        });
        setModelReady((prev) => {
          if (h.model_ready && !prev) log('ia', 'Isolation Forest entraîné : détection active');
          return h.model_ready;
        });
      } catch {
        if (alive) setMqtt(null);
      }
    };
    const camera = async () => {
      try {
        const st: CamStatus = await (await timedFetch(`${camBase}/status`, {}, 1500)).json();
        if (alive) setCam(st);
      } catch {
        if (alive) setCam(null);
      }
    };
    health();
    camera();
    const t1 = setInterval(health, 5000);
    const t2 = setInterval(camera, 1500);
    return () => { alive = false; clearInterval(t1); clearInterval(t2); };
  }, [authed, host, api, camBase, log]);

  // horloge : rafraichit les durees ("il y a 12 s"), le niveau de menace et la confirmation
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ---------- visages autorises ----------
  const camOn = !!cam?.camera;
  const loadFaces = useCallback(async () => {
    try { setFaces(await request<AuthorizedFace[]>('/faces', {}, camBase)); } catch { /* detecteur arrete */ }
  }, [request, camBase]);
  const camWasOn = useRef(false);
  useEffect(() => {
    if (!authed || camOn === camWasOn.current) return;
    camWasOn.current = camOn;
    log('cam', camOn ? 'Flux vision connecté' : 'Flux vision perdu');
    if (camOn) loadFaces();
  }, [camOn, authed]); // eslint-disable-line react-hooks/exhaustive-deps

  const enroll = useCallback(async (name: string) => {
    const r = await request<{ name: string; samples: number }>('/faces', { method: 'POST', body: JSON.stringify({ name }) }, camBase);
    log('cam', `Visage enregistré : ${r.name} (${r.samples} échantillons)`);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    loadFaces();
    return r;
  }, [request, camBase, log, loadFaces]);

  const deleteFace = useCallback(async (name: string) => {
    try {
      await request('/faces/' + encodeURIComponent(name), { method: 'DELETE' }, camBase);
      log('cam', `Visage retiré : ${name}`);
      loadFaces();
    } catch (e) {
      toast('Suppression impossible', (e as Error).message, 'high');
    }
  }, [request, camBase, log, loadFaces, toast]);

  // ---------- etats derives ----------
  const threat = useMemo(() => computeThreat({
    now, alerts, acked, anomaly: live.anomaly, motion: live.motion, lastTelemetry: live.lastTelemetry,
    device, wsOpen, mqtt,
  }), [now, alerts, acked, live, device, wsOpen, mqtt]);

  const espAge = live.lastTelemetry ? (now - live.lastTelemetry) / 1000 : Infinity;
  const syncState: 'none' | 'wait' | 'ok' | 'late' = !sync.at ? 'none'
    : sync.pending ? (now - sync.at > CONFIRM_MS ? 'late' : 'wait') : 'ok';

  const offline = !authed ? ''
    : !wsOpen && wsSeen ? 'Liaison serveur perdue · reconnexion automatique en cours'
      : mqtt === false ? 'Broker MQTT injoignable · les mesures du boîtier n’arrivent plus'
        : live.lastTelemetry && espAge * 1000 > ESP_SILENT_MS
          ? `Boîtier hors ligne · dernière mesure il y a ${Math.round(espAge)} s · vérifier son alimentation et le Wi-Fi` : '';
  const offlineKind = offline.split(' ·')[0];
  const prevOffline = useRef('');
  useEffect(() => {
    if (prevOffline.current !== offlineKind) {
      if (offlineKind) log('alert', offlineKind);
      else if (prevOffline.current) log('ws', 'Liaison rétablie');
      prevOffline.current = offlineKind;
    }
  }, [offlineKind, log]);

  return {
    ready, host, authed, login, logout, loginError, api, camBase,
    history, alerts, acked, ack, device, syncState, syncAt: sync.at, live, modelReady, mqtt, wsOpen,
    cam, faces, enroll, deleteFace, logs, toasts, crit, closeCritical, muted, setMuted,
    now, threat, espAge, offline, command, busy, cmdNote,
  };
}

export type SessionValue = ReturnType<typeof useSessionState>;
const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const value = useSessionState();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession hors de SessionProvider');
  return v;
}
