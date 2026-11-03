import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models.dart';

class LanApiException implements Exception {
  LanApiException(this.message);

  final String message;

  @override
  String toString() => message;
}

class LanClient {
  LanClient(this.baseUrl);

  final String baseUrl;
  final http.Client _client = http.Client();

  void close() {
    _client.close();
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    final base = Uri.parse(baseUrl);
    return base.replace(path: path, queryParameters: query);
  }

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
  }) async {
    final request = http.Request(method, _uri(path, query));
    request.headers['Accept'] = 'application/json';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final streamed = await _client
        .send(request)
        .timeout(Duration(seconds: method == 'GET' ? 15 : 30));
    final response = await http.Response.fromStream(streamed);
    if (response.statusCode != 200) {
      throw LanApiException(_errorMessage(response));
    }
    if (response.bodyBytes.isEmpty) {
      return null;
    }
    try {
      return jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException {
      throw LanApiException('服务返回的内容不是有效 JSON');
    }
  }

  Future<dynamic> _get(String path, [Map<String, String>? query]) {
    return _request('GET', path, query: query);
  }

  String _errorMessage(http.Response response) {
    try {
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      if (decoded is Map<String, dynamic>) {
        final error = decoded['error'];
        if (error is Map<String, dynamic> && error['message'] is String) {
          return error['message'] as String;
        }
      }
    } on FormatException {
      // 使用状态码兜底
    }
    return '请求失败（HTTP ${response.statusCode}）';
  }

  Future<dynamic> _post(String path, Map<String, dynamic> body) {
    return _request('POST', path, body: body);
  }

  Future<StreamResolution> resolveStream({
    required String siteId,
    required String playPageUrl,
    bool forceRefresh = false,
  }) async {
    final payload = await _post('/api/v1/stream/resolve', {
      'siteId': siteId,
      'playPageUrl': playPageUrl,
      'forceRefresh': forceRefresh,
    });
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('播放地址格式不正确');
    }
    final resolution = StreamResolution.fromJson(payload);
    if (resolution.url.isEmpty) {
      throw LanApiException('桌面端没有返回可播放地址');
    }
    return resolution;
  }

  Future<LanInfo> info() async {
    final payload = await _get('/api/v1/info');
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('服务信息格式不正确');
    }
    return LanInfo.fromJson(payload);
  }

  Future<List<MediaItem>> favorites() async {
    final payload = await _get('/api/v1/favorites');
    if (payload is! List) {
      throw LanApiException('收藏列表格式不正确');
    }
    return payload
        .whereType<Map<String, dynamic>>()
        .map(MediaItem.fromJson)
        .toList(growable: false);
  }

  Future<List<SiteSummary>> sites() async {
    final payload = await _get('/api/v1/sites');
    if (payload is! List) {
      throw LanApiException('站点列表格式不正确');
    }
    return payload
        .whereType<Map<String, dynamic>>()
        .map(SiteSummary.fromJson)
        .toList(growable: false);
  }

  Future<List<MediaItem>> search(String keyword, {String? siteId}) async {
    final query = <String, String>{'keyword': keyword};
    if (siteId != null && siteId.isNotEmpty) {
      query['siteId'] = siteId;
    }
    final payload = await _get('/api/v1/search', query);
    if (payload is! List) {
      throw LanApiException('搜索结果格式不正确');
    }
    return payload
        .whereType<Map<String, dynamic>>()
        .map(MediaItem.fromJson)
        .toList(growable: false);
  }

  Future<List<DlnaDevice>> dlnaDevices() async {
    final payload = await _get('/api/v1/dlna/devices');
    if (payload is! List) {
      throw LanApiException('电视列表格式不正确');
    }
    return payload
        .whereType<Map<String, dynamic>>()
        .map(DlnaDevice.fromJson)
        .toList(growable: false);
  }

  Future<void> dlnaCast({
    required String deviceId,
    required String url,
    required String title,
  }) async {
    await _post('/api/v1/dlna/cast', {
      'deviceId': deviceId,
      'url': url,
      'title': title,
    });
  }

  Future<void> dlnaStop(String deviceId) async {
    await _post('/api/v1/dlna/stop', {'deviceId': deviceId});
  }

  Future<DlnaPosition> dlnaPosition(String deviceId) async {
    final payload = await _get('/api/v1/dlna/position', {'deviceId': deviceId});
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('投屏进度格式不正确');
    }
    return DlnaPosition.fromJson(payload);
  }

  Future<void> dlnaControl({
    required String deviceId,
    required String action,
    int? positionMs,
  }) async {
    final body = <String, dynamic>{'deviceId': deviceId, 'action': action};
    if (positionMs != null) {
      body['positionMs'] = positionMs;
    }
    await _post('/api/v1/dlna/control', body);
  }

  Future<VodDetail> detail(MediaItem item) async {
    final payload = await _get('/api/v1/detail', {
      'siteId': item.siteId,
      'detailUrl': item.detailUrl,
    });
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('详情格式不正确');
    }
    return VodDetail.fromJson(payload);
  }

  Future<MediaItem> addFavorite(MediaItem item) async {
    final payload = await _request('POST', '/api/v1/favorites', body: {
      'siteId': item.siteId,
      'siteName': item.siteName,
      'title': item.title,
      'coverUrl': item.coverUrl,
      'detailUrl': item.detailUrl,
    });
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('收藏返回格式不正确');
    }
    return MediaItem.fromJson(payload);
  }

  Future<void> removeFavorite(String favoriteId) async {
    await _request(
      'DELETE',
      '/api/v1/favorites/${Uri.encodeComponent(favoriteId)}',
    );
  }

  /// 读取全部观看历史（桌面端按最近观看排序）。
  Future<List<Map<String, dynamic>>> histories() async {
    final payload = await _get('/api/v1/history');
    if (payload is! List) {
      throw LanApiException('观看历史格式不正确');
    }
    return payload.whereType<Map<String, dynamic>>().toList(growable: false);
  }

  /// 读取某部影片的观看记录，没有记录时返回 null。
  Future<Map<String, dynamic>?> historyFor({
    required String siteId,
    required String detailUrl,
  }) async {
    final payload = await _get('/api/v1/history', {
      'siteId': siteId,
      'detailUrl': detailUrl,
    });
    if (payload == null) {
      return null;
    }
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('观看记录格式不正确');
    }
    return payload;
  }

  Future<void> saveProgress(Map<String, dynamic> payload) async {
    await _request('POST', '/api/v1/progress', body: payload);
  }

  Future<List<Map<String, dynamic>>> rules() async {
    final payload = await _get('/api/v1/rules');
    if (payload is! List) {
      throw LanApiException('规则列表格式不正确');
    }
    return payload.whereType<Map<String, dynamic>>().toList(growable: false);
  }

  Future<Map<String, dynamic>> rule(String siteId) async {
    final payload = await _get('/api/v1/rules/${Uri.encodeComponent(siteId)}');
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('规则格式不正确');
    }
    return payload;
  }

  Future<Map<String, dynamic>> saveRule(
    String siteId,
    Map<String, dynamic> body,
  ) async {
    final payload = await _request(
      'PUT',
      '/api/v1/rules/${Uri.encodeComponent(siteId)}',
      body: body,
    );
    if (payload is! Map<String, dynamic>) {
      throw LanApiException('规则保存结果格式不正确');
    }
    return payload;
  }

  Future<void> deleteRule(String siteId) async {
    await _request('DELETE', '/api/v1/rules/${Uri.encodeComponent(siteId)}');
  }
}
