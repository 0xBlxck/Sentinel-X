// Memes jetons que dashboard/app.css : la DA du centre de commandement, en version mobile.
import { Platform } from 'react-native';

export const C = {
  bg: '#04070c',
  bg2: '#070c14',
  panel: 'rgba(12, 20, 32, 0.86)',
  panelSolid: '#0b131f',
  line: 'rgba(98, 160, 210, 0.16)',
  lineStrong: 'rgba(98, 180, 230, 0.34)',
  fg: '#e4eef7',
  mut: '#7f93a8',
  dim: '#4a5c70',
  acc: '#3ee6ff',
  ok: '#2bf59a',
  warn: '#ffb020',
  bad: '#ff3b5c',
  crit: '#ff1f4b',
  temp: '#ff7a45',
  hum: '#3ea8ff',
  gas: '#ffc93e',
  ai: '#b78cff',
} as const;

export const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Couleur hexadecimale avec transparence (equivalent du alpha() du dashboard). */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

export const SEV_COLOR: Record<string, string> = {
  info: C.acc,
  medium: C.warn,
  high: C.bad,
  critical: C.crit,
};

// Niveaux de menace : NOMINAL -> CRITIQUE, memes couleurs que .threat[data-level]
export const LEVEL_COLOR = [C.ok, C.acc, C.warn, C.bad, C.crit];
