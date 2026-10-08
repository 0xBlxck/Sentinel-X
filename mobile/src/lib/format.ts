const pad2 = (n: number) => String(n).padStart(2, '0');

export const hms = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
export const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

export const fmt = (v: number | null | undefined, n = 1) =>
  v == null || Number.isNaN(v) ? '--' : Number(v).toFixed(n);

/** L'API renvoie des microsecondes ("14:49:19.634632+00:00") : Hermes (moteur JS du telephone)
 *  ne les lit pas toujours, contrairement a Chrome. On garde les millisecondes. */
export const normTs = (s: string) => s.replace(/(\.\d{3})\d+/, '$1');

export const ago =(s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

export const dateLabel = (d: Date) =>
  d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
