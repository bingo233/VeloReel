import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../models.dart';

const int discoveryPort = 39393;
const int protocolVersion = 1;

class LanDiscovery {
  final StreamController<LanDevice> _controller =
      StreamController<LanDevice>.broadcast();
  RawDatagramSocket? _socket;
  Timer? _timer;

  Stream<LanDevice> get stream => _controller.stream;

  bool get running => _socket != null;

  Future<void> start() async {
    if (_socket != null) {
      return;
    }
    try {
      final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      socket.broadcastEnabled = true;
      socket.listen((event) {
        if (event != RawSocketEvent.read) {
          return;
        }
        final datagram = socket.receive();
        if (datagram == null) {
          return;
        }
        _handleDatagram(datagram);
      });
      _socket = socket;
      _timer = Timer.periodic(const Duration(seconds: 2), (_) {
        sendDiscover();
      });
      sendDiscover();
    } on SocketException {
      // 没有可用网卡时保持静默，由界面提示手动输入地址
    }
  }

  void _handleDatagram(Datagram datagram) {
    try {
      final decoded = jsonDecode(utf8.decode(datagram.data, allowMalformed: true));
      if (decoded is Map<String, dynamic>) {
        final device = LanDevice.fromAnnounce(decoded, datagram.address.address);
        if (device != null) {
          _controller.add(device);
        }
      }
    } on FormatException {
      // 忽略非本协议的广播包
    }
  }

  void sendDiscover() {
    final socket = _socket;
    if (socket == null) {
      return;
    }
    final payload = jsonEncode({
      'v': protocolVersion,
      'type': 'discover',
      'clientId': 'veloreel-mobile',
      'clientName': 'VeloReel Mobile',
      'platform': 'android',
    });
    socket.send(
      utf8.encode(payload),
      InternetAddress('255.255.255.255'),
      discoveryPort,
    );
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _socket?.close();
    _socket = null;
  }

  Future<void> dispose() async {
    stop();
    await _controller.close();
  }
}
