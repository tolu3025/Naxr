import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import '../stores/vendor_store.dart';
import '../theme.dart';
import 'login_screen.dart';
import 'knowledge_screen.dart';

class SettingsTab extends StatefulWidget {
  const SettingsTab({super.key});

  @override
  State<SettingsTab> createState() => _SettingsTabState();
}

class _SettingsTabState extends State<SettingsTab> {
  Map<String, dynamic>? _vendorDetails;
  bool _allowNegotiation = false;
  final TextEditingController _discountController = TextEditingController();
  
  String _selectedResponseMode = 'auto';
  bool _isLoadingSettings = false;
  bool _isSavingMode = false;
  bool _isSavingRules = false;

  @override
  void initState() {
    super.initState();
    _fetchSettings();
  }

  @override
  void dispose() {
    _discountController.dispose();
    super.dispose();
  }

  Future<void> _fetchSettings() async {
    final store = Provider.of<VendorStore>(context, listen: false);
    if (store.phone == null) return;

    setState(() {
      _isLoadingSettings = true;
    });

    final data = await store.fetchSettings();
    setState(() {
      _vendorDetails = data;
      _allowNegotiation = store.allowNegotiation;
      _discountController.text = store.maxDiscountPercent.toString();
      _selectedResponseMode = store.responseMode;
      _isLoadingSettings = false;
    });
  }

  Future<void> _handleSaveResponseMode() async {
    setState(() {
      _isSavingMode = true;
    });
    try {
      final store = Provider.of<VendorStore>(context, listen: false);
      await store.setResponseMode(_selectedResponseMode);
      _showSuccessDialog('Autopilot Mode Updated', 'AI response configuration saved successfully.');
    } catch (e) {
      _showErrorDialog('Update Failed', 'Failed to update response mode.');
    } finally {
      setState(() {
        _isSavingMode = false;
      });
    }
  }

  Future<void> _handleSaveNegotiationRules() async {
    final discountStr = _discountController.text.trim();
    final discount = int.tryParse(discountStr) ?? 0;

    setState(() {
      _isSavingRules = true;
    });

    try {
      final store = Provider.of<VendorStore>(context, listen: false);
      await store.saveNegotiationRules(_allowNegotiation, discount);
      _showSuccessDialog('Negotiation Rules Saved', 'AI bargaining thresholds saved successfully.');
    } catch (e) {
      _showErrorDialog('Update Failed', 'Failed to update negotiation rules.');
    } finally {
      setState(() {
        _isSavingRules = false;
      });
    }
  }

