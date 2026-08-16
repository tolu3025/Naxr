import { MD3Theme } from 'react-native-paper';

declare module 'react-native-paper' {
  export function useTheme(): Omit<MD3Theme, 'colors'> & {
    colors: MD3Theme['colors'] & {
      success: string;
      warning: string;
      danger: string;
      textMuted: string;
    };
  };
}
