import 'package:flutter/material.dart';

import '../models.dart';
import '../state/app_controller.dart';
import '../theme.dart';
import 'player_screen.dart';

class DetailScreen extends StatefulWidget {
  const DetailScreen({super.key, required this.controller, required this.item});

  final AppController controller;
  final MediaItem item;

  @override
  State<DetailScreen> createState() => _DetailScreenState();
}

class _DetailScreenState extends State<DetailScreen> {
  late Future<VodDetail> _detailFuture = widget.controller.loadDetail(widget.item);
  int _groupIndex = 0;
  String? _resolvingUrl;
  Map<String, dynamic>? _history;
  bool _favoriteBusy = false;

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  void _reload() {
    setState(() {
      _detailFuture = widget.controller.loadDetail(widget.item);
      _groupIndex = 0;
    });
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    try {
      final history = await widget.controller.loadHistory(widget.item);
      if (!mounted) {
        return;
      }
      setState(() => _history = history);
    } catch (_) {
      if (!mounted) {
        return;
      }
      setState(() => _history = null);
    }
  }

  Future<void> _toggleFavorite() async {
    setState(() => _favoriteBusy = true);
    try {
      if (widget.controller.isFavorite(widget.item)) {
        await widget.controller.removeFavorite(widget.item);
        _showMessage('已取消收藏');
      } else {
        await widget.controller.addFavorite(widget.item);
        _showMessage('已收藏');
      }
    } catch (exception) {
      _showMessage(exception.toString());
    } finally {
      if (mounted) {
        setState(() => _favoriteBusy = false);
      }
    }
  }

