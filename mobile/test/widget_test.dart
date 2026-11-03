import 'package:flutter_test/flutter_test.dart';
import 'package:veloreel_mobile/models.dart';

void main() {
  test('解析桌面端发现应答', () {
    final device = LanDevice.fromAnnounce(
      <String, dynamic>{
        'v': 1,
        'type': 'announce',
        'name': '影梭',
        'appVersion': '0.1.0',
        'httpPort': 8790,
      },
      '192.168.1.8',
    );

    expect(device, isNotNull);
    expect(device!.baseUrl, 'http://192.168.1.8:8790');
    expect(device.name, '影梭');
  });

  test('忽略非法发现应答', () {
    expect(LanDevice.fromAnnounce(<String, dynamic>{'type': 'announce'}, '192.168.1.8'), isNull);
    expect(
      LanDevice.fromAnnounce(
        <String, dynamic>{'v': 1, 'type': 'discover', 'httpPort': 8790},
        '192.168.1.8',
      ),
      isNull,
    );
  });

  test('解析详情与选集', () {
    final detail = VodDetail.fromJson(<String, dynamic>{
      'siteId': 'demo',
      'title': '示例影片',
      'coverUrl': '',
      'description': '简介',
      'detailUrl': '/detail/1',
      'playlistGroups': <Map<String, dynamic>>[
        <String, dynamic>{
          'name': '线路 1',
          'episodes': <Map<String, dynamic>>[
            <String, dynamic>{'name': '第 1 集', 'url': '/play/1', 'index': 0},
          ],
        },
      ],
    });

    expect(detail.title, '示例影片');
    expect(detail.playlistGroups, hasLength(1));
    expect(detail.playlistGroups.first.episodes.first.name, '第 1 集');
  });
}
