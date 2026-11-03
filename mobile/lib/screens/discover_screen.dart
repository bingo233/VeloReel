import 'package:flutter/material.dart';

import '../models.dart';
import '../state/app_controller.dart';
import '../theme.dart';

class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  final TextEditingController _manualController = TextEditingController();

  @override
  void dispose() {
    _manualController.dispose();
    super.dispose();
  }

  Future<void> _connect(String url) async {
    final ok = await widget.controller.connectTo(url);
    if (!mounted || ok) {
      return;
    }
    final error = widget.controller.error;
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AnimatedBuilder(
        animation: widget.controller,
        builder: (context, _) {
          final devices = widget.controller.devices;
          return SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 760),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            width: 46,
                            height: 46,
                            decoration: BoxDecoration(
                              color: kAccent.withValues(alpha: 0.14),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: const Icon(Icons.play_arrow_rounded, color: kAccent),
                          ),
                          const SizedBox(width: 14),
                          const Text('VeloReel', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
                          const Spacer(),
                          if (widget.controller.busy)
                            const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      const Text(
                        '正在查找同一 Wi-Fi 下的桌面端',
                        style: TextStyle(color: kMuted, fontSize: 14),
                      ),
                      const SizedBox(height: 26),
                      Row(
                        children: [
                          const Text('发现的设备', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                          const Spacer(),
                          TextButton.icon(
                            onPressed: widget.controller.discovering
                                ? () => widget.controller.restartDiscovery()
                                : () => widget.controller.startDiscovery(),
                            icon: const Icon(Icons.refresh, size: 18),
                            label: const Text('重新搜索'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (devices.isEmpty)
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(28),
                          decoration: BoxDecoration(
                            color: kSurface,
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(color: kBorder),
                          ),
                          child: const Column(
                            children: [
                              Icon(Icons.wifi_find, color: kMuted, size: 34),
                              SizedBox(height: 12),
                              Text('还没有发现设备', style: TextStyle(color: kText, fontSize: 15)),
                              SizedBox(height: 6),
                              Text(
                                '确认桌面端已开启“局域网共享”，并和本机处在同一 Wi-Fi',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: kMuted, fontSize: 12),
                              ),
                            ],
                          ),
                        )
                      else
                        ...devices.map((device) => _DeviceCard(device: device, onTap: () => _connect(device.baseUrl))),
                      const SizedBox(height: 26),
                      const Text('手动连接', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _manualController,
                              keyboardType: TextInputType.url,
                              decoration: const InputDecoration(hintText: '例如 192.168.1.8:8790'),
                              onSubmitted: (value) => _connect(value),
                            ),
                          ),
                          const SizedBox(width: 12),
                          ElevatedButton(
                            onPressed: () => _connect(_manualController.text),
                            child: const Text('连接'),
                          ),
                        ],
                      ),
                      if (widget.controller.error != null) ...[
                        const SizedBox(height: 14),
                        Text(widget.controller.error!, style: const TextStyle(color: kDanger, fontSize: 12)),
                      ],
                      const SizedBox(height: 24),
                      const Text(
                        '无需配对，连接后即可浏览收藏、搜索并查看详情。',
                        style: TextStyle(color: kMuted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({required this.device, required this.onTap});

  final LanDevice device;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: kSurface,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            child: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: kSurfaceAlt,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(Icons.desktop_windows_outlined, color: kAccent),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(device.name, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Text(
                        '${device.host}:${device.port}  ·  v${device.appVersion}',
                        style: const TextStyle(color: kMuted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: kMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
