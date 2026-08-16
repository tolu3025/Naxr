import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/socket_service.dart';
import '../stores/vendor_store.dart';
import '../theme.dart';
import 'dashboard_tab.dart';
import 'chats_tab.dart';
import 'products_tab.dart';
import 'settings_tab.dart';

class TabsScreen extends StatefulWidget {
  const TabsScreen({super.key});

  @override
  State<TabsScreen> createState() => _TabsScreenState();
}

class _TabsScreenState extends State<TabsScreen> {
  int _currentIndex = 0;
  late final List<Widget> _tabs;

  final List<String> _titles = [
    'Naxr Dashboard',
    'WhatsApp Inbox',
    'Product Catalog',
    'Settings',
  ];

  @override
  void initState() {
    super.initState();
    _tabs = [
      DashboardTab(onSelectTab: (index) {
        setState(() {
          _currentIndex = index;
        });
      }),
      const ChatsTab(),
      const ProductsTab(),
      const SettingsTab(),
    ];
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initSocket();
    });
  }

  void _initSocket() {
    final store = Provider.of<VendorStore>(context, listen: false);
    final socketService = Provider.of<SocketService>(context, listen: false);
    if (store.phone != null) {
      socketService.connect(
        vendorPhone: store.phone!,
        onConnect: () {
          store.setConnected(true);
        },
        onNewMessage: (data) {
          store.fetchDashboard();
        },
        onNewOrder: (data) {
          store.fetchDashboard();
        },
        onAiReplied: (data) {
          store.fetchDashboard();
        },
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_currentIndex]),
        elevation: 0,
      ),
      body: IndexedStack(
        index: _currentIndex,
        children: _tabs,
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(
              color: Colors.grey.shade200,
              width: 1,
            ),
          ),
        ),
        child: BottomNavigationBar(
          currentIndex: _currentIndex,
          type: BottomNavigationBarType.fixed,
          selectedItemColor: AppTheme.primaryGreen,
          unselectedItemColor: AppTheme.textMuted,
          backgroundColor: Colors.white,
          elevation: 0,
          iconSize: 24,
          selectedFontSize: 12,
          unselectedFontSize: 12,
          onTap: (index) {
            setState(() {
              _currentIndex = index;
            });
          },
          items: const [
            BottomNavigationBarItem(
              icon: Icon(Icons.dashboard_outlined),
              activeIcon: Icon(Icons.dashboard),
              label: 'Home',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.chat_outlined),
              activeIcon: Icon(Icons.chat),
              label: 'Chats',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.store_outlined),
              activeIcon: Icon(Icons.store),
              label: 'Products',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.settings_outlined),
              activeIcon: Icon(Icons.settings),
              label: 'Settings',
            ),
          ],
        ),
      ),
    );
  }
}
