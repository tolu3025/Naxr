import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'stores/vendor_store.dart';
import 'services/socket_service.dart';
import 'screens/login_screen.dart';
import 'screens/tabs_screen.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => VendorStore()),
        Provider(create: (_) => SocketService()),
      ],
      child: MaterialApp(
        title: 'Naxr Merchant Portal',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.lightTheme,
        home: const AuthResolverScreen(),
      ),
    );
  }
}

class AuthResolverScreen extends StatefulWidget {
  const AuthResolverScreen({super.key});

  @override
  State<AuthResolverScreen> createState() => _AuthResolverScreenState();
}

class _AuthResolverScreenState extends State<AuthResolverScreen> {
  bool _isReady = false;
  bool _isAuthenticated = false;

  @override
  void initState() {
    super.initState();
    _initSession();
  }

  Future<void> _initSession() async {
    final store = Provider.of<VendorStore>(context, listen: false);
    try {
      final authenticated = await store.loadAuth();
      setState(() {
        _isAuthenticated = authenticated;
      });
    } catch (e) {
      debugPrint('Failed to restore auth session: $e');
    } finally {
      setState(() {
        _isReady = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_isReady) {
      return Scaffold(
        backgroundColor: Colors.white,
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: BoxDecoration(
                  color: AppTheme.primaryGreen,
                  shape: BoxShape.circle,
                ),
                child: const Center(
                  child: Text(
                    'Naxr',
                    style: TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 16,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              const CircularProgressIndicator(color: AppTheme.primaryGreen),
            ],
          ),
        ),
      );
    }

    return _isAuthenticated ? const TabsScreen() : const LoginScreen();
  }
}
