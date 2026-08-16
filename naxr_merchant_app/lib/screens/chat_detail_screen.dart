import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:http/http.dart' as http;
import '../services/socket_service.dart';
import '../stores/vendor_store.dart';
import '../theme.dart';

class Message {
  final String id;
  final String text;
  final bool fromMe;
  final bool isAi;
  final String timestamp;

  Message({
    required this.id,
    required this.text,
    required this.fromMe,
    this.isAi = false,
    required this.timestamp,
  });

  factory Message.fromJson(Map<String, dynamic> json) {
    return Message(
      id: json['id']?.toString() ?? json['_id']?.toString() ?? '',
      text: json['text'] ?? json['message'] ?? '',
      fromMe: json['fromMe'] == true,
      isAi: json['isAi'] == true,
      timestamp: json['timestamp'] ?? '',
    );
  }
}

class ChatDetailScreen extends StatefulWidget {
  final String customerPhone;

  const ChatDetailScreen({super.key, required this.customerPhone});

  @override
  State<ChatDetailScreen> createState() => _ChatDetailScreenState();
}

class _ChatDetailScreenState extends State<ChatDetailScreen> {
  final TextEditingController _inputController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  List<Message> _messages = [];
  bool _aiMode = true;
  bool _isTyping = false;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _fetchHistory();
    _setupSocketListeners();
  }

  @override
  void dispose() {
    _inputController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      Future.delayed(const Duration(milliseconds: 150), () {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      });
    }
  }

  Future<void> _fetchHistory() async {
    final store = Provider.of<VendorStore>(context, listen: false);
    if (store.phone == null) return;

    setState(() {
      _isLoading = true;
    });

    try {
      final response = await http.get(
        Uri.parse('${VendorStore.baseUrl}/api/vendor/${store.phone}/chats/${widget.customerPhone}'),
        headers: store.token != null ? {'Authorization': 'Bearer ${store.token}'} : null,
      );

      if (response.statusCode == 200) {
        final List<dynamic> data = jsonDecode(response.body);
        setState(() {
          _messages = data.map((json) => Message.fromJson(json)).toList();
        });
        _scrollToBottom();
      } else {
        throw Exception('Server error');
      }
    } catch (e) {
      debugPrint('Error fetching chat history, using mocks: $e');
      final mockHistory = [
        Message(id: '1', text: 'Hello, do you sell shirts?', fromMe: false, timestamp: '12:00 PM'),
        Message(id: '2', text: 'Yes! We have vintage shirts available. Let me send you the list.', fromMe: true, isAi: true, timestamp: '12:01 PM'),
        Message(id: '3', text: 'Is the vintage shirt still available?', fromMe: false, timestamp: '12:30 PM'),
      ];
      setState(() {
        _messages = mockHistory;
      });
      _scrollToBottom();
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _setupSocketListeners() {
    final socketService = Provider.of<SocketService>(context, listen: false);
    
    // Connect callbacks if socket exists and is connected
    if (socketService.socket != null) {
      socketService.socket!.on('new_message', (data) {
        if (data != null && data['customer_phone'] == widget.customerPhone) {
          final isFromMe = data['fromMe'] == true;
          final timeStr = TimeOfDay.now().format(context);
          setState(() {
            _messages.add(Message(
              id: DateTime.now().millisecondsSinceEpoch.toString(),
              text: data['text'] ?? '',
              fromMe: isFromMe,
              timestamp: timeStr,
            ));
          });
          _scrollToBottom();
        }
      });

      socketService.socket!.on('ai_replied', (data) {
        if (data != null && data['customer_phone'] == widget.customerPhone) {
          final timeStr = TimeOfDay.now().format(context);
          setState(() {
            _isTyping = false;
            _messages.add(Message(
              id: DateTime.now().millisecondsSinceEpoch.toString(),
              text: data['text'] ?? '',
              fromMe: true,
              isAi: true,
              timestamp: timeStr,
            ));
          });
          _scrollToBottom();
        }
      });
    }
  }

  Future<void> _sendMessage() async {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;

    _inputController.clear();
    final timeStr = TimeOfDay.now().format(context);

    setState(() {
      _messages.add(Message(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        text: text,
        fromMe: true,
        timestamp: timeStr,
      ));
    });
    _scrollToBottom();

    final store = Provider.of<VendorStore>(context, listen: false);
    if (store.phone == null) return;

    try {
      await http.post(
        Uri.parse('${VendorStore.baseUrl}/api/vendor/${store.phone}/send-message'),
        headers: store.token != null ? {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${store.token}'
        } : {'Content-Type': 'application/json'},
        body: jsonEncode({
          'customer_phone': widget.customerPhone,
          'message': text,
        }),
      );
    } catch (e) {
      debugPrint('Error sending message: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFEFEAE2), // WhatsApp beige background
      appBar: AppBar(
        title: Text('+${widget.customerPhone}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.more_vert),
            onPressed: () {},
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            // Chat history list
            Expanded(
              child: _isLoading && _messages.isEmpty
                  ? const Center(child: CircularProgressIndicator(color: AppTheme.primaryGreen))
                  : ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.all(16),
                      itemCount: _messages.length,
                      itemBuilder: (context, index) {
                        final msg = _messages[index];
                        return _buildMessageBubble(msg);
                      },
                    ),
            ),

            if (_isTyping)
              Container(
                alignment: Alignment.centerLeft,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: const Text(
                  '🤖 AI Agent is typing...',
                  style: TextStyle(fontStyle: FontStyle.italic, color: AppTheme.textMuted, fontSize: 12),
                ),
              ),

            // Autopilot Toggle & Message input area
            Container(
              color: Colors.white,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // AI Toggle bar
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
                    decoration: BoxDecoration(
                      border: Border(bottom: BorderSide(color: Colors.grey.shade100)),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Row(
                          children: [
                            Icon(
                              Icons.android,
                              size: 18,
                              color: _aiMode ? AppTheme.whatsappGreen : Colors.grey,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              _aiMode ? 'AI Autopilot Active' : 'Manual Control Enabled',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: _aiMode ? AppTheme.whatsappGreen : AppTheme.textMuted,
                              ),
                            ),
                          ],
                        ),
                        Switch(
                          value: _aiMode,
                          activeColor: AppTheme.whatsappGreen,
                          onChanged: (val) {
                            setState(() {
                              _aiMode = val;
                            });
                          },
                        ),
                      ],
                    ),
                  ),

                  // TextInput area
                  Padding(
                    padding: const EdgeInsets.all(8.0),
                    child: Row(
                      children: [
                        Expanded(
                          child: Container(
                            decoration: BoxDecoration(
                              color: Colors.grey.shade100,
                              borderRadius: BorderRadius.circular(24),
                            ),
                            child: TextField(
                              controller: _inputController,
                              maxLines: 4,
                              minLines: 1,
                              decoration: const InputDecoration(
                                hintText: 'Type a message...',
                                contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                                border: InputBorder.none,
                                enabledBorder: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                filled: false,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        GestureDetector(
                          onTap: _sendMessage,
                          child: CircleAvatar(
                            radius: 22,
                            backgroundColor: AppTheme.primaryGreen,
                            child: const Icon(Icons.send, color: Colors.white, size: 20),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageBubble(Message msg) {
    return Align(
      alignment: msg.fromMe ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.8,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: msg.fromMe ? AppTheme.primaryGreen : Colors.white,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(12),
            topRight: const Radius.circular(12),
            bottomLeft: msg.fromMe ? const Radius.circular(12) : const Radius.circular(2),
            bottomRight: msg.fromMe ? const Radius.circular(2) : const Radius.circular(12),
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.06),
              blurRadius: 1,
              offset: const Offset(0, 1),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              msg.text,
              style: TextStyle(
                color: msg.fromMe ? Colors.white : AppTheme.secondaryDark,
                fontSize: 15,
              ),
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                if (msg.isAi)
                  Text(
                    '🤖 AI · ',
                    style: TextStyle(
                      fontSize: 10,
                      color: msg.fromMe ? Colors.green.shade100 : Colors.grey.shade600,
                    ),
                  ),
                Text(
                  msg.timestamp,
                  style: TextStyle(
                    fontSize: 10,
                    color: msg.fromMe ? Colors.green.shade100 : Colors.grey.shade600,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
