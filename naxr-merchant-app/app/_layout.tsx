import { useEffect, useState } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import { PaperProvider } from 'react-native-paper';
import { theme } from '../theme';
import { useVendorStore } from '../stores/vendorStore';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const { loadAuth, phone } = useVendorStore();
  const [isReady, setIsReady] = useState(false);

  // Perform initial session restore from AsyncStorage only once on mount
  useEffect(() => {
    async function initSession() {
      try {
        await loadAuth();
      } catch (e) {
        console.error("Failed to restore session:", e);
      } finally {
        setIsReady(true);
      }
    }
    initSession();
  }, []);

  // Monitor auth changes (phone store state) and navigate accordingly
  useEffect(() => {
    if (!isReady) return;

    const inTabs = segments[0] === '(tabs)';
    const isAuthenticated = !!phone;

    if (!isAuthenticated && inTabs) {
      // Redirect to login if not authenticated and trying to access tabs
      router.replace('/login');
    } else if (isAuthenticated && !inTabs) {
      // Redirect to dashboard tab if authenticated and outside tabs
      router.replace('/(tabs)');
    }
  }, [phone, segments, isReady]);

  if (!isReady) return null;

  return (
    <PaperProvider theme={theme} children={<Slot />} />
  );
}