  void _handleSupportLink() async {
    final url = Uri.parse('https://wa.me/2349168585661?text=Hi%20Naxr%20Support,%20I%20need%20assistance%20with%20my%20store.');
    if (await canLaunchUrl(url)) {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not launch WhatsApp support link.')),
      );
    }
  }

  void _handleLogout() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sign Out'),
        content: const Text('Are you sure you want to sign out of Naxr?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel', style: TextStyle(color: Colors.grey)),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              final store = Provider.of<VendorStore>(context, listen: false);
              await store.logout();
              Navigator.pushAndRemoveUntil(
                context,
                MaterialPageRoute(builder: (context) => const LoginScreen()),
                (route) => false,
              );
            },
            child: const Text('Sign Out', style: TextStyle(color: AppTheme.dangerRed)),
          ),
        ],
      ),
    );
  }

  void _showSuccessDialog(String title, String message) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  void _showErrorDialog(String title, String message) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK', style: TextStyle(color: AppTheme.dangerRed)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = Provider.of<VendorStore>(context);

    if (_isLoadingSettings && _vendorDetails == null) {
      return const Center(child: CircularProgressIndicator(color: AppTheme.primaryGreen));
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Profile Card
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 26,
                    backgroundColor: AppTheme.primaryGreen,
                    child: const Icon(Icons.store, color: Colors.white, size: 28),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _vendorDetails?['storeName'] ?? store.businessName,
                          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '+${store.phone}',
                          style: const TextStyle(fontSize: 13, color: AppTheme.textMuted),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          (_vendorDetails?['category'] ?? 'General Store').toUpperCase(),
                          style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Billing Count Subscription Tier box
          Card(
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: BorderSide(color: Colors.grey.shade200),
            ),
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Billing & Subscription',
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: store.isPro ? Colors.green.shade50 : Colors.orange.shade50,
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          store.isPro ? 'PRO PLAN' : 'TRIAL TIER',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            color: store.isPro ? AppTheme.primaryGreen : AppTheme.warningAmber,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (!store.isPro) ...[
                    const Text(
                      '⚠️ Your 7-day Naxr free trial is active. Renew to prevent auto-reply downtime.',
                      style: TextStyle(fontSize: 12, color: AppTheme.warningAmber, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'To upgrade to Pro, transfer subscription dues to:',
                      style: TextStyle(fontSize: 12, color: AppTheme.secondaryDark),
                    ),
                    const SizedBox(height: 8),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.grey.shade50,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: Colors.grey.shade100),
                      ),
                      child: const Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('🏦 Bank: Kuda Microfinance Bank', style: TextStyle(fontSize: 11, color: Colors.black87, height: 1.5)),
                          Text('🔢 Account: 3003853004', style: TextStyle(fontSize: 11, color: Colors.black87, height: 1.5)),
                          Text('👤 Name: KUKA TECHNOLOGY AND INNOVATION LIMITED', style: TextStyle(fontSize: 11, color: Colors.black87, height: 1.5)),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '*Upload payment receipt to your WhatsApp number to activate.',
                      style: TextStyle(fontSize: 10, color: AppTheme.textMuted, fontStyle: FontStyle.italic),
                    ),
                  ] else ...[
                    const Text(
                      '🚀 Pro features active! Thank you for selling on autopilot.',
                      style: TextStyle(fontSize: 13, color: AppTheme.whatsappGreen, fontWeight: FontWeight.bold),
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Autopilot Mode
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'AI Autopilot Mode',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                  ),
                  const SizedBox(height: 8),
                  RadioListTile<String>(
                    title: const Text('🤖 AI Autopilot (Auto Reply)', style: TextStyle(fontSize: 14)),
                    value: 'auto',
                    groupValue: _selectedResponseMode,
                    activeColor: AppTheme.primaryGreen,
                    onChanged: (val) {
                      setState(() {
                        if (val != null) _selectedResponseMode = val;
                      });
                    },
                  ),
                  RadioListTile<String>(
                    title: const Text('💡 AI Suggestion Helper', style: TextStyle(fontSize: 14)),
                    value: 'suggestions',
                    groupValue: _selectedResponseMode,
                    activeColor: AppTheme.primaryGreen,
                    onChanged: (val) {
                      setState(() {
                        if (val != null) _selectedResponseMode = val;
                      });
                    },
                  ),
                  RadioListTile<String>(
                    title: const Text('✋ Manual Mode (AI Off)', style: TextStyle(fontSize: 14)),
                    value: 'manual',
                    groupValue: _selectedResponseMode,
                    activeColor: AppTheme.primaryGreen,
                    onChanged: (val) {
                      setState(() {
                        if (val != null) _selectedResponseMode = val;
                      });
                    },
                  ),
                  const SizedBox(height: 8),
                  ElevatedButton(
                    onPressed: _isSavingMode ? null : _handleSaveResponseMode,
                    child: _isSavingMode
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                          )
                        : const Text('Save Response Mode'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Negotiation Rules
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Negotiation Rules',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('Allow AI Negotiations', style: TextStyle(fontSize: 14)),
                      Switch(
                        value: _allowNegotiation,
                        activeColor: AppTheme.primaryGreen,
                        onChanged: (val) {
                          setState(() {
                            _allowNegotiation = val;
                          });
                        },
                      ),
                    ],
                  ),
                  if (_allowNegotiation) ...[
                    const SizedBox(height: 8),
                    const Text('Maximum negotiation discount allowed (%)', style: TextStyle(fontSize: 11, color: AppTheme.textMuted)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: _discountController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  ElevatedButton(
                    onPressed: _isSavingRules ? null : _handleSaveNegotiationRules,
                    child: _isSavingRules
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                          )
                        : const Text('Save Negotiation Rules'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Settlement payout account
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Payout Account',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                  ),
                  const SizedBox(height: 8),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.account_balance, color: AppTheme.primaryGreen),
                    title: const Text('Settlement Details', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                    subtitle: Text(_vendorDetails?['bankDetails'] ?? 'Not configured', style: const TextStyle(fontSize: 13)),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Training navigation and support links
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.psychology, color: AppTheme.primaryGreen),
                  title: const Text('Manage FAQ Training', style: TextStyle(fontSize: 14)),
                  subtitle: const Text('Edit questions & answers for AI responses', style: TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right, size: 20),
                  onTap: () {
                    Navigator.push(
                      context,
                      MaterialPageRoute(builder: (context) => const KnowledgeScreen()),
                    ).then((_) => _fetchSettings());
                  },
                ),
                Divider(height: 1, color: Colors.grey.shade100),
                ListTile(
                  leading: const Icon(Icons.chat_bubble_outline, color: AppTheme.whatsappGreen),
                  title: const Text('Naxr Support Help', style: TextStyle(fontSize: 14)),
                  subtitle: const Text('Open WhatsApp to message Admin support', style: TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right, size: 20),
                  onTap: _handleSupportLink,
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // Logout Button
          OutlinedButton(
            onPressed: _handleLogout,
            style: OutlinedButton.styleFrom(
              foregroundColor: AppTheme.dangerRed,
              side: const BorderSide(color: AppTheme.dangerRed),
            ),
            child: const Text('Sign Out of Portal'),
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }
}
