class LanDevice {
  const LanDevice({
    required this.name,
    required this.appVersion,
    required this.host,
    required this.port,
    required this.protocol,
  });

  final String name;
  final String appVersion;
  final String host;
  final int port;
  final int protocol;

  String get baseUrl => 'http://$host:$port';

  Map<String, dynamic> toJson() => {
        'name': name,
        'appVersion': appVersion,
        'host': host,
        'port': port,
        'protocol': protocol,
      };

  static LanDevice? fromJson(Map<String, dynamic> json) {
    final host = json['host'];
    final port = json['port'];
    if (host is! String || port is! num) {
      return null;
    }
    return LanDevice(
      name: json['name'] is String ? json['name'] as String : '局域网设备',
      appVersion: json['appVersion'] is String ? json['appVersion'] as String : '',
      host: host,
      port: port.toInt(),
      protocol: json['protocol'] is num ? (json['protocol'] as num).toInt() : 1,
    );
  }

  static LanDevice? fromAnnounce(Map<String, dynamic> json, String host) {
    if (json['type'] != 'announce') {
      return null;
    }
    final port = json['httpPort'];
    if (port is! num || port <= 0) {
      return null;
    }
    return LanDevice(
      name: json['name'] is String ? json['name'] as String : '局域网设备',
      appVersion: json['appVersion'] is String ? json['appVersion'] as String : '',
      host: host,
      port: port.toInt(),
      protocol: json['v'] is num ? (json['v'] as num).toInt() : 1,
    );
  }
}

class LanInfo {
  const LanInfo({
    required this.name,
    required this.appVersion,
    required this.protocol,
  });

  final String name;
  final String appVersion;
  final int protocol;

  factory LanInfo.fromJson(Map<String, dynamic> json) {
    return LanInfo(
      name: json['name'] is String ? json['name'] as String : 'VeloReel',
      appVersion: json['appVersion'] is String ? json['appVersion'] as String : '',
      protocol: json['protocol'] is num ? (json['protocol'] as num).toInt() : 1,
    );
  }
}

class MediaItem {
  MediaItem({
    required this.siteId,
    required this.siteName,
    required this.title,
    required this.coverUrl,
    required this.detailUrl,
    this.favoriteId,
  });

  final String siteId;
  final String siteName;
  final String title;
  final String coverUrl;
  final String detailUrl;
  final String? favoriteId;

  factory MediaItem.fromJson(Map<String, dynamic> json) {
    return MediaItem(
      siteId: _asString(json['siteId']),
      siteName: _asString(json['siteName']),
      title: _asString(json['title']),
      coverUrl: _asString(json['coverUrl']),
      detailUrl: _asString(json['detailUrl']),
      favoriteId: json['favoriteId'] is String ? json['favoriteId'] as String : null,
    );
  }
}

class HistoryItem {
  const HistoryItem({
    required this.seriesId,
    required this.siteId,
    required this.title,
    required this.coverUrl,
    required this.detailUrl,
    required this.lastEpisodeName,
    required this.lastCurrentTime,
    required this.lastDuration,
    required this.updatedAt,
  });

  final String seriesId;
  final String siteId;
  final String title;
  final String coverUrl;
  final String detailUrl;
  final String lastEpisodeName;
  final double lastCurrentTime;
  final double lastDuration;
  final int updatedAt;

  double get progress {
    if (lastDuration <= 0) {
      return 0;
    }
    return (lastCurrentTime / lastDuration).clamp(0.0, 1.0);
  }

  factory HistoryItem.fromJson(Map<String, dynamic> json) {
    return HistoryItem(
      seriesId: _asString(json['seriesId']),
      siteId: _asString(json['siteId']),
      title: _asString(json['title']),
      coverUrl: _asString(json['coverUrl']),
      detailUrl: _asString(json['detailUrl']),
      lastEpisodeName: _asString(json['lastEpisodeName']),
      lastCurrentTime: _asNumber(json['lastCurrentTime']),
      lastDuration: _asNumber(json['lastDuration']),
      updatedAt: json['updatedAt'] is num ? (json['updatedAt'] as num).toInt() : 0,
    );
  }

