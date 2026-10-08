// Pictogrammes repris du dashboard web (memes traces SVG).
import type { ColorValue } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

const PATHS: Record<string, string[]> = {
  shield: ['M16 2 28 7v9c0 7-5 12-12 14C9 28 4 23 4 16V7z'],
  pulse: ['M9 16h4l2-5 2 10 2-5h4'],
  gauge: ['M4 14a8 8 0 0 1 16 0', 'M12 14l4-4', 'M3 18h18'],
  camera: ['M3 7h4l2-2h6l2 2h4v12H3z'],
  sliders: ['M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0', 'M14 4v4M8 10v4M16 16v4'],
  bell: ['M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3z', 'M10 20a2 2 0 0 0 4 0'],
  terminal: ['M3 5h18v14H3z', 'm7 9 3 3-3 3M13 15h4'],
  flame: ['M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-9z'],
  user: ['M4 21a8 8 0 0 1 16 0', 'M11 6.5a1.5 1.5 0 1 1 1.5 1.5v1M12.5 10.5h.01'],
  warn: ['M12 3 2 20h20z', 'M12 10v4M12 17h.01'],
  logout: ['M10 4H5v16h5M14 8l4 4-4 4M18 12H9'],
  muteOn: ['M4 9h4l5-4v14l-5-4H4z', 'M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12'],
  muteOff: ['M4 9h4l5-4v14l-5-4H4z', 'm16 9 6 6m0-6-6 6'],
  nosignal: ['M3 3l18 18M10.6 6H15l2 3h3v9M6 6H4v12h12'],
};

interface Props {
  name: keyof typeof PATHS;
  size?: number;
  color: ColorValue;
  width?: number;
  viewBox?: number;
}

export function Icon({ name, size = 22, color, width = 1.8, viewBox = 24 }: Props) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${viewBox} ${viewBox}`} fill="none">
      {PATHS[name].map((d, i) => (
        <Path key={i} d={d} stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {name === 'camera' && <Circle cx={12} cy={13} r={3.5} stroke={color} strokeWidth={width} />}
      {name === 'user' && <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={width} />}
      {name === 'nosignal' && <Circle cx={12} cy={13} r={3} stroke={color} strokeWidth={width} />}
    </Svg>
  );
}

/** Logo Sentinel-X : bouclier et trace cardiaque. */
export function Logo({ size = 34, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Path d={PATHS.shield[0]} stroke={color} strokeWidth={1.6} strokeLinejoin="round" fill="rgba(62,230,255,0.06)" />
      <Path d={PATHS.pulse[0]} stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}
