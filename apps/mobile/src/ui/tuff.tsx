// Native counterpart of the TUFFUI web components. DOM/Tailwind never enters a native bundle.
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from './theme';
import type { TuffActionProps, TuffPillProps } from './tuff.types';
export function TuffAction({ label, onPress, disabled = false, children, style }: TuffActionProps) {
  const { colors: c } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [{ borderRadius: 16 }, !children && { backgroundColor: c.brand, padding: 12, alignItems: 'center' }, style, (pressed || disabled) && { opacity: 0.42 }]}>{children ?? <Text style={{ color: c.onBrand, fontWeight: '600' }}>{label}</Text>}</Pressable>;
}
export function TuffPill({ text, bright = false }: TuffPillProps) {
  const { colors: c } = useTheme();
  return <View style={{ alignSelf: 'flex-start', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: bright ? c.positiveTint : c.raised }}>
    <Text style={{ fontSize: 10, fontWeight: '600', color: bright ? c.green : c.muted }}>{text}</Text>
  </View>;
}
