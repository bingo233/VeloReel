import 'package:flutter/material.dart';

import '../models.dart';
import '../state/app_controller.dart';
import '../theme.dart';
import 'detail_screen.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  @override
  void initState() {
    super.initState();
    widget.controller.refreshHistory();
  }

  Future<void> _open(HistoryItem item) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetailScreen(
          controller: widget.controller,
          item: item.toMediaItem(widget.controller.siteName(item.siteId)),
        ),
      ),
    );
    // 播放页退出后会写入新进度，返回时刷新列表
    await widget.controller.refreshHistory();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final history = widget.controller.history;
        return Padding(
          padding: const EdgeInsets.fromLTRB(28, 24, 28, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('观看历史', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
                  const SizedBox(width: 10),
                  Text('${history.length}', style: const TextStyle(color: kMuted, fontSize: 12)),
                  const Spacer(),
                  IconButton(
                    onPressed: widget.controller.historyLoading
                        ? null
                        : widget.controller.refreshHistory,
                    icon: const Icon(Icons.refresh),
                    tooltip: '刷新历史',
                  ),
                ],
              ),
              const SizedBox(height: 16),
              if (widget.controller.historyError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    widget.controller.historyError!,
                    style: const TextStyle(color: kDanger, fontSize: 12),
                  ),
                ),
              Expanded(
                child: history.isEmpty
                    ? Center(
                        child: widget.controller.historyLoading
                            ? const CircularProgressIndicator()
                            : const Text(
                                '还没有观看记录\n在手机上或桌面端播放后会自动同步到这里',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: kMuted, height: 1.6),
                              ),
                      )
                    : ListView.separated(
                        padding: const EdgeInsets.only(bottom: 20),
                        itemCount: history.length,
                        separatorBuilder: (context, index) => const SizedBox(height: 10),
                        itemBuilder: (context, index) => _historyCard(history[index]),
                      ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _historyCard(HistoryItem item) {
    final cover = widget.controller.imageUrl(item.coverUrl);
    final finished = item.progress >= 0.98;
    final siteLabel = widget.controller.siteName(item.siteId);
    final subtitle = <String>[
      if (siteLabel.isNotEmpty) siteLabel,
      if (item.lastEpisodeName.isNotEmpty) item.lastEpisodeName else '未记录集数',
    ].join(' · ');
    return Material(
      color: kSurface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _open(item),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: SizedBox(
                  width: 64,
                  height: 88,
                  child: cover.isEmpty
                      ? const ColoredBox(
                          color: kSurfaceAlt,
                          child: Icon(Icons.movie_outlined, color: kMuted, size: 22),
                        )
                      : Image.network(
                          cover,
                          fit: BoxFit.cover,
                          errorBuilder: (context, error, stackTrace) => const ColoredBox(
                            color: kSurfaceAlt,
                            child: Icon(Icons.movie_outlined, color: kMuted, size: 22),
                          ),
                        ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.title.isEmpty ? '未命名影片' : item.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: kMuted, fontSize: 12),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: LinearProgressIndicator(
                            value: item.progress,
                            minHeight: 3,
                            backgroundColor: kBorder,
                            color: kAccent,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Text(
                          finished ? '已看完' : '${(item.progress * 100).round()}%',
                          style: const TextStyle(color: kMuted, fontSize: 11),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _timeLabel(item.updatedAt),
                      style: const TextStyle(color: kMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: kMuted),
            ],
          ),
        ),
      ),
    );
  }

  String _timeLabel(int timestamp) {
    if (timestamp <= 0) {
      return '';
    }
    final time = DateTime.fromMillisecondsSinceEpoch(timestamp);
    final now = DateTime.now();
    final diff = now.difference(time);
    if (diff.inMinutes < 1) {
      return '刚刚观看';
    }
    if (diff.inMinutes < 60) {
      return '${diff.inMinutes} 分钟前观看';
    }
    if (diff.inHours < 24 && now.day == time.day) {
      return '今天 ${_two(time.hour)}:${_two(time.minute)} 观看';
    }
    if (diff.inDays < 7) {
      return '${diff.inDays} 天前观看';
    }
    return '${time.year}-${_two(time.month)}-${_two(time.day)} 观看';
  }

  String _two(int value) => value.toString().padLeft(2, '0');
}