  void _showMessage(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: kSurface,
        title: Text(widget.item.title),
        actions: [
          AnimatedBuilder(
            animation: widget.controller,
            builder: (context, _) {
              final favorite = widget.controller.isFavorite(widget.item);
              return IconButton(
                tooltip: favorite ? '取消收藏' : '收藏',
                onPressed: _favoriteBusy ? null : _toggleFavorite,
                icon: Icon(
                  favorite ? Icons.favorite : Icons.favorite_border,
                  color: favorite ? kAccent : kMuted,
                ),
              );
            },
          ),
        ],
      ),
      body: FutureBuilder<VodDetail>(
        future: _detailFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(snapshot.error.toString(), style: const TextStyle(color: kDanger)),
                  const SizedBox(height: 12),
                  OutlinedButton(onPressed: _reload, child: const Text('重试')),
                ],
              ),
            );
          }
          final detail = snapshot.data!;
          final groups = detail.playlistGroups;
          if (groups.isEmpty) {
            return const Center(child: Text('没有可用的播放列表', style: TextStyle(color: kMuted)));
          }
          final group = groups[_groupIndex.clamp(0, groups.length - 1)];
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(28, 24, 28, 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                LayoutBuilder(
                  builder: (context, constraints) {
                    final wide = constraints.maxWidth >= 700;
                    final info = _Info(detail: detail, item: widget.item);
                    final cover = widget.controller.imageUrl(detail.coverUrl);
                    if (!wide) {
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _Cover(url: cover),
                          const SizedBox(height: 18),
                          info,
                        ],
                      );
                    }
                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(width: 220, child: _Cover(url: cover)),
                        const SizedBox(width: 24),
                        Expanded(child: info),
                      ],
                    );
                  },
                ),
                if (_history != null) ...[
                  const SizedBox(height: 20),
                  _historyBanner(detail),
                ],
                const SizedBox(height: 24),
                if (groups.length > 1)
                  Wrap(
                    spacing: 8,
                    children: [
                      for (var i = 0; i < groups.length; i++)
                        ChoiceChip(
                          label: Text(groups[i].name.isEmpty ? '线路 ${i + 1}' : groups[i].name),
                          selected: i == _groupIndex,
                          onSelected: (_) => setState(() => _groupIndex = i),
                        ),
                    ],
                  ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final episode in group.episodes)
                      OutlinedButton(
                        onPressed: _resolvingUrl == null ? () => _play(detail, episode) : null,
                        child: _resolvingUrl == episode.url
                            ? const SizedBox(
                                width: 14,
                                height: 14,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : Text(episode.name.isEmpty ? '第 ${episode.index + 1} 集' : episode.name),
                      ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _play(VodDetail detail, Episode episode) async {
    if (episode.url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('该集没有可用的播放页地址')),
      );
      return;
    }
    setState(() => _resolvingUrl = episode.url);
    final siteId = detail.siteId.isEmpty ? widget.item.siteId : detail.siteId;
    try {
      final resolution = await widget.controller.resolveStream(
        siteId: siteId,
        playPageUrl: episode.url,
      );
      if (!mounted) {
        return;
      }
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => PlayerScreen(
            url: resolution.url,
            title: detail.title.isEmpty ? widget.item.title : detail.title,
            controller: widget.controller,
            siteId: siteId,
            detailUrl: widget.item.detailUrl,
            coverUrl: detail.coverUrl,
            episodeUrl: episode.url,
            episodeName: episode.name,
            initialPosition: _resumePosition(episode),
          ),
        ),
      );
      await _loadHistory();
    } catch (exception) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(exception.toString())),
      );
    } finally {
      if (mounted) {
        setState(() => _resolvingUrl = null);
      }
    }
  }

  /// 在同一集且未看完时返回上次的播放位置。
  Duration _resumePosition(Episode episode) {
    final history = _history;
    if (history == null) {
      return Duration.zero;
    }
    final lastUrl = history['lastEpisodeUrl'];
    final episodes = history['episodes'];
    if (lastUrl != episode.url || episodes is! Map) {
      return Duration.zero;
    }
    final entry = episodes[episode.url];
    if (entry is! Map || entry['isFinished'] == true) {
      return Duration.zero;
    }
    final current = entry['currentTime'];
    if (current is! num || current <= 0) {
      return Duration.zero;
    }
    return Duration(milliseconds: (current * 1000).round());
  }

  Episode? _lastEpisode(VodDetail detail) {
    final lastUrl = _history?['lastEpisodeUrl'];
    if (lastUrl is! String || lastUrl.isEmpty) {
      return null;
    }
    for (final group in detail.playlistGroups) {
      for (final episode in group.episodes) {
        if (episode.url == lastUrl) {
          return episode;
        }
      }
    }
    return null;
  }

  Widget _historyBanner(VodDetail detail) {
    final history = _history!;
    final name = history['lastEpisodeName'];
    final label = name is String && name.isNotEmpty ? name : '上次播放';
    final episode = _lastEpisode(detail);
    final duration = history['lastDuration'];
    final current = history['lastCurrentTime'];
    final percent = duration is num && duration > 0 && current is num
        ? (current / duration).clamp(0.0, 1.0)
        : null;
    return Material(
      color: kSurfaceAlt,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: episode == null ? null : () => _play(detail, episode),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              const Icon(Icons.history, size: 18, color: kAccent),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '继续观看 · $label',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                    if (percent != null) ...[
                      const SizedBox(height: 6),
                      LinearProgressIndicator(
                        value: percent,
                        minHeight: 3,
                        backgroundColor: kBorder,
                        color: kAccent,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '已观看 ${(percent * 100).round()}%',
                        style: const TextStyle(color: kMuted, fontSize: 11),
                      ),
                    ],
                  ],
                ),
              ),
              const Icon(Icons.play_arrow_rounded, color: kAccent),
            ],
          ),
        ),
      ),
    );
  }
}

class _Info extends StatelessWidget {
  const _Info({required this.detail, required this.item});

  final VodDetail detail;
  final MediaItem item;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(detail.title.isEmpty ? item.title : detail.title, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Text(detail.siteId.isEmpty ? item.siteName : detail.siteId, style: const TextStyle(color: kMuted, fontSize: 12)),
        const SizedBox(height: 16),
        Text(
          detail.description.isEmpty ? '暂无简介' : detail.description,
          style: const TextStyle(color: kMuted, fontSize: 13, height: 1.6),
        ),
      ],
    );
  }
}

class _Cover extends StatelessWidget {
  const _Cover({required this.url});

  final String url;

  @override
  Widget build(BuildContext context) {
    final placeholder = Container(
      color: kSurfaceAlt,
      height: 300,
      child: const Center(child: Icon(Icons.movie_outlined, color: kMuted, size: 36)),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        height: 300,
        width: double.infinity,
        child: url.isEmpty
            ? placeholder
            : Image.network(
                url,
                fit: BoxFit.cover,
                errorBuilder: (context, error, stackTrace) => placeholder,
              ),
      ),
    );
  }
}
