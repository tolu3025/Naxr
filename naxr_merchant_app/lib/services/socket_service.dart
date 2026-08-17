import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../config.dart';

class SocketService {
  io.Socket? _socket;
  final String _baseUrl = AppConfig.baseUrl;

  io.Socket? get socket => _socket;

  void connect({
    required String vendorPhone,
    required VoidCallback onConnect,
    required Function(dynamic) onNewMessage,
    required Function(dynamic) onNewOrder,
    required Function(dynamic) onAiReplied,
    Function(bool)? onWhatsappStatus,
  }) {
    // Disconnect existing socket first
    disconnect();

    debugPrint('Initializing WebSocket connection to $_baseUrl with phone $vendorPhone...');
    
    try {
      _socket = io.io(
        _baseUrl,
        io.OptionBuilder()
            .setTransports(['websocket'])
            .setQuery({'vendor_phone': vendorPhone})
            .enableAutoConnect()
            .build(),
      );

      _socket!.onConnect((_) {
        debugPrint('WebSocket connected successfully');
        _socket!.emit('register_vendor', {'vendor_phone': vendorPhone});
        onConnect();
      });

      _socket!.on('new_message', (data) {
        debugPrint('WebSocket received [new_message]');
        onNewMessage(data);
      });

      _socket!.on('new_order', (data) {
        debugPrint('WebSocket received [new_order]');
        onNewOrder(data);
      });

      _socket!.on('ai_replied', (data) {
        debugPrint('WebSocket received [ai_replied]');
        onAiReplied(data);
      });

      _socket!.on('whatsapp_status', (data) {
        debugPrint('WebSocket received [whatsapp_status]: $data');
        final connected = data['connected'] == true;
        if (onWhatsappStatus != null) onWhatsappStatus(connected);
      });

      _socket!.onDisconnect((_) {
        debugPrint('WebSocket disconnected');
        if (onWhatsappStatus != null) onWhatsappStatus(false);
      });

      _socket!.onConnectError((err) {
        debugPrint('WebSocket connection error: $err');
      });
      
    } catch (e) {
      debugPrint('WebSocket initialization failed: $e');
    }
  }

  void disconnect() {
    if (_socket != null) {
      _socket!.disconnect();
      _socket!.close();
      _socket = null;
      debugPrint('WebSocket socket closed.');
    }
  }
}
