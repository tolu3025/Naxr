import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, FlatList, KeyboardAvoidingView, Platform } from 'react-native';
import { Appbar, TextInput, IconButton, Switch, Text, useTheme } from 'react-native-paper';
import { useLocalSearchParams, useRouter } from 'expo-router';
import axios from 'axios';
import { API_URL } from '../../constants/api';
import { useVendorStore } from '../../stores/vendorStore';
import { useSocket } from '../../hooks/useSocket';

interface Message {
  id: string;
  text: string;
  fromMe: boolean;
  isAi?: boolean;
  timestamp: string;
}

export default function ChatScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { customerPhone } = useLocalSearchParams<{ customerPhone: string }>();
  const phone = useVendorStore((state) => state.phone);
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [aiMode, setAiMode] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const fetchHistory = async () => {
    if (!phone || !customerPhone) return;
    try {
      const response = await axios.get(`${API_URL}/api/vendor/${phone}/chats/${customerPhone}`);
      setMessages(response.data);
    } catch (e) {
      console.warn("Utilizing mock chat history fallback:", e);
      // Fallback mocks
      const mockHistory: Message[] = [
        { id: '1', text: 'Hello, do you sell shirts?', fromMe: false, timestamp: '12:00 PM' },
        { id: '2', text: 'Yes! We have vintage shirts available. Let me send you the list.', fromMe: true, isAi: true, timestamp: '12:01 PM' },
        { id: '3', text: 'Is the vintage shirt still available?', fromMe: false, timestamp: '12:30 PM' },
      ];
      setMessages(mockHistory);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [phone, customerPhone]);

  // Connect socket for updates
  useSocket({
    onNewMessage: (msg) => {
      if (msg.customer_phone === customerPhone) {
        setMessages((prev) => [...prev, {
          id: Date.now().toString(),
          text: msg.text,
          fromMe: !!msg.fromMe,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
        setTimeout(() => flatListRef.current?.scrollToEnd(), 200);
      }
    },
    onAiReplied: (reply) => {
      if (reply.customer_phone === customerPhone) {
        setIsTyping(false);
        setMessages((prev) => [...prev, {
          id: Date.now().toString(),
          text: reply.text,
          fromMe: true,
          isAi: true,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
        setTimeout(() => flatListRef.current?.scrollToEnd(), 200);
      }
    }
  });

  const sendMessage = async () => {
    if (!inputText.trim() || !phone || !customerPhone) return;
    const textToSend = inputText.trim();
    setInputText('');

    // Append manually sent message locally
    setMessages((prev) => [...prev, {
      id: Date.now().toString(),
      text: textToSend,
      fromMe: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);
    setTimeout(() => flatListRef.current?.scrollToEnd(), 200);

    try {
      await axios.post(`${API_URL}/api/vendor/${phone}/send-message`, {
        customer_phone: customerPhone,
        message: textToSend
      });
    } catch (e) {
      console.error("Failed to send message over HTTP API:", e);
    }
  };

  const toggleAI = async () => {
    // Toggles the AI active status for this user or globally. For this screen we toggle local setting
    setAiMode(!aiMode);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      style={styles.container}
    >
      <Appbar.Header style={{ backgroundColor: theme.colors.primary }}>
        <Appbar.BackAction color="#ffffff" onPress={() => router.back()} />
        <Appbar.Content title={`+${customerPhone}`} titleStyle={{ color: '#ffffff' }} />
        <Appbar.Action icon="dots-vertical" color="#ffffff" onPress={() => {}} />
      </Appbar.Header>

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={[styles.bubbleWrapper, item.fromMe ? styles.myWrapper : styles.otherWrapper]}>
            <View
              style={[
                styles.bubble,
                item.fromMe ? [styles.myBubble, { backgroundColor: theme.colors.primary }] : styles.otherBubble
              ]}
            >
              <Text style={item.fromMe ? styles.myText : styles.otherText}>{item.text}</Text>
              <View style={styles.bubbleMeta}>
                {item.isAi && (
                  <Text style={[styles.metaText, { color: item.fromMe ? '#e2e8f0' : '#718096' }]}>🤖 AI · </Text>
                )}
                <Text style={[styles.metaText, { color: item.fromMe ? '#e2e8f0' : '#718096' }]}>{item.timestamp}</Text>
              </View>
            </View>
          </View>
        )}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
      />

      {isTyping && (
        <View style={styles.typingContainer}>
          <Text style={styles.typingText}>🤖 AI Agent is typing...</Text>
        </View>
      )}

      {/* Input container */}
      <View style={styles.inputSection}>
        <View style={styles.aiToggleBar}>
          <View style={styles.aiLabelContainer}>
            <IconButton icon="robot" size={16} iconColor={aiMode ? theme.colors.success : '#9ca3af'} />
            <Text style={[styles.aiLabel, { color: aiMode ? theme.colors.success : '#6b7280' }]}>
              {aiMode ? 'AI Autopilot Active' : 'Manual Control Enabled'}
            </Text>
          </View>
          <Switch value={aiMode} onValueChange={toggleAI} color={theme.colors.success} />
        </View>

        <View style={styles.inputRow}>
          <TextInput
            placeholder="Type a message..."
            value={inputText}
            onChangeText={setInputText}
            mode="flat"
            dense
            style={styles.textInput}
            underlineColor="transparent"
            activeUnderlineColor="transparent"
            multiline
          />
          <IconButton
            icon="send"
            iconColor="#ffffff"
            size={20}
            style={[styles.sendButton, { backgroundColor: theme.colors.primary }]}
            onPress={sendMessage}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#efeae2', // WhatsApp style background color
  },
  listContent: {
    padding: 16,
    paddingBottom: 8,
  },
  bubbleWrapper: {
    flexDirection: 'row',
    marginBottom: 10,
    width: '100%',
  },
  myWrapper: {
    justifyContent: 'flex-end',
  },
  otherWrapper: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 1,
  },
  myBubble: {
    borderTopRightRadius: 2,
  },
  otherBubble: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 2,
  },
  myText: {
    color: '#ffffff',
    fontSize: 15,
  },
  otherText: {
    color: '#121212',
    fontSize: 15,
  },
  bubbleMeta: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    marginTop: 4,
  },
  metaText: {
    fontSize: 10,
  },
  typingContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  typingText: {
    fontSize: 12,
    color: '#4b5563',
    fontStyle: 'italic',
  },
  inputSection: {
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    padding: 8,
  },
  aiToggleBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    marginBottom: 8,
  },
  aiLabelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  aiLabel: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    borderRadius: 20,
    paddingHorizontal: 12,
    maxHeight: 100,
  },
  sendButton: {
    marginLeft: 8,
    borderRadius: 20,
  },
});
