import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:http/http.dart' as http;
import '../stores/vendor_store.dart';
import '../theme.dart';
import 'tabs_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _otpController = TextEditingController();

  bool _otpSent = false;
  bool _isLoading = false;
  String _errorMessage = '';

  @override
  void dispose() {
    _phoneController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  String _formatPhoneNumber(String input) {
    String formatted = input.replaceAll(RegExp(r'[^0-9]'), '');
    if (formatted.startsWith('0')) {
      formatted = '234' + formatted.substring(1);
    } else if (formatted.length == 10) {
      formatted = '234' + formatted;
    }
    return formatted;
  }

  Future<void> _handleSendOtp() async {
    final phone = _phoneController.text.trim();
    if (phone.isEmpty || phone.length < 9) {
      setState(() {
        _errorMessage = 'Please enter a valid phone number';
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = '';
    });

    final formatted = _formatPhoneNumber(phone);

    try {
      final response = await http
          .post(
            Uri.parse('${VendorStore.baseUrl}/api/auth/vendor/login'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'phone': formatted}),
          )
          .timeout(const Duration(seconds: 15));

      final data = jsonDecode(response.body);

      if (response.statusCode == 200) {
        setState(() {
          _otpSent = true;
          _errorMessage = '';
        });
      } else {
        // Show actual server error (e.g. "Vendor not registered")
        final msg = data['error'] ?? 'Login failed. Please try again.';
        setState(() {
          _errorMessage = msg;
        });
      }
    } catch (err) {
      setState(() {
        _errorMessage =
            'Cannot connect to server. Please check your internet connection and try again.';
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _handleVerifyOtp() async {
    final otp = _otpController.text.trim();
    if (otp.isEmpty || otp.length != 6) {
      setState(() {
        _errorMessage = 'OTP must be exactly 6 digits';
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = '';
    });

    final formatted = _formatPhoneNumber(_phoneController.text.trim());

    try {
      final response = await http
          .post(
            Uri.parse('${VendorStore.baseUrl}/api/auth/vendor/verify-otp'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'phone': formatted, 'otp': otp}),
          )
          .timeout(const Duration(seconds: 15));

      final data = jsonDecode(response.body);

      if (response.statusCode == 200) {
        final token = data['token'];
        if (token == null) {
          setState(() {
            _errorMessage = 'Invalid server response. Please try again.';
          });
          return;
        }
        final store = Provider.of<VendorStore>(context, listen: false);
        await store.saveAuth(token, formatted);
        _navigateToDashboard();
      } else {
        // Show actual server error (e.g. "Invalid OTP or expired")
        final msg = data['error'] ?? 'Verification failed. Please try again.';
        setState(() {
          _errorMessage = msg;
        });
      }
    } catch (err) {
      setState(() {
        _errorMessage =
            'Cannot connect to server. Please check your internet connection and try again.';
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _navigateToDashboard() {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (context) => const TabsScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Header Logo
                Center(
                  child: Column(
                    children: [
                      Container(
                        width: 80,
                        height: 80,
                        decoration: BoxDecoration(
                          color: AppTheme.primaryGreen,
                          borderRadius: BorderRadius.circular(40),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withOpacity(0.15),
                              blurRadius: 8,
                              offset: const Offset(0, 4),
                            ),
                          ],
                        ),
                        child: const Center(
                          child: Text(
                            'Naxr',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 28,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                      const Text(
                        'Naxr AI Merchant Portal',
                        style: TextStyle(
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                          color: AppTheme.secondaryDark,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Your 24/7 WhatsApp Store Assistant',
                        style: TextStyle(
                          fontSize: 14,
                          color: AppTheme.textMuted,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 40),

                // Form Content
                TextField(
                  controller: _phoneController,
                  keyboardType: TextInputType.phone,
                  enabled: !_otpSent && !_isLoading,
                  decoration: const InputDecoration(
                    labelText: 'Phone Number',
                    hintText: 'e.g. 08148698365',
                    prefixIcon: Icon(Icons.phone),
                  ),
                ),
                const SizedBox(height: 16),

                if (_otpSent) ...[
                  const Text(
                    '✅ OTP sent to your WhatsApp! Check your messages.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppTheme.primaryGreen, fontSize: 13),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _otpController,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    enabled: !_isLoading,
                    decoration: const InputDecoration(
                      labelText: '6-Digit OTP Code',
                      hintText: 'Enter code sent to WhatsApp',
                      prefixIcon: Icon(Icons.lock),
                      counterText: '',
                    ),
                  ),
                  const SizedBox(height: 16),
                ],

                if (_errorMessage.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16.0),
                    child: Text(
                      _errorMessage,
                      style: const TextStyle(
                          color: AppTheme.dangerRed, fontSize: 13),
                      textAlign: TextAlign.center,
                    ),
                  ),

                ElevatedButton(
                  onPressed: _isLoading
                      ? null
                      : (_otpSent ? _handleVerifyOtp : _handleSendOtp),
                  child: _isLoading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                              color: Colors.white, strokeWidth: 2),
                        )
                      : Text(_otpSent ? 'Verify & Sign In' : 'Send One-Time Passcode'),
                ),
                const SizedBox(height: 12),

                if (_otpSent)
                  TextButton(
                    onPressed: _isLoading
                        ? null
                        : () {
                            setState(() {
                              _otpSent = false;
                              _otpController.clear();
                              _errorMessage = '';
                            });
                          },
                    child: const Text('Change Phone Number'),
                  ),

                if (!_otpSent)
                  const Padding(
                    padding: EdgeInsets.only(top: 20.0),
                    child: Text(
                      'You must be a registered Naxr vendor to log in.\nRegister first via WhatsApp.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: AppTheme.textMuted),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
