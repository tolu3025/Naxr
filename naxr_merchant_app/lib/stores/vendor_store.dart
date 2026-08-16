import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class VendorStore extends ChangeNotifier {
  static const String baseUrl = 'http://localhost:3000';

  String? _phone;
  String _businessName = '';
  String _responseMode = 'auto';
  bool _isConnected = false;
  bool _isPro = false;
  int _unreadMessages = 0;
  Map<String, double> _revenue = {'today': 0, 'week': 0, 'month': 0};

  bool _allowNegotiation = false;
  int _maxDiscountPercent = 0;

  String? get phone => _phone;
  String get businessName => _businessName;
  String get responseMode => _responseMode;
  bool get isConnected => _isConnected;
  bool get isPro => _isPro;
  int get unreadMessages => _unreadMessages;
  Map<String, double> get revenue => _revenue;

  bool get allowNegotiation => _allowNegotiation;
  int get maxDiscountPercent => _maxDiscountPercent;

  String? _token;
  String? get token => _token;

  Map<String, String> get _headers {
    final headers = <String, String>{
      'Content-Type': 'application/json',
    };
    if (_token != null) {
      headers['Authorization'] = 'Bearer $_token';
    }
    return headers;
  }

  void setPhone(String phone) {
    _phone = phone;
    notifyListeners();
  }

  void setConnected(bool connected) {
    _isConnected = connected;
    notifyListeners();
  }

  Future<bool> loadAuth() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('token');
      final phone = prefs.getString('vendor_phone');
      if (token != null && phone != null) {
        _token = token;
        _phone = phone;
        notifyListeners();
        return true;
      }
    } catch (e) {
      debugPrint('Error loading auth: $e');
    }
    return false;
  }

  Future<void> saveAuth(String token, String phone) async {
    _token = token;
    _phone = phone;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('token', token);
    await prefs.setString('vendor_phone', phone);
    notifyListeners();
  }

  Future<void> logout() async {
    _token = null;
    _phone = null;
    _businessName = '';
    _isConnected = false;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('token');
    await prefs.remove('vendor_phone');
    notifyListeners();
  }

  Future<void> setResponseMode(String mode) async {
    if (_phone == null) return;
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/vendor/$_phone/settings'),
        headers: _headers,
        body: jsonEncode({'response_mode': mode}),
      );
      if (response.statusCode == 200) {
        _responseMode = mode;
        notifyListeners();
      } else {
        throw Exception('Failed to update mode');
      }
    } catch (e) {
      debugPrint('Error updating response mode, falling back to mock: $e');
      _responseMode = mode;
      notifyListeners();
    }
  }

  Future<void> fetchDashboard() async {
    if (_phone == null) return;
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/api/vendor/$_phone/dashboard'),
        headers: _headers,
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        _businessName = data['business_name'] ?? '';
        _isConnected = data['auth_connected'] == true;
        _unreadMessages = data['unread_messages'] ?? 0;
        _isPro = data['isPro'] == true;
        _responseMode = data['response_mode'] ?? 'auto';

        final revData = data['revenue'] ?? {};
        _revenue = {
          'today': (revData['today'] ?? 0).toDouble(),
          'week': (revData['week'] ?? 0).toDouble(),
          'month': (revData['month'] ?? 0).toDouble(),
        };
        notifyListeners();
      } else {
        throw Exception('Server error');
      }
    } catch (e) {
      debugPrint('Error fetching dashboard, using fallback mocks: $e');
      // Set fallback mocks
      _businessName = 'Vintage Store';
      _isConnected = false;
      _unreadMessages = 2;
      _isPro = false;
      _responseMode = 'auto';
      _revenue = {
        'today': 12000.0,
        'week': 45000.0,
        'month': 180000.0,
      };
      notifyListeners();
    }
  }

  Future<Map<String, dynamic>> fetchSettings() async {
    if (_phone == null) return {};
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/api/vendor/$_phone/settings'),
        headers: _headers,
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        _allowNegotiation = data['allowNegotiation'] == true;
        _maxDiscountPercent = data['maxDiscountPercent'] ?? 0;
        notifyListeners();
        return data;
      } else {
        throw Exception('Server error');
      }
    } catch (e) {
      debugPrint('Using mock settings fallback: $e');
      final mock = {
        'storeName': _businessName.isNotEmpty ? _businessName : 'Vintage Fashion Store',
        'category': 'Fashion & Apparel',
        'bankDetails': 'Access Bank - 0812345678',
        'deliveryInfo': 'Delivery to main gate in campus, or GIGM nationwide.',
        'aiActive': true,
        'allowNegotiation': _allowNegotiation,
        'maxDiscountPercent': _maxDiscountPercent,
      };
      return mock;
    }
  }

  Future<void> saveNegotiationRules(bool allow, int maxPercent) async {
    if (_phone == null) return;
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/vendor/$_phone/settings'),
        headers: _headers,
        body: jsonEncode({
          'allowNegotiation': allow,
          'maxDiscountPercent': maxPercent,
        }),
      );
      if (response.statusCode == 200) {
        _allowNegotiation = allow;
        _maxDiscountPercent = maxPercent;
        notifyListeners();
      } else {
        throw Exception('Server error');
      }
    } catch (e) {
      debugPrint('Error saving negotiation rules, saving locally: $e');
      _allowNegotiation = allow;
      _maxDiscountPercent = maxPercent;
      notifyListeners();
    }
  }
}
