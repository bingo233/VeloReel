import 'package:flutter/material.dart';

import '../state/app_controller.dart';
import '../theme.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 24, 28, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('设置', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
              const SizedBox(height: 16),
              _Section(
                title: '已连接的桌面端',
                rows: <_RowData>[
                  _RowData('设备名称', controller.info?.name ?? '—'),
                  _RowData('地址', controller.baseUrl ?? '—'),
                  _RowData('桌面端版本', controller.info?.appVersion ?? '—'),
                  _RowData('协议版本', '${controller.info?.protocol ?? 0}'),
                  _RowData('收藏数量', '${controller.favorites.length}'),
                  _RowData('站点数量', '${controller.sites.length}'),
                ],
              ),
              const SizedBox(height: 16),
              _Section(
                title: '连接操作',
                child: Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    OutlinedButton.icon(
                      onPressed: controller.busy
                          ? null
                          : () async {
                              final url = controller.baseUrl;
                              if (url != null) {
                                await controller.connectTo(url);
                              }
                            },
                      icon: const Icon(Icons.refresh, size: 18),
                      label: const Text('重新连接'),
                    ),
                    OutlinedButton.icon(
                      onPressed: controller.busy ? null : controller.refreshFavorites,
                      icon: const Icon(Icons.bookmark_border, size: 18),
                      label: const Text('刷新收藏'),
                    ),
                    TextButton.icon(
                      onPressed: () => controller.disconnect(),
                      icon: const Icon(Icons.wifi_off, size: 18),
                      label: const Text('断开并重新发现'),
                    ),
                  ],
                ),
              ),
              if (controller.error != null) ...[
                const SizedBox(height: 14),
                Text(controller.error!, style: const TextStyle(color: kDanger, fontSize: 12)),
              ],
              const SizedBox(height: 16),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: kSurface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: kBorder),
                ),
                child: const Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('关于播放', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    SizedBox(height: 8),
                    Text(
                      '当前版本支持浏览收藏、搜索与详情。远端播放需要桌面端完成 LAN 媒体服务（阶段 2），完成后这里会直接拉起播放器。',
                      style: TextStyle(color: kMuted, fontSize: 12, height: 1.6),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _RowData {
  const _RowData(this.label, this.value);

  final String label;
  final String value;
}

class _Section extends StatelessWidget {
  const _Section({required this.title, this.rows, this.child});

  final String title;
  final List<_RowData>? rows;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: kSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: kBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 14),
          if (rows != null)
            for (final row in rows!)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Row(
                  children: [
                    SizedBox(width: 110, child: Text(row.label, style: const TextStyle(color: kMuted, fontSize: 13))),
                    Expanded(child: Text(row.value, style: const TextStyle(fontSize: 13))),
                  ],
                ),
              ),
          if (child != null) child!,
        ],
      ),
    );
  }
}
