// Briques visuelles communes : panneau a coins cyan, fond quadrille, clignotement, boutons.
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, Line, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import { alpha, C, MONO } from '../lib/theme';

/** Fond : grille de 40 px + halo, rouge quand la menace est haute (comme body[data-level]). */
export function Backdrop({ danger }: { danger: boolean }) {
  const tint = danger ? C.crit : C.acc;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <Pattern id="grid" width={40} height={40} patternUnits="userSpaceOnUse">
          <Line x1={0} y1={0} x2={40} y2={0} stroke={danger ? 'rgba(255,60,90,0.06)' : 'rgba(98,160,210,0.06)'} strokeWidth={1} />
          <Line x1={0} y1={0} x2={0} y2={40} stroke={danger ? 'rgba(255,60,90,0.06)' : 'rgba(98,160,210,0.06)'} strokeWidth={1} />
        </Pattern>
        <RadialGradient id="halo" cx="20%" cy="0%" r="80%">
          <Stop offset="0" stopColor={tint} stopOpacity={danger ? 0.16 : 0.1} />
          <Stop offset="1" stopColor={tint} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={C.bg} />
      <Rect width="100%" height="100%" fill="url(#halo)" />
      <Rect width="100%" height="100%" fill="url(#grid)" />
    </Svg>
  );
}

/** Panneau du dashboard : fond translucide, bordure fine, coins cyan en haut a gauche et en bas a droite. */
export function Panel({ title, sub, right, children, style, danger }: {
  title?: string; sub?: string; right?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle>; danger?: boolean;
}) {
  return (
    <View style={[s.panel, danger && s.panelDanger, style]}>
      <View style={[s.corner, s.cornerTL]} />
      <View style={[s.corner, s.cornerBR]} />
      {title ? (
        <View style={s.head}>
          <Text style={s.title}>{title}</Text>
          {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
          {right ? <View style={s.right}>{right}</View> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Opacite qui pulse (animation "blink" du CSS). */
export function Blink({ on = true, period = 1200, children, style }: {
  on?: boolean; period?: number; children: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!on) { v.setValue(1); return; }
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.3, duration: period / 2, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: period / 2, easing: Easing.linear, useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [on, period, v]);
  return <Animated.View style={[style, { opacity: v }]}>{children}</Animated.View>;
}

/** Gros bouton du dashboard (.big), variantes danger / ok. */
export function BigButton({ label, sub, kind, onPress, disabled, style }: {
  label: string; sub?: string; kind?: 'danger' | 'ok'; onPress: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const color = kind === 'danger' ? C.bad : kind === 'ok' ? C.ok : C.lineStrong;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.big,
        { borderColor: kind ? alpha(color, 0.55) : C.lineStrong, backgroundColor: kind ? alpha(color, pressed ? 0.2 : 0.1) : pressed ? 'rgba(98,160,210,0.12)' : 'rgba(98,160,210,0.06)' },
        pressed && { transform: [{ scale: 0.98 }] },
        disabled && { opacity: 0.5 },
        style,
      ]}
    >
      <Text style={[s.bigLabel, { color: kind === 'danger' ? '#ff8da0' : kind === 'ok' ? '#8dffcf' : C.fg }]}>{label}</Text>
      {sub ? <Text style={s.bigSub}>{sub}</Text> : null}
    </Pressable>
  );
}

/** Puces de filtre / segments (.chips, .seg). */
export function Chips<T extends string>({ items, value, onChange, tint }: {
  items: Array<[T, string]>; value: T; onChange: (v: T) => void; tint?: (v: T) => string | undefined;
}) {
  return (
    <View style={s.chips}>
      {items.map(([v, label]) => {
        const on = v === value;
        const c = (on && tint?.(v)) || C.acc;
        return (
          <Pressable key={v} onPress={() => onChange(v)} style={[s.chip, on && { borderColor: c, backgroundColor: alpha(c, 0.12) }]}>
            <Text style={[s.chipText, on && { color: C.fg }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Petite statistique encadree (.counters, .cam-stats). */
export function Stat({ label, value, mono = true }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel} numberOfLines={1}>{label}</Text>
      <Text style={[s.statValue, !mono && { fontFamily: undefined }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  panel: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 10,
    padding: 14, marginBottom: 12,
  },
  panelDanger: { borderColor: 'rgba(255,59,92,0.5)', backgroundColor: 'rgba(40,8,16,0.86)' },
  corner: { position: 'absolute', width: 14, height: 14, borderColor: C.acc, opacity: 0.55 },
  cornerTL: { top: -1, left: -1, borderTopWidth: 1.5, borderLeftWidth: 1.5, borderTopLeftRadius: 10 },
  cornerBR: { bottom: -1, right: -1, borderBottomWidth: 1.5, borderRightWidth: 1.5, borderBottomRightRadius: 10 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  title: { color: C.acc, fontSize: 12, fontWeight: '600', letterSpacing: 2.4, textTransform: 'uppercase' },
  sub: { color: C.mut, fontSize: 12, flexShrink: 1 },
  right: { marginLeft: 'auto' },
  big: { alignItems: 'center', gap: 2, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
  bigLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase' },
  bigSub: { color: C.mut, fontSize: 11 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingVertical: 6, paddingHorizontal: 11, borderRadius: 6, borderWidth: 1, borderColor: C.line },
  chipText: { color: C.mut, fontSize: 12, letterSpacing: 0.6 },
  stat: {
    flex: 1, minWidth: 0, backgroundColor: 'rgba(98,160,210,0.05)', borderWidth: 1, borderColor: C.line,
    borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10,
  },
  statLabel: { color: C.mut, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  statValue: { color: C.fg, fontFamily: MONO, fontSize: 18, fontWeight: '600', marginTop: 2 },
  note: { color: C.mut, fontSize: 12, marginTop: 8 },
  empty: { color: C.dim, fontSize: 13, letterSpacing: 1.3, textAlign: 'center', paddingVertical: 26 },
});
