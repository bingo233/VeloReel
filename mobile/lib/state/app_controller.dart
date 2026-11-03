import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/lan_client.dart';
import '../discovery/lan_discovery.dart';
import '../models.dart';

class AppController extends ChangeNotifier {
  static const String _baseUrlKey = 'serverBaseUrl';

  final LanDiscovery discovery = LanDiscovery();
  final List<LanDevice> devices = <LanDevice>[];

  StreamSubscription<LanDevice>? _subscription;
  LanClient? _client;

  LanInfo? info;
  String? baseUrl;
  List<MediaItem> favorites = const <MediaItem>[];
  List<SiteSummary> sites = const <SiteSummary>[];
  List<Map<String, dynamic>> rules = const <Map<String, dynamic>>[];
  List<HistoryItem> history = const <HistoryItem>[];
  bool historyLoading = false;
  String? historyError;
  bool discovering = false;
  bool busy = false;
  bool initializing = true;
  String? error;

  LanClient? get client => _client;
  bool get connected => _client != null;

  Future<void> init() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_baseUrlKey);
      unawaited(startDiscovery());
      if (saved != null && saved.isNotEmpty) {
        await connectTo(saved, remember: false, silent: true);
      }
    } finally {
      initializing = false;
      notifyListeners();
    }
  }

  Future<void> startDiscovery() async {
    if (discovering) {
      return;
    }
    discovering = true;
    notifyListeners();
    _subscription = discovery.stream.listen(_onDevice);
    await discovery.start();
  }

  void _onDevice(LanDevice device) {
    if (devices.any((item) => item.baseUrl == device.baseUrl)) {
      return;
    }
    devices.add(device);
    notifyListeners();
  }

  Future<void> restartDiscovery() async {
    devices.clear();
    await _stopDiscovery();
    await startDiscovery();
  }

  Future<bool> connectTo(String url, {bool remember = true, bool silent = false}) async {
    var normalized = url.trim().replaceAll(RegExp(r'/+$'), '');
    if (normalized.isEmpty) {
      error = '请输入桌面端地址';
      notifyListeners();
      return false;
    }
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = 'http://$normalized';
    }
    busy = true;
    if (!silent) {
      error = null;
    }
    notifyListeners();

    final next = LanClient(normalized);
    try {
      final serverInfo = await next.info();
      final siteList = await next.sites();
      final favoriteList = await next.favorites();

      _client?.close();
      _client = next;
      info = serverInfo;
      sites = siteList;
      favorites = favoriteList;
      baseUrl = normalized;
      error = null;

      if (remember) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_baseUrlKey, normalized);
      }
      await _stopDiscovery();
      return true;
    } catch (exception) {
      next.close();
      error = exception.toString();
      return false;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> refreshFavorites() async {
    final client = _client;
    if (client == null) {
      return;
    }
    busy = true;
    error = null;
    notifyListeners();
    try {
      favorites = await client.favorites();
    } catch (exception) {
      error = exception.toString();
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> refreshHistory() async {
    final client = _client;
    if (client == null) {
      return;
    }
    historyLoading = true;
    historyError = null;
    notifyListeners();
    try {
      final payload = await client.histories();
      history = payload.map(HistoryItem.fromJson).toList(growable: false);
    } catch (exception) {
      historyError = exception.toString();
    } finally {
      historyLoading = false;
      notifyListeners();
    }
  }

  /// 按站点 ID 查找名称，历史记录本身不携带站点名。
  String siteName(String siteId) {
    for (final site in sites) {
      if (site.siteId == siteId) {
        return site.siteName;
      }
    }
    return '';
  }

  Future<List<MediaItem>> search(String keyword, {String? siteId}) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.search(keyword, siteId: siteId);
  }

  Future<VodDetail> loadDetail(MediaItem item) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.detail(item);
  }

  Future<StreamResolution> resolveStream({
    required String siteId,
    required String playPageUrl,
  }) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.resolveStream(siteId: siteId, playPageUrl: playPageUrl);
  }

  /// 按详情地址查找收藏，找不到返回 null。
  MediaItem? favoriteFor(MediaItem item) {
    for (final favorite in favorites) {
      if (favorite.detailUrl == item.detailUrl) {
        return favorite;
      }
    }
    return null;
  }

  bool isFavorite(MediaItem item) => favoriteFor(item) != null;

  Future<void> addFavorite(MediaItem item) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    await client.addFavorite(item);
    favorites = await client.favorites();
    notifyListeners();
  }

  Future<void> removeFavorite(MediaItem item) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    final favorite = favoriteFor(item);
    if (favorite?.favoriteId == null) {
      return;
    }
    await client.removeFavorite(favorite!.favoriteId!);
    favorites = await client.favorites();
    notifyListeners();
  }

  Future<Map<String, dynamic>?> loadHistory(MediaItem item) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.historyFor(siteId: item.siteId, detailUrl: item.detailUrl);
  }

  Future<void> saveProgress(Map<String, dynamic> payload) async {
    final client = _client;
    if (client == null) {
      return;
    }
    await client.saveProgress(payload);
  }

  Future<List<Map<String, dynamic>>> loadRules() async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    rules = await client.rules();
    notifyListeners();
    return rules;
  }

  Future<Map<String, dynamic>> loadRule(String siteId) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.rule(siteId);
  }

  Future<Map<String, dynamic>> saveRule(
    String siteId,
    Map<String, dynamic> body,
  ) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    final saved = await client.saveRule(siteId, body);
    await loadRules();
    return saved;
  }

  Future<void> deleteRule(String siteId) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    await client.deleteRule(siteId);
    await loadRules();
  }

  /// 远程封面改走桌面端代理，规避站点防盗链与 HTTPS 混合内容限制。
  String imageUrl(String raw) {
    final base = baseUrl;
    if (raw.isEmpty || base == null) {
      return raw;
    }
    final lower = raw.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      return raw;
    }
    return '$base/api/v1/image?url=${Uri.encodeComponent(raw)}';
  }

  Future<List<DlnaDevice>> dlnaDevices() async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.dlnaDevices();
  }

  Future<void> dlnaCast({
    required String deviceId,
    required String url,
    required String title,
  }) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.dlnaCast(deviceId: deviceId, url: url, title: title);
  }

  Future<void> dlnaStop(String deviceId) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.dlnaStop(deviceId);
  }

  Future<DlnaPosition> dlnaPosition(String deviceId) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.dlnaPosition(deviceId);
  }

  Future<void> dlnaControl({
    required String deviceId,
    required String action,
    int? positionMs,
  }) async {
    final client = _client;
    if (client == null) {
      throw LanApiException('尚未连接桌面端');
    }
    return client.dlnaControl(
      deviceId: deviceId,
      action: action,
      positionMs: positionMs,
    );
  }

  Future<void> disconnect() async {
    _client?.close();
    _client = null;
    info = null;
    baseUrl = null;
    favorites = const <MediaItem>[];
    sites = const <SiteSummary>[];
    rules = const <Map<String, dynamic>>[];
    history = const <HistoryItem>[];
    historyError = null;
    error = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_baseUrlKey);
    notifyListeners();
    await restartDiscovery();
  }

  Future<void> _stopDiscovery() async {
    await _subscription?.cancel();
    _subscription = null;
    discovery.stop();
    discovering = false;
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    unawaited(discovery.dispose());
    _client?.close();
    super.dispose();
  }
}
