import React, { useEffect, useState } from 'react';
import { StyleSheet, View, FlatList, RefreshControl } from 'react-native';
import { Searchbar, List, Avatar, Badge, Text, useTheme } from 'react-native-paper';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { API_URL } from '../../constants/api';
import { useVendorStore } from '../../stores/vendorStore';
import { useSocket } from '../../hooks/useSocket';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

interface ChatListItem {
  customer_phone: string;
  customer_name?: string;
  last_message: string;
  last_message_time: string;
  unread_count: number;
  ai_handled: boolean;
}

export default function ChatsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const phone = useVendorStore((state) => state.phone);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [filteredChats, setFilteredChats] = useState<ChatListItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchChats = async () => {
    if (!phone) return;
    try {
      const response = await axios.get(`${API_URL}/api/vendor/${phone}/chats`);
      setChats(response.data);
    } catch (e) {
      console.warn("Utilizing mock chats data fallback:", e);
      // Fallback mocks
      const mockChats: ChatListItem[] = [
        { customer_phone: '2348123456789', customer_name: 'Tunde Bakare', last_message: 'Is the vintage shirt still available?', last_message_time: '12:30 PM', unread_count: 2, ai_handled: true },
        { customer_phone: '2349098765432', customer_name: 'Chioma Obi', last_message: 'Alright I will make transfer now.', last_message_time: '11:15 AM', unread_count: 0, ai_handled: false },
        { customer_phone: '2348055551111', customer_name: 'Musa Ibrahim', last_message: 'Thanks for the fast delivery!', last_message_time: 'Yesterday', unread_count: 0, ai_handled: true },
      ];
      setChats(mockChats);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchChats();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchChats();
  }, [phone]);

  useEffect(() => {
    const filtered = chats.filter(c => 
      c.customer_phone.includes(searchQuery) || 
      (c.customer_name && c.customer_name.toLowerCase().includes(searchQuery.toLowerCase()))
    );
    setFilteredChats(filtered);
  }, [searchQuery, chats]);

  // Connect socket for real-time inbox messages
  useSocket({
    onNewMessage: (msg) => {
      console.log('Realtime socket message in inbox:', msg);
      fetchChats();
    },
    onAiReplied: () => {
      fetchChats();
    }
  });

  const getInitials = (name?: string, phoneStr: string = '') => {
    if (name) {
      const parts = name.split(' ');
      return parts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
    }
    return phoneStr.substring(phoneStr.length - 2);
  };

  return (
    <View style={styles.container}>
      <Searchbar
        placeholder="Search customers..."
        onChangeText={setSearchQuery}
        value={searchQuery}
        style={styles.searchBar}
        elevation={1}
      />

      <FlatList
        data={filteredChats}
        keyExtractor={(item) => item.customer_phone}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} colors={[theme.colors.primary]} />
        }
        renderItem={({ item }) => (
          <List.Item
            title={item.customer_name || `+${item.customer_phone}`}
            description={item.last_message}
            onPress={() => router.push(`/chat/${item.customer_phone}`)}
            left={(props) => (
              <View style={styles.avatarContainer}>
                <Avatar.Text
                  size={48}
                  label={getInitials(item.customer_name, item.customer_phone)}
                  style={{ backgroundColor: theme.colors.primary }}
                />
                {item.unread_count > 0 && (
                  <Badge style={styles.avatarBadge}>{item.unread_count}</Badge>
                )}
              </View>
            )}
            right={() => (
              <View style={styles.rightContainer}>
                <Text style={styles.timeText}>{item.last_message_time}</Text>
                {item.ai_handled && (
                  <View style={styles.aiBadge}>
                    <MaterialCommunityIcons name="robot" size={14} color={theme.colors.success} />
                    <Text style={[styles.aiText, { color: theme.colors.success }]}>AI</Text>
                  </View>
                )}
              </View>
            )}
            style={styles.listItem}
            titleStyle={styles.listTitle}
            descriptionStyle={styles.listDesc}
          />
        )}
        ListEmptyComponent={() => (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="message-text-outline" size={48} color="#9ca3af" />
            <Text style={styles.emptyText}>No messages yet.</Text>
            <Text style={styles.emptySubtext}>Customers will appear here when they message your WhatsApp store.</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9f9f9',
  },
  searchBar: {
    margin: 16,
    backgroundColor: '#ffffff',
  },
  listItem: {
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    paddingVertical: 8,
  },
  listTitle: {
    fontWeight: 'bold',
    fontSize: 16,
  },
  listDesc: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 4,
  },
  avatarContainer: {
    position: 'relative',
    marginRight: 8,
    marginLeft: 8,
  },
  avatarBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    backgroundColor: '#25D366',
    color: '#ffffff',
  },
  rightContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginRight: 16,
  },
  timeText: {
    fontSize: 11,
    color: '#9ca3af',
  },
  aiBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    backgroundColor: '#e8f5e9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  aiText: {
    fontSize: 10,
    fontWeight: 'bold',
    marginLeft: 2,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 100,
    paddingHorizontal: 32,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#121212',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
    marginTop: 8,
  },
});
