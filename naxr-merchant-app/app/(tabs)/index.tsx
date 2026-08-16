import React, { useEffect, useState } from 'react';
import { StyleSheet, View, ScrollView, RefreshControl } from 'react-native';
import { Card, Text, Button, Badge, IconButton, useTheme, Banner } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useVendorStore } from '../../stores/vendorStore';
import { useSocket } from '../../hooks/useSocket';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

export default function DashboardScreen() {
  const router = useRouter();
  const theme = useTheme();
  
  const {
    businessName,
    revenue,
    isConnected,
    isPro,
    responseMode,
    unreadMessages,
    fetchDashboard,
    setResponseMode
  } = useVendorStore();

  const [refreshing, setRefreshing] = useState(false);
  const [recentOrders, setRecentOrders] = useState<any[]>([]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchDashboard();
    // Simulate fetching recent orders
    setRecentOrders([
      { id: '1', customerPhone: '234803***89', amount: 12000, status: 'PAID', date: 'Today' },
      { id: '2', customerPhone: '234905***12', amount: 4500, status: 'PENDING', date: 'Today' },
      { id: '3', customerPhone: '234814***66', amount: 15000, status: 'BOOKED', date: 'Yesterday' },
    ]);
    setRefreshing(false);
  };

  useEffect(() => {
    handleRefresh();
  }, []);

  // Connect socket for real-time order/message updates
  useSocket({
    onNewOrder: (order) => {
      console.log('Realtime Order Received:', order);
      handleRefresh();
    },
    onNewMessage: () => {
      fetchDashboard();
    }
  });

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} colors={[theme.colors.primary]} />
      }
    >
      {/* AI banner */}
      <Banner
        visible={true}
        icon={({ size }) => (
          <MaterialCommunityIcons 
            name={responseMode === 'auto' ? 'robot' : 'hand-back-right'} 
            size={size} 
            color={responseMode === 'auto' ? theme.colors.success : theme.colors.warning} 
          />
        )}
      >
        {responseMode === 'auto'
          ? 'Naxr AI Agent is Active — Auto replying to conversations and generating Kora Pay references.'
          : 'Manual Mode Enabled — AI agent is paused.'}
      </Banner>

      <View style={styles.content}>
        {/* Header business info */}
        <View style={styles.businessHeader}>
          <View style={styles.headerInfo}>
            <Text style={styles.businessTitle}>{businessName || 'My Store'}</Text>
            <View style={styles.connectionStatus}>
              <View style={[styles.statusDot, { backgroundColor: isConnected ? theme.colors.success : '#9ca3af' }]} />
              <Text style={styles.statusText}>{isConnected ? 'Baileys Connected' : 'WhatsApp Disconnected'}</Text>
            </View>
          </View>
          <View style={styles.iconContainer}>
            <IconButton
              icon="bell"
              size={24}
              onPress={() => {}}
            />
            {unreadMessages > 0 && (
              <Badge style={styles.badge}>{unreadMessages}</Badge>
            )}
          </View>
        </View>

        {/* Revenue Section */}
        <Text style={styles.sectionTitle}>Sales Performance</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.revenueScroll}>
          <Card style={styles.revenueCard}>
            <Card.Content>
              <Text style={styles.cardLabel}>Today's Sales</Text>
              <Text style={styles.cardValue}>₦{(revenue?.today || 0).toLocaleString()}</Text>
              <Text style={[styles.cardTrend, { color: theme.colors.success }]}>+12% vs yesterday</Text>
            </Card.Content>
          </Card>

          <Card style={styles.revenueCard}>
            <Card.Content>
              <Text style={styles.cardLabel}>This Week</Text>
              <Text style={styles.cardValue}>₦{(revenue?.week || 0).toLocaleString()}</Text>
              <Text style={[styles.cardTrend, { color: theme.colors.success }]}>+8% vs last week</Text>
            </Card.Content>
          </Card>

          <Card style={styles.revenueCard}>
            <Card.Content>
              <Text style={styles.cardLabel}>This Month</Text>
              <Text style={styles.cardValue}>₦{(revenue?.month || 0).toLocaleString()}</Text>
              <Text style={[styles.cardTrend, { color: theme.colors.success }]}>+24% vs last month</Text>
            </Card.Content>
          </Card>
        </ScrollView>

        {/* Quick Actions */}
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.gridContainer}>
          <View style={styles.gridRow}>
            <Card style={styles.gridCard} onPress={() => router.push('/(tabs)/products')}>
              <Card.Content style={styles.gridContent}>
                <MaterialCommunityIcons name="package-variant-closed" size={32} color={theme.colors.primary} />
                <Text style={styles.gridLabel}>Products</Text>
              </Card.Content>
            </Card>

            <Card style={styles.gridCard} onPress={() => router.push('/(tabs)/chats')}>
              <Card.Content style={styles.gridContent}>
                <MaterialCommunityIcons name="message-text" size={32} color={theme.colors.primary} />
                <Text style={styles.gridLabel}>Chats Inbox</Text>
              </Card.Content>
            </Card>
          </View>

          <View style={styles.gridRow}>
            <Card style={styles.gridCard} onPress={() => router.push('/(tabs)/settings')}>
              <Card.Content style={styles.gridContent}>
                <MaterialCommunityIcons name="robot" size={32} color={theme.colors.primary} />
                <Text style={styles.gridLabel}>AI Config</Text>
              </Card.Content>
            </Card>

            <Card style={styles.gridCard} onPress={() => router.push('/knowledge')}>
              <Card.Content style={styles.gridContent}>
                <MaterialCommunityIcons name="brain" size={32} color={theme.colors.primary} />
                <Text style={styles.gridLabel}>FAQs Setup</Text>
              </Card.Content>
            </Card>
          </View>
        </View>

        {/* Recent Orders */}
        <Text style={styles.sectionTitle}>Recent Orders</Text>
        {recentOrders.map((order) => (
          <Card key={order.id} style={styles.orderCard}>
            <Card.Content style={styles.orderRow}>
              <View>
                <Text style={styles.orderCustomer}>+{order.customerPhone}</Text>
                <Text style={styles.orderDate}>{order.date}</Text>
              </View>
              <View style={styles.orderRight}>
                <Text style={styles.orderAmount}>₦{order.amount.toLocaleString()}</Text>
                <Badge
                  style={[
                    styles.orderBadge,
                    {
                      backgroundColor:
                        order.status === 'PAID'
                          ? theme.colors.success
                          : order.status === 'PENDING'
                          ? theme.colors.warning
                          : theme.colors.primary,
                    },
                  ]}
                >
                  {order.status}
                </Badge>
              </View>
            </Card.Content>
          </Card>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9f9f9',
  },
  content: {
    padding: 16,
  },
  businessHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  headerInfo: {
    flex: 1,
  },
  businessTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#121212',
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 12,
    color: '#6b7280',
  },
  iconContainer: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#121212',
    marginBottom: 12,
    marginTop: 8,
  },
  revenueScroll: {
    marginBottom: 20,
  },
  revenueCard: {
    width: 150,
    marginRight: 12,
    backgroundColor: '#ffffff',
  },
  cardLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  cardValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#121212',
    marginTop: 4,
  },
  cardTrend: {
    fontSize: 10,
    marginTop: 4,
  },
  gridContainer: {
    marginBottom: 20,
  },
  gridRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  gridCard: {
    flex: 1,
    marginHorizontal: 6,
    backgroundColor: '#ffffff',
  },
  gridContent: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  gridLabel: {
    fontSize: 13,
    fontWeight: 'bold',
    marginTop: 8,
    color: '#121212',
  },
  orderCard: {
    marginBottom: 10,
    backgroundColor: '#ffffff',
  },
  orderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderCustomer: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#121212',
  },
  orderDate: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },
  orderRight: {
    alignItems: 'flex-end',
  },
  orderAmount: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#121212',
    marginBottom: 4,
  },
  orderBadge: {
    color: '#ffffff',
    fontWeight: 'bold',
    paddingHorizontal: 8,
  },
});
