import React, { useEffect, useState } from 'react';
import { StyleSheet, View, ScrollView, Alert, Linking } from 'react-native';
import { Card, Avatar, List, RadioButton, Switch, Button, Text, useTheme, TextInput } from 'react-native-paper';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { API_URL } from '../../constants/api';
import { useVendorStore } from '../../stores/vendorStore';

export default function SettingsScreen() {
  const router = useRouter();
  const theme = useTheme();
  
  const {
    phone,
    businessName,
    responseMode,
    isPro,
    setResponseMode,
    logout
  } = useVendorStore();

  const [vendorDetails, setVendorDetails] = useState<any>(null);
  const [allowNegotiation, setAllowNegotiation] = useState(false);
  const [maxDiscountPercent, setMaxDiscountPercent] = useState('0');

  // Local state for UI changes before saving
  const [localResponseMode, setLocalResponseMode] = useState<'auto' | 'suggestions' | 'manual'>('auto');
  const [updatingResponseMode, setUpdatingResponseMode] = useState(false);
  const [updatingNegotiation, setUpdatingNegotiation] = useState(false);

  const fetchSettings = async () => {
    if (!phone) return;
    try {
      const response = await axios.get(`${API_URL}/api/vendor/${phone}/settings`);
      setVendorDetails(response.data);
      setAllowNegotiation(!!response.data.allowNegotiation);
      setMaxDiscountPercent(String(response.data.maxDiscountPercent || '0'));
    } catch (e) {
      console.warn("Using settings mock fallback data:", e);
      setVendorDetails({
        storeName: businessName || 'Vintage Fashion Store',
        category: 'Fashion & Apparel',
        bankDetails: 'Access Bank - 0812345678',
        deliveryInfo: 'Delivery to main gate in campus, or GIGM nationwide.',
        aiActive: true,
      });
    }
  };

  const handleSaveResponseMode = async () => {
    setUpdatingResponseMode(true);
    try {
      await setResponseMode(localResponseMode);
      Alert.alert('Success', 'AI Autopilot mode updated successfully.');
    } catch (e) {
      Alert.alert('Error', 'Failed to save AI autopilot mode settings.');
    } finally {
      setUpdatingResponseMode(false);
    }
  };

  const handleSaveNegotiationRules = async () => {
    if (!phone) return;
    setUpdatingNegotiation(true);
    try {
      await axios.post(`${API_URL}/api/vendor/${phone}/settings`, {
        allowNegotiation: allowNegotiation,
        maxDiscountPercent: parseInt(maxDiscountPercent) || 0
      });
      Alert.alert('Success', 'Negotiation rules updated successfully.');
    } catch (e) {
      Alert.alert('Error', 'Failed to save negotiation rules.');
    } finally {
      setUpdatingNegotiation(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out of Naxr?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: async () => {
          await logout();
          router.replace('/login');
        } 
      }
    ]);
  };

  const handleSupportLink = () => {
    // Support admin WhatsApp link
    Linking.openURL('https://wa.me/2349168585661?text=Hi%20Naxr%20Support,%20I%20need%20assistance%20with%20my%20store.');
  };

  useEffect(() => {
    fetchSettings();
  }, [phone]);

  useEffect(() => {
    if (responseMode) {
      setLocalResponseMode(responseMode);
    }
  }, [responseMode]);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        {/* Profile Card */}
        <Card style={styles.profileCard}>
          <Card.Content style={styles.profileRow}>
            <Avatar.Icon size={50} icon="store" style={{ backgroundColor: theme.colors.primary }} />
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{vendorDetails?.storeName || businessName || 'Loading...'}</Text>
              <Text style={styles.profilePhone}>+{phone}</Text>
              <Text style={styles.profileCategory}>{vendorDetails?.category || 'General Store'}</Text>
            </View>
          </Card.Content>
        </Card>

        {/* Naxr Pro Tier Billing Info */}
        <Card style={styles.billingCard}>
          <Card.Content>
            <View style={styles.billingHeader}>
              <Text style={styles.billingTitle}>Billing & Subscription</Text>
              <View style={[styles.billingTierBadge, { backgroundColor: isPro ? '#e8f5e9' : '#fff3e0' }]}>
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: isPro ? theme.colors.success : theme.colors.warning }}>
                  {isPro ? 'PRO PLAN' : 'TRIAL TIER'}
                </Text>
              </View>
            </View>
            
            {!isPro ? (
              <View style={styles.trialInfo}>
                <Text style={styles.trialWarningText}>
                  ⚠️ Your 7-day Naxr free trial is active. Renew to prevent auto-reply downtime.
                </Text>
                <Text style={styles.bankInstructionText}>
                  To upgrade to Pro, transfer subscription dues to:
                </Text>
                <View style={styles.bankDetailsBox}>
                  <Text style={styles.bankText}>🏦 Bank: *Kuda Microfinance Bank*</Text>
                  <Text style={styles.bankText}>🔢 Account: *3003853004*</Text>
                  <Text style={styles.bankText}>👤 Name: *KUKA TECHNOLOGY AND INNOVATION LIMITED*</Text>
                </View>
                <Text style={styles.payoutHelperText}>
                  *Upload payment receipt to your WhatsApp number to activate.*
                </Text>
              </View>
            ) : (
              <Text style={styles.proActiveText}>
                🚀 Pro features active! Thank you for selling on autopilot.
              </Text>
            )}
          </Card.Content>
        </Card>

        {/* AI Autopilot Mode */}
        <Card style={styles.settingsCard}>
          <Card.Content>
            <Text style={styles.settingsTitle}>AI Autopilot Mode</Text>
            <RadioButton.Group
              onValueChange={(value) => setLocalResponseMode(value as any)}
              value={localResponseMode}
            >
              <RadioButton.Item
                label="🤖 AI Autopilot (Auto Reply)"
                value="auto"
                color={theme.colors.primary}
              />
              <RadioButton.Item
                label="💡 AI Suggestion Helper"
                value="suggestions"
                color={theme.colors.primary}
              />
              <RadioButton.Item
                label="✋ Manual Mode (AI Off)"
                value="manual"
                color={theme.colors.primary}
              />
            </RadioButton.Group>

            <Button
              mode="contained"
              onPress={handleSaveResponseMode}
              loading={updatingResponseMode}
              disabled={updatingResponseMode}
              style={{ marginTop: 12 }}
              buttonColor={theme.colors.primary}
            >
              Save Response Mode
            </Button>
          </Card.Content>
        </Card>

        {/* Negotiation & Limits */}
        <Card style={styles.settingsCard}>
          <Card.Content>
            <Text style={styles.settingsTitle}>Negotiation Rules</Text>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Allow AI Negotiations</Text>
              <Switch
                value={allowNegotiation}
                onValueChange={(val) => setAllowNegotiation(val)}
                color={theme.colors.primary}
              />
            </View>

            {allowNegotiation && (
              <View style={styles.inputContainer}>
                <Text style={styles.inputHelper}>Maximum negotiation discount allowed (%)</Text>
                <TextInput
                  value={maxDiscountPercent}
                  onChangeText={setMaxDiscountPercent}
                  keyboardType="numeric"
                  mode="outlined"
                  dense
                  style={styles.textInput}
                />
              </View>
            )}

            <Button
              mode="contained"
              onPress={handleSaveNegotiationRules}
              loading={updatingNegotiation}
              disabled={updatingNegotiation}
              style={{ marginTop: 12 }}
              buttonColor={theme.colors.primary}
            >
              Save Negotiation Rules
            </Button>
          </Card.Content>
        </Card>

        {/* Payout Information */}
        <Card style={styles.settingsCard}>
          <Card.Content>
            <Text style={styles.settingsTitle}>Payout Account</Text>
            <List.Item
              title="Settlement Details"
              description={vendorDetails?.bankDetails || 'Not configured'}
              left={(props) => <List.Icon {...props} icon="bank" />}
            />
          </Card.Content>
        </Card>

        {/* Knowledge Settings Links */}
        <Card style={styles.settingsCard}>
          <List.Item
            title="Manage FAQ Training"
            description="Edit questions & answers for AI responses"
            left={(props) => <List.Icon {...props} icon="brain" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/knowledge')}
            style={styles.listItem}
          />
          <List.Item
            title="Naxr Support Help"
            description="Open WhatsApp to message Admin support"
            left={(props) => <List.Icon {...props} icon="whatsapp" color="#25D366" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={handleSupportLink}
            style={styles.listItem}
          />
        </Card>

        {/* Log Out */}
        <Button
          mode="outlined"
          textColor={theme.colors.danger}
          style={[styles.logoutButton, { borderColor: theme.colors.danger }]}
          onPress={handleLogout}
        >
          Sign Out of Portal
        </Button>
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
    paddingBottom: 40,
  },
  profileCard: {
    marginBottom: 16,
    backgroundColor: '#ffffff',
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  profileInfo: {
    marginLeft: 16,
    flex: 1,
  },
  profileName: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#121212',
  },
  profilePhone: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 2,
  },
  profileCategory: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 2,
    textTransform: 'uppercase',
  },
  billingCard: {
    marginBottom: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  billingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  billingTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#121212',
  },
  billingTierBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  trialInfo: {
    marginTop: 12,
  },
  trialWarningText: {
    fontSize: 12,
    color: '#d97706',
    fontWeight: 'bold',
  },
  bankInstructionText: {
    fontSize: 12,
    marginTop: 8,
    color: '#374151',
  },
  bankDetailsBox: {
    backgroundColor: '#f9fafb',
    padding: 10,
    borderRadius: 6,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: '#f3f4f6',
  },
  bankText: {
    fontSize: 11,
    color: '#4b5563',
    lineHeight: 16,
  },
  payoutHelperText: {
    fontSize: 10,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
  proActiveText: {
    fontSize: 13,
    color: '#15803d',
    fontWeight: 'bold',
    marginTop: 10,
  },
  settingsCard: {
    marginBottom: 16,
    backgroundColor: '#ffffff',
  },
  settingsTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#121212',
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleLabel: {
    fontSize: 14,
    color: '#374151',
  },
  inputContainer: {
    marginTop: 8,
  },
  inputHelper: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 6,
  },
  textInput: {
    backgroundColor: '#ffffff',
  },
  listItem: {
    backgroundColor: '#ffffff',
  },
  logoutButton: {
    marginTop: 12,
    paddingVertical: 4,
    borderRadius: 8,
  },
});
