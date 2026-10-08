// Contrat d'API : docs/API.md (memes messages que le dashboard web).

export type Severity = 'info' | 'medium' | 'high' | 'critical';

export interface Sample {
  t: number;
  temp: number | null;
  hum: number | null;
  gas: number | null;
  motion: boolean;
  score: number | null;
  anomaly: boolean;
}

export interface Alert {
  id: number;
  ts: string;
  source: string;
  type: string;
  severity: Severity;
  message: string | null;
  data: Record<string, unknown>;
}

export type Led = 'green' | 'red' | 'off';

export interface Device {
  buzzer: boolean;
  led: Led;
  gas_alarm: boolean;
  stranger: boolean;
}

export interface CamFace {
  name: string | null;
  score: number;
  small: boolean;
}

export interface CamStatus {
  camera: boolean;
  cam_fps: number;
  infer_ms: number;
  persons: number;
  face_recognition: boolean;
  faces: CamFace[];
}

export interface AuthorizedFace {
  name: string;
  samples: number;
}

export type LogTag = 'ws' | 'mqtt' | 'cmd' | 'alert' | 'ia' | 'cam';

export interface LogLine {
  id: number;
  t: number;
  tag: LogTag;
  msg: string;
}

export interface Toast {
  id: number;
  title: string;
  msg: string;
  sev: Severity;
}

export const LABELS = {
  type: {
    intrusion: 'Intrusion détectée',
    anomaly: 'Anomalie capteurs',
    motion: 'Mouvement détecté',
    unknown_face: 'Visage inconnu',
    access: 'Accès autorisé',
    gas: 'Alarme gaz / fumée',
    login: 'Connexion opérateur',
    spoof: 'Photo / écran suspecté',
  } as Record<string, string>,
  source: { vision: 'Vision', ml: 'IA', esp8266: 'Boîtier' } as Record<string, string>,
  sev: { info: 'Info', medium: 'Moyenne', high: 'Haute', critical: 'Critique' } as Record<string, string>,
};

export const alertTitle = (a: Alert) => LABELS.type[a.type] || a.type;
