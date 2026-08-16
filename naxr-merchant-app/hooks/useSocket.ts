import { useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import { API_URL } from '../constants/api';
import { useVendorStore } from '../stores/vendorStore';

interface UseSocketProps {
  onNewMessage?: (data: any) => void;
  onNewOrder?: (data: any) => void;
  onAiReplied?: (data: any) => void;
}

export const useSocket = ({ onNewMessage, onNewOrder, onAiReplied }: UseSocketProps = {}) => {
  const socketRef = useRef<Socket | null>(null);
  const phone = useVendorStore((state) => state.phone);

  useEffect(() => {
    if (!phone) return;

    // Connect to WebSocket with query parameter
    const socket = io(API_URL, {
      query: { vendor_phone: phone }
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to socket server');
      socket.emit('register_vendor', { vendor_phone: phone });
    });

    if (onNewMessage) {
      socket.on('new_message', onNewMessage);
    }

    if (onNewOrder) {
      socket.on('new_order', onNewOrder);
    }

    if (onAiReplied) {
      socket.on('ai_replied', onAiReplied);
    }

    return () => {
      socket.disconnect();
    };
  }, [phone, onNewMessage, onNewOrder, onAiReplied]);

  return socketRef.current;
};
