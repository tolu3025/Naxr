import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';
import '../stores/vendor_store.dart';
import '../theme.dart';
import 'chat_detail_screen.dart';
import 'package:intl/intl.dart';

class ChatListItem {
  final String customerPhone;
  final String? customerName;
  final String lastMessage;
  final String lastMessageTime;
  final int unreadCount;
  final bool aiHandled;

  ChatListItem({
    required this.customerPhone,
    this.customerName,
    required this.lastMessage,
    required this.lastMessageTime,
    required this.unreadCount,
    required this.aiHandled,
  });

  factory ChatListItem.fromJson(Map<String, dynamic> json) {
    return ChatListItem(
      customerPhone: json['customer_phone'] ?? '',
      customerName: json['customer_name'],
      lastMessage: json['last_message'] ?? '',
      lastMessageTime: json['last_message_time'] ?? '',
      unreadCount: json['unread_count'] ?? 0,
      aiHandled: json['ai_handled'] == true,
    );
  }
}

class ChatsTab extends StatefulWidget {
  const ChatsTab({super.key});

  @override
  State<ChatsTab> createState() => _ChatsTabState();
}

class _ChatsTabState extends State<ChatsTab> {
  final TextEditingController _searchController = TextEditingController();
  List<ChatListItem> _chats = [];
  List<ChatListItem> _filteredChats = [];
  bool _isLoading = false;
  int _lastRefreshCount = -1;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _searchController.addListener(_filterChats);
    _fetchChats();
    // Periodic fallback refresh every 30 seconds
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) => _fetchChats());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // React to new socket messages triggering a refresh
    final store = Provider.of<VendorStore>(context);
    if (store.chatRefreshCount != _lastRefreshCount) {
      _lastRefreshCount = store.chatRefreshCount;
      if (_lastRefreshCount > 0) {
        _fetchChats();
      }
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _fetchChats() async {
    final store = Provider.of<VendorStore>(context, listen: false);
    if (store.phone == null) return;

    setState(() {
      _isLoading = true;
    });

    try {
      final response = await http
          .get(
            Uri.parse('${VendorStore.baseUrl}/api/vendor/${store.phone}/chats'),
            headers: store.token != null
                ? {'Authorization': 'Bearer ${store.token}'}
                : {},
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode == 200) {
        final List<dynamic> data = jsonDecode(response.body);
        setState(() {
          _chats = data.map((json) => ChatListItem.fromJson(json)).toList();
          _filteredChats = List.from(_chats);
        });
      } else {
        debugPrint('Chats API error: ${response.statusCode} ${response.body}');
        setState(() {
          _chats = [];
          _filteredChats = [];
        });
      }
    } catch (e) {
      debugPrint('Error fetching chats: $e');
      setState(() {
        _chats = [];
        _filteredChats = [];
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _filterChats() {
    final query = _searchController.text.toLowerCase();
    setState(() {
      if (query.isEmpty) {
        _filteredChats = List.from(_chats);
      } else {
        _filteredChats = _chats.where((chat) {
          final phoneMatch = chat.customerPhone.contains(query);
          final nameMatch = chat.customerName?.toLowerCase().contains(query) ?? false;
          return phoneMatch || nameMatch;
        }).toList();
      }
    });
  }

  String _getInitials(String? name, String phone) {
    if (name != null && name.trim().isNotEmpty) {
      final parts = name.trim().split(' ');
      if (parts.length >= 2) {
        return '${parts[0][0]}${parts[1][0]}'.toUpperCase();
      }
      return parts[0][0].toUpperCase();
    }
    return phone.substring(phone.length - 2);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Search bar
        Padding(
          padding: const EdgeInsets.all(16.0),
          child: TextField(
            controller: _searchController,
            decoration: InputDecoration(
              hintText: 'Search customers...',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _searchController.text.isNotEmpty
                  ? IconButton(
                      icon: const Icon(Icons.clear),
                      onPressed: () {
                        _searchController.clear();
                      },
                    )
                  : null,
              contentPadding: const EdgeInsets.symmetric(vertical: 0, horizontal: 16),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(28),
                borderSide: BorderSide.none,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(28),
                borderSide: BorderSide.none,
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(28),
                borderSide: const BorderSide(color: AppTheme.primaryGreen, width: 1.5),
              ),
              filled: true,
              fillColor: Colors.grey.shade100,
            ),
          ),
        ),

        // Inbox List
        Expanded(
          child: RefreshIndicator(
            onRefresh: _fetchChats,
            color: AppTheme.primaryGreen,
            child: _isLoading && _chats.isEmpty
                ? const Center(child: CircularProgressIndicator(color: AppTheme.primaryGreen))
                : _filteredChats.isEmpty
                    ? _buildEmptyState()
                    : ListView.builder(
                        itemCount: _filteredChats.length,
                        itemBuilder: (context, index) {
                          final item = _filteredChats[index];
                          return _buildChatItem(item);
                        },
                      ),
          ),
        ),
      ],
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(32.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.message_outlined, size: 64, color: Colors.grey.shade300),
            const SizedBox(height: 16),
            const Text(
              'No messages yet.',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
            ),
            const SizedBox(height: 8),
            const Text(
              'Customers will appear here when they message your WhatsApp store.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: AppTheme.textMuted),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildChatItem(ChatListItem item) {
    return InkWell(
      onTap: () {
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => ChatDetailScreen(customerPhone: item.customerPhone),
          ),
        ).then((_) => _fetchChats());
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: Colors.grey.shade100)),
        ),
        child: Row(
          children: [
            // Left: Avatar with initials & badge
            Stack(
              clipBehavior: Clip.none,
              children: [
                CircleAvatar(
                  radius: 24,
                  backgroundColor: AppTheme.primaryGreen,
                  child: Text(
                    _getInitials(item.customerName, item.customerPhone),
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                if (item.unreadCount > 0)
                  Positioned(
                    right: -2,
                    top: -2,
                    child: Container(
                      padding: const EdgeInsets.all(4),
                      decoration: const BoxDecoration(
                        color: AppTheme.whatsappGreen,
                        shape: BoxShape.circle,
                      ),
                      constraints: const BoxConstraints(
                        minWidth: 18,
                        minHeight: 18,
                      ),
                      child: Text(
                        '${item.unreadCount}',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(width: 14),

            // Middle: Name and last message preview
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.customerName ?? '+${item.customerPhone}',
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                      color: AppTheme.secondaryDark,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    item.lastMessage,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppTheme.textMuted,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),

            // Right: Time and AI status label
            // Right: Time and AI status label
            (() {
              String displayTime = item.lastMessageTime;
              try {
                final parsed = DateTime.parse(displayTime).toLocal();
                final now = DateTime.now();
                final difference = now.difference(parsed).inDays;
                if (difference == 0 && now.day == parsed.day) {
                  displayTime = DateFormat('h:mm a').format(parsed);
                } else if (difference <= 1 && now.subtract(const Duration(days: 1)).day == parsed.day) {
                  displayTime = 'Yesterday';
                } else {
                  displayTime = DateFormat('dd/MM/yy').format(parsed);
                }
              } catch (_) {}

              return Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    displayTime,
                    style: const TextStyle(
                      fontSize: 11,
                      color: AppTheme.textMuted,
                    ),
                  ),
                  if (item.aiHandled) ...[
                    const SizedBox(height: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: Colors.green.shade50,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.android, size: 12, color: AppTheme.whatsappGreen),
                          const SizedBox(width: 2),
                          Text(
                            'AI',
                            style: TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.bold,
                              color: Colors.green.shade700,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              );
            })(),
          ],
        ),
      ),
    );
  }
}
