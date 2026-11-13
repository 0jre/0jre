import type React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
export type TuffActionProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};
export type TuffPillProps = { text: string; bright?: boolean };
