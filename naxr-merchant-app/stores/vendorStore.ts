import { create } from 'zustand';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from '../constants/api';

interface VendorStore {
  phone: string | null;
  businessName: string;
  responseMode: 'auto' | 'manual' | 'suggestions';
  isConnected: boolean;
  isPro: boolean;
  revenue: { today: number; week: number; month: number };
  unreadMessages: number;
  
  setPhone: (phone: string) => void;
  setResponseMode: (mode: 'auto' | 'manual' | 'suggestions') => Promise<void>;
  setConnected: (connected: boolean) => void;
  fetchDashboard: () => Promise<void>;
  loadAuth: () => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useVendorStore = create<VendorStore>((set, get) => ({
  phone: null,
  businessName: '',
  responseMode: 'auto',
  isConnected: false,
  isPro: false,
  revenue: { today: 0, week: 0, month: 0 },
  unreadMessages: 0,
  
  setPhone: (phone) => set({ phone }),
  
  setResponseMode: async (mode) => {
    const { phone } = get();
    if (!phone) return;
    try {
      await axios.post(`${API_URL}/api/vendor/${phone}/settings`, {
        response_mode: mode
      });
      set({ responseMode: mode });
    } catch (e) {
      console.error("Error setting response mode:", e);
    }
  },
  
  setConnected: (connected) => set({ isConnected: connected }),
  
  fetchDashboard: async () => {
    const { phone } = get();
    if (!phone) return;
    try {
      const { data } = await axios.get(`${API_URL}/api/vendor/${phone}/dashboard`);
      set({
        businessName: data.business_name || '',
        revenue: data.revenue || { today: 0, week: 0, month: 0 },
        isConnected: !!data.auth_connected,
        unreadMessages: data.unread_messages || 0,
        isPro: !!data.isPro,
        responseMode: data.response_mode || 'auto'
      });
    } catch (e) {
      console.error("Error fetching dashboard:", e);
    }
  },

  loadAuth: async () => {
    try {
      const token = await AsyncStorage.getItem('token');
      const phone = await AsyncStorage.getItem('vendor_phone');
      if (token && phone) {
        set({ phone });
        axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        return true;
      }
    } catch (e) {
      console.error("Error loading auth:", e);
    }
    return false;
  },

  logout: async () => {
    try {
      await AsyncStorage.removeItem('token');
      await AsyncStorage.removeItem('vendor_phone');
      set({ phone: null, businessName: '', isConnected: false });
      delete axios.defaults.headers.common['Authorization'];
    } catch (e) {
      console.error("Error logging out:", e);
    }
  }
}));
