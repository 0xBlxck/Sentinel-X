// Niveau de menace : meme regle que renderThreat() dans dashboard/app.js.
import type { Alert, Device } from './types';

export const RECENT_MS = 60 * 1000;     // une alerte compte dans le niveau pendant 1 min
export const ESP_SILENT_MS = 30000;     // au-dela, le boitier est considere hors ligne

export const LEVELS = ['NOMINAL', 'VIGILANCE', 'ALERTE', 'DANGER', 'CRITIQUE'];

interface ThreatInput {
  now: number;
  alerts: Alert[];
  acked: Set<number>;
  anomaly: boolean;
  motion: boolean;
  lastTelemetry: number;
  device: Device;
  wsOpen: boolean;
  mqtt: boolean | null;
}

export function computeThreat(s: ThreatInput): { level: number; desc: string } {
  // une alerte prise en compte par l'operateur ne fait plus monter le niveau
  const recent = s.alerts.filter((a) => s.now - new Date(a.ts).getTime() < RECENT_MS && !s.acked.has(a.id));
  const has = (fn: (a: Alert) => boolean) => recent.some(fn);
  const intrusion = has((a) => a.type === 'intrusion');
  const anomaly = s.anomaly || has((a) => a.source === 'ml');
  const espDown = !!s.lastTelemetry && s.now - s.lastTelemetry > ESP_SILENT_MS;
  // l'alarme gaz est un etat physique du boitier : elle compte tant qu'elle dure
  const gas = s.device.gas_alarm || has((a) => a.type === 'gas');

  if (gas || has((a) => a.severity === 'critical') || (intrusion && anomaly)) {
    return {
      level: 4,
      desc: gas ? 'Alarme gaz / fumée sur le boîtier'
        : intrusion && anomaly ? 'Intrusion et anomalie simultanées'
          : has((a) => a.type === 'unknown_face') ? 'Visage inconnu sur site' : 'Alerte critique en cours',
    };
  }
  if (has((a) => a.severity === 'high')) {
    return { level: 3, desc: intrusion ? 'Présence humaine détectée par la caméra' : 'Anomalie capteurs confirmée' };
  }
  if (anomaly || espDown || has((a) => a.severity === 'medium')) {
    return { level: 2, desc: anomaly ? 'Mesures hors du régime appris' : espDown ? 'Boîtier hors ligne' : 'Mouvement détecté sur site' };
  }
  if (s.motion || !s.wsOpen || s.mqtt === false) {
    return {
      level: 1,
      desc: !s.wsOpen ? 'Liaison serveur interrompue' : s.mqtt === false ? 'Broker MQTT injoignable' : 'Mouvement en zone surveillée',
    };
  }
  return { level: 0, desc: 'Aucune menace active' };
}
