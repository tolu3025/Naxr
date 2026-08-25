import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../stores/vendor_store.dart';
import '../theme.dart';
import 'knowledge_screen.dart';

class DashboardTab extends StatefulWidget {
  final void Function(int)? onSelectTab;
  const DashboardTab({super.key, this.onSelectTab});

  @override
  State<DashboardTab> createState() => _DashboardTabState();
}

class _DashboardTabState extends State<DashboardTab> {
  bool _isLoading = false;
  List<Map<String, dynamic>> _recentOrders = [];
  final NumberFormat _currencyFormat = NumberFormat.currency(locale: 'en_NG', symbol: '₦', decimalDigits: 0);

  @override
  void initState() {
    super.initState();
    _handleRefresh();
  }

  Future<void> _handleRefresh() async {
    setState(() {
      _isLoading = true;
    });

    final store = Provider.of<VendorStore>(context, listen: false);
    try {
      await store.fetchDashboard();
      setState(() {
        _recentOrders = store.recentOrders;
      });
    } catch (e) {
      debugPrint('Error loading dashboard: $e');
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = Provider.of<VendorStore>(context);
    final theme = Theme.of(context);

    return RefreshIndicator(
      onRefresh: _handleRefresh,
      color: AppTheme.primaryGreen,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // AI Autopilot Banner
            Container(
              color: store.responseMode == 'auto'
                  ? AppTheme.whatsappGreen.withOpacity(0.1)
                  : AppTheme.warningAmber.withOpacity(0.1),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                children: [
                  Icon(
                    store.responseMode == 'auto' ? Icons.android : Icons.back_hand_outlined,
                    color: store.responseMode == 'auto' ? AppTheme.whatsappGreen : AppTheme.warningAmber,
                    size: 24,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      store.responseMode == 'auto'
                          ? 'Naxr AI Agent is Active — Auto replying to conversations and generating payment references.'
                          : 'Manual Mode Enabled — AI agent is paused.',
                      style: TextStyle(
                        fontSize: 13,
                        color: store.responseMode == 'auto' ? Colors.green.shade900 : Colors.orange.shade900,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Store Title & Connection Banner
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            store.businessName.isNotEmpty ? store.businessName : 'My Store',
                            style: const TextStyle(
                              fontSize: 24,
                              fontWeight: FontWeight.bold,
                              color: AppTheme.secondaryDark,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Row(
                            children: [
                              Container(
                                width: 8,
                                height: 8,
                                decoration: BoxDecoration(
                                  color: store.isConnected ? AppTheme.whatsappGreen : Colors.grey.shade400,
                                  shape: BoxShape.circle,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Text(
                                store.isConnected ? 'Baileys Connected' : 'WhatsApp Disconnected',
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: AppTheme.textMuted,
                                ),
                              ),
                              const SizedBox(width: 8),
                              InkWell(
                                onTap: () => _handleShowPairingCodeDialog(context, store),
                                child: Text(
                                  store.isConnected ? '(Relink)' : '(Link Device)',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: AppTheme.primaryGreen,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                      Stack(
                        children: [
                          IconButton(
                            icon: const Icon(Icons.notifications_none, size: 28),
                            onPressed: () {
                              if (widget.onSelectTab != null) {
                                widget.onSelectTab!(1); // Go to Chats tab
                              }
                            },
                          ),
                          if (store.unreadMessages > 0)
                            Positioned(
                              right: 6,
                              top: 6,
                              child: Container(
                                padding: const EdgeInsets.all(4),
                                decoration: const BoxDecoration(
                                  color: AppTheme.dangerRed,
                                  shape: BoxShape.circle,
                                ),
                                constraints: const BoxConstraints(
                                  minWidth: 16,
                                  minHeight: 16,
                                ),
                                child: Text(
                                  '${store.unreadMessages}',
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
                    ],
                  ),
                  const SizedBox(height: 24),

                  // Sales Performance Header
                  const Text(
                    'Sales Performance',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.secondaryDark,
                    ),
                  ),
                  const SizedBox(height: 12),

                  // Horizontal scrollable revenue cards
                  SizedBox(
                    height: 110,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        _buildRevenueCard(
                          label: "Today's Sales",
                          value: store.revenue['today'] ?? 0,
                          trend: '+12% vs yesterday',
                        ),
                        _buildRevenueCard(
                          label: 'This Week',
                          value: store.revenue['week'] ?? 0,
                          trend: '+8% vs last week',
                        ),
                        _buildRevenueCard(
                          label: 'This Month',
                          value: store.revenue['month'] ?? 0,
                          trend: '+24% vs last month',
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),

                  // Quick Actions Grid
                  const Text(
                    'Quick Actions',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.secondaryDark,
                    ),
                  ),
                  const SizedBox(height: 12),

                  GridView.count(
                    crossAxisCount: 2,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    mainAxisSpacing: 12,
                    crossAxisSpacing: 12,
                    childAspectRatio: 1.4,
                    children: [
                      _buildGridCard(
                        icon: Icons.inventory_2_outlined,
                        label: 'Products',
                        onTap: () {
                          if (widget.onSelectTab != null) {
                            widget.onSelectTab!(2);
                          }
                        },
                      ),
                      _buildGridCard(
                        icon: Icons.chat_bubble_outline,
                        label: 'Chats Inbox',
                        onTap: () {
                          if (widget.onSelectTab != null) {
                            widget.onSelectTab!(1);
                          }
                        },
                      ),
                      _buildGridCard(
                        icon: Icons.psychology_outlined,
                        label: 'AI Config',
                        onTap: () {
                          if (widget.onSelectTab != null) {
                            widget.onSelectTab!(3);
                          }
                        },
                      ),
                      _buildGridCard(
                        icon: Icons.help_outline,
                        label: 'FAQs Setup',
                        onTap: () {
                          Navigator.push(
                            context,
                            MaterialPageRoute(builder: (context) => const KnowledgeScreen()),
                          ).then((_) => _handleRefresh());
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),

                  // Recent Orders
                  const Text(
                    'Recent Orders',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.secondaryDark,
                    ),
                  ),
                  const SizedBox(height: 12),

                  if (_isLoading)
                    const Center(child: Padding(
                      padding: EdgeInsets.all(16.0),
                      child: CircularProgressIndicator(color: AppTheme.primaryGreen),
                    ))
                  else
                    ..._recentOrders.map((order) => _buildOrderCard(order)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRevenueCard({required String label, required double value, required String trend}) {
    return Card(
      margin: const EdgeInsets.only(right: 12),
      child: Container(
        width: 140,
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              label,
              style: const TextStyle(fontSize: 11, color: AppTheme.textMuted),
            ),
            const SizedBox(height: 4),
            Text(
              _currencyFormat.format(value),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
            ),
            const SizedBox(height: 4),
            Text(
              trend,
              style: const TextStyle(fontSize: 9, color: AppTheme.whatsappGreen, fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildGridCard({required IconData icon, required String label, required VoidCallback onTap}) {
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 32, color: AppTheme.primaryGreen),
            const SizedBox(height: 8),
            Text(
              label,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildOrderCard(Map<String, dynamic> order) {
    Color badgeColor;
    switch (order['status']) {
      case 'PAID':
        badgeColor = AppTheme.whatsappGreen;
        break;
      case 'PENDING':
        badgeColor = AppTheme.warningAmber;
        break;
      default:
        badgeColor = AppTheme.primaryGreen;
    }

    String dateStr = order['date'] ?? '';
    try {
      final parsed = DateTime.parse(dateStr).toLocal();
      final now = DateTime.now();
      final difference = now.difference(parsed).inDays;
      if (difference == 0 && now.day == parsed.day) {
        dateStr = 'Today ${DateFormat('h:mm a').format(parsed)}';
      } else if (difference <= 1 && now.subtract(const Duration(days: 1)).day == parsed.day) {
        dateStr = 'Yesterday ${DateFormat('h:mm a').format(parsed)}';
      } else {
        dateStr = DateFormat('dd MMM, h:mm a').format(parsed);
      }
    } catch (_) {}

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14.0),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '+${order['customerPhone']}',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: AppTheme.secondaryDark),
                ),
                const SizedBox(height: 4),
                Text(
                  dateStr,
                  style: const TextStyle(color: Colors.grey, fontSize: 12),
                ),
              ],
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  _currencyFormat.format(order['amount']),
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: AppTheme.secondaryDark),
                ),
                const SizedBox(height: 4),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: badgeColor,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    order['status'],
                    style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _handleShowPairingCodeDialog(BuildContext context, VendorStore store) {
    final phoneController = TextEditingController();
    final otpController = TextEditingController();

    phoneController.text = store.phone ?? '';

    showDialog(
      context: context,
      barrierDismissible: true,
      builder: (context) {
        int currentStep = 1;
        bool isRequesting = false;
        bool isVerifying = false;

        return StatefulBuilder(
          builder: (context, setDialogState) {
            void handleSendOTP() async {
              final targetPhone = phoneController.text.trim();
              if (targetPhone.isEmpty) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Please enter your WhatsApp phone number.')),
                );
                return;
              }

              setDialogState(() {
                isRequesting = true;
              });

              try {
                await store.addWhatsAppNumber(targetPhone);
                await store.requestWhatsAppOTP();
                
                setDialogState(() {
                  currentStep = 2;
                });
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Verification SMS sent successfully!')),
                );
              } catch (e) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Failed to request SMS: $e')),
                );
              } finally {
                setDialogState(() {
                  isRequesting = false;
                });
              }
            }

            void handleVerifyOTP() async {
              final otpCode = otpController.text.trim();
              if (otpCode.isEmpty || otpCode.length < 6) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Please enter the 6-digit verification code.')),
                );
                return;
              }

              setDialogState(() {
                isVerifying = true;
              });

              try {
                await store.verifyWhatsAppOTP(otpCode);
                Navigator.pop(context);
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('WhatsApp linked successfully! Your AI is now online! 🎉')),
                );
              } catch (e) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Verification failed: $e')),
                );
              } finally {
                setDialogState(() {
                  isVerifying = false;
                });
              }
            }

            return AlertDialog(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              title: Row(
                children: [
                  const Icon(Icons.whatsapp, color: AppTheme.whatsappGreen),
                  const SizedBox(width: 8),
                  Text(
                    currentStep == 1 ? 'Link WhatsApp AI' : 'Enter Verification Code',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                ],
              ),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (currentStep == 1) ...[
                      const Text(
                        'To link your store AI, enter your WhatsApp phone number. We will send you an SMS with a verification code.',
                        style: TextStyle(fontSize: 13, color: AppTheme.textMuted, height: 1.4),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        'WhatsApp Phone Number',
                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                      ),
                      const SizedBox(height: 6),
                      TextField(
                        controller: phoneController,
                        keyboardType: TextInputType.phone,
                        decoration: const InputDecoration(
                          hintText: 'e.g. 2348148698365',
                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        ),
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        '⚠️ Note: Before linking, ensure this number is NOT currently registered on a physical phone WhatsApp/Business app (you must delete the account from your phone\'s WhatsApp app first).',
                        style: TextStyle(fontSize: 11, color: AppTheme.dangerRed, height: 1.4),
                      ),
                    ] else ...[
                      Text(
                        'Enter the 6-digit verification code sent to +${phoneController.text.trim()}:',
                        style: const TextStyle(fontSize: 13, color: AppTheme.textMuted, height: 1.4),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        'Verification Code',
                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.secondaryDark),
                      ),
                      const SizedBox(height: 6),
                      TextField(
                        controller: otpController,
                        keyboardType: TextInputType.number,
                        maxLength: 6,
                        decoration: const InputDecoration(
                          hintText: 'Enter 6-digit code',
                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                          counterText: '',
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: (isRequesting || isVerifying) ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                if (currentStep == 1)
                  ElevatedButton(
                    onPressed: isRequesting ? null : handleSendOTP,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.primaryGreen,
                    ),
                    child: isRequesting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                          )
                        : const Text('Send Verification SMS'),
                  )
                else
                  ElevatedButton(
                    onPressed: isVerifying ? null : handleVerifyOTP,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.whatsappGreen,
                    ),
                    child: isVerifying
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                          )
                        : const Text('Verify & Link'),
                  ),
              ],
            );
          },
        );
      },
    );
  }
}
