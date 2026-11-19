import React from 'react';
import { StyleSheet } from 'react-native';
import { Button } from './tuffui/action-button';
import { StatusPill } from './tuffui/status-pill';
import type { TuffActionProps, TuffPillProps } from './tuff.types';

// Keep React Native layout props at the platform boundary, not in registry sources.
function domStyle(style: TuffActionProps['style']): React.CSSProperties {
  const flat = { ...StyleSheet.flatten(style) } as Record<string, unknown>;
  for (const [native, a, b] of [
    ['paddingHorizontal', 'paddingLeft', 'paddingRight'], ['paddingVertical', 'paddingTop', 'paddingBottom'],
    ['marginHorizontal', 'marginLeft', 'marginRight'], ['marginVertical', 'marginTop', 'marginBottom'],
  ]) {
    if (flat[native] !== undefined) {
      flat[a] ??= flat[native]; flat[b] ??= flat[native]; delete flat[native];
    }
  }
  // Native-only props are intentionally handled by the native adapter.
  for (const key of ['elevation', 'shadowColor', 'shadowOffset', 'shadowOpacity', 'shadowRadius']) delete flat[key];
  return flat as React.CSSProperties;
}
export function TuffAction({ label, onPress, disabled = false, children, style }: TuffActionProps) {
  return <Button variant="quiet" aria-label={label} onClick={onPress} disabled={disabled}
    className="orbit-action" style={{ ...(!children ? { backgroundColor: 'var(--brand)', color: 'var(--brand-foreground)', padding: 12, fontWeight: 600 } : {}), ...domStyle(style) }}>{children ?? label}</Button>;
}
export function TuffPill({ text, bright = false }: TuffPillProps) {
  return <StatusPill tone={bright ? 'positive' : 'neutral'} size="sm" className="orbit-pill">{text}</StatusPill>;
}