  MediaItem toMediaItem(String siteName) {
    return MediaItem(
      siteId: siteId,
      siteName: siteName,
      title: title,
      coverUrl: coverUrl,
      detailUrl: detailUrl,
    );
  }
}

class SiteSummary {
  const SiteSummary({required this.siteId, required this.siteName});

  final String siteId;
  final String siteName;

  factory SiteSummary.fromJson(Map<String, dynamic> json) {
    return SiteSummary(
      siteId: _asString(json['siteId']),
      siteName: _asString(json['siteName']),
    );
  }
}

class Episode {
  const Episode({required this.name, required this.url, required this.index});

  final String name;
  final String url;
  final int index;

  factory Episode.fromJson(Map<String, dynamic> json) {
    final url = json['url'] ?? json['episodeUrl'];
    return Episode(
      name: _asString(json['name']),
      url: url is String ? url : '',
      index: json['index'] is num ? (json['index'] as num).toInt() : 0,
    );
  }
}

class PlaylistGroup {
  const PlaylistGroup({required this.name, required this.episodes});

  final String name;
  final List<Episode> episodes;

  factory PlaylistGroup.fromJson(Map<String, dynamic> json) {
    final episodes = json['episodes'];
    return PlaylistGroup(
      name: _asString(json['name']),
      episodes: episodes is List
          ? episodes
              .whereType<Map<String, dynamic>>()
              .map(Episode.fromJson)
              .toList(growable: false)
          : const <Episode>[],
    );
  }
}

class VodDetail {
  const VodDetail({
    required this.siteId,
    required this.title,
    required this.coverUrl,
    required this.description,
    required this.detailUrl,
    required this.playlistGroups,
  });

  final String siteId;
  final String title;
  final String coverUrl;
  final String description;
  final String detailUrl;
  final List<PlaylistGroup> playlistGroups;

  factory VodDetail.fromJson(Map<String, dynamic> json) {
    final groups = json['playlistGroups'];
    return VodDetail(
      siteId: _asString(json['siteId']),
      title: _asString(json['title']),
      coverUrl: _asString(json['coverUrl']),
      description: _asString(json['description']),
      detailUrl: _asString(json['detailUrl']),
      playlistGroups: groups is List
          ? groups
              .whereType<Map<String, dynamic>>()
              .map(PlaylistGroup.fromJson)
              .toList(growable: false)
          : const <PlaylistGroup>[],
    );
  }
}

class StreamResolution {
  const StreamResolution({
    required this.sessionId,
    required this.url,
    required this.mediaType,
    required this.fromCache,
  });

  final String sessionId;
  final String url;
  final String mediaType;
  final bool fromCache;

  factory StreamResolution.fromJson(Map<String, dynamic> json) {
    final url = json['localUrl'] ?? json['proxyUrl'] ?? json['localProxyM3u8'];
    return StreamResolution(
      sessionId: _asString(json['sessionId']),
      url: url is String ? url : '',
      mediaType: _asString(json['mediaType']),
      fromCache: json['fromCache'] == true,
    );
  }
}

class DlnaDevice {
  const DlnaDevice({required this.id, required this.name, required this.model});

  final String id;
  final String name;
  final String model;

  factory DlnaDevice.fromJson(Map<String, dynamic> json) {
    return DlnaDevice(
      id: _asString(json['id']),
      name: _asString(json['name']),
      model: _asString(json['model']),
    );
  }
}

class DlnaPosition {
  const DlnaPosition({
    required this.positionMs,
    required this.durationMs,
    required this.state,
  });

  final int positionMs;
  final int durationMs;
  final String state;

  bool get playing => state == 'PLAYING';

  factory DlnaPosition.fromJson(Map<String, dynamic> json) {
    int readInt(dynamic value) {
      if (value is num) {
        return value.toInt();
      }
      return 0;
    }

    return DlnaPosition(
      positionMs: readInt(json['positionMs']),
      durationMs: readInt(json['durationMs']),
      state: _asString(json['state']),
    );
  }
}

String _asString(dynamic value) => value is String ? value : '';

double _asNumber(dynamic value) => value is num ? value.toDouble() : 0;
